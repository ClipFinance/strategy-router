//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/AutomationCompatible.sol";

import "./deps/Initializable.sol";
import "./deps/UUPSUpgradeable.sol";
import "./deps/OwnableUpgradeable.sol";

import {TokenPrice} from "./lib/Structs.sol";
import {fromUniform, MAX_BPS} from "./lib/Math.sol";

import "./interfaces/IExchange.sol";
import "./interfaces/IReceiptNFT.sol";
import "./interfaces/IStrategyRouter.sol";
import "./interfaces/ISharesToken.sol";
import "./interfaces/IRouterAdmin.sol";
import "./interfaces/IUsdOracle.sol";

contract BatchOut is Initializable, UUPSUpgradeable, OwnableUpgradeable, AutomationCompatibleInterface {
    using SafeERC20 for IERC20;

    struct userWithdrawalData {
        address user;
        withdrawalData shareData;
        bool withdrawStatus;
    }
    struct cycleData {
        uint256 startAt;
        uint256 pendingShareWithdraw;
        uint256 withdrawRequests;
        uint256 withdrawRequestsFullFilled;
        withdrawalData tokensWithdrawn;
        withdrawalData shareWithdrawRequest;
    }

    struct withdrawalData {
        address[] token;
        uint256[] sharesOrUnits;
    }

    struct WithdrawFeeSettings {
        uint256 minFeeInUsd; // Amount of USD, must be `UNIFORM_DECIMALS` decimals
        uint256 maxFeeInUsd; // Amount of USD, must be `UNIFORM_DECIMALS` decimals
        uint256 feeInBps; // Percentage of deposit fee, in basis points
    }

    // cycleID ->
    mapping(uint256 => address[]) public cycleWithdrawAddresses;
    mapping(uint256 => mapping(address => userWithdrawalData)) public userWithdrawStorage;
    mapping(uint256 => cycleData) public cycleInfo;

    IReceiptNFT public receiptContract;
    IExchange public exchange;
    IStrategyRouter public router;
    ISharesToken public sharesToken;
    IRouterAdmin private admin;
    IUsdOracle public oracle;

    address public moderator;

    // Indicating how many second after currentCycleId.startAt will the withdraw automation run
    uint256 public withdrawWindowTime;

    uint256 public maxSlippageToWithdrawInBps;

    uint256 public currentCycleId;
    uint256[] notFulfilledCycleIds;

    WithdrawFeeSettings public withdrawFeeSettings;

    uint256 private constant WITHDRAW_FEE_AMOUNT_THRESHOLD = 50e18; // 50 USD
    uint256 private constant WITHDRAW_FEE_PERCENT_THRESHOLD = 300; // 3% in basis points

    uint256 private constant MAX_SLIPPAGE_TO_WITHDRAW_IN_BPS = 1000;

    modifier onlyModerator() {
        if (moderator != msg.sender) revert NotModerator();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        __Ownable_init();
        moderator = tx.origin;
        withdrawWindowTime = 1 hours;

        // transer ownership and set proxi admin to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);
        _changeAdmin(tx.origin);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function scheduleWithdrawal(
        address withdrawTo,
        address withdrawToken,
        uint256[] calldata receiptIds,
        uint256 shares
    ) external payable {
        if (router.supportsToken(withdrawToken) != true) {
            revert UnsupportedToken();
        }
        if (shares == 0) revert AmountNotSpecified();

        for (uint256 i = 0; i < receiptIds.length; i++) {
            if (receiptContract.ownerOf(receiptIds[i]) != msg.sender) revert NotReceiptOwner();
        }

        uint256 withdrawFeeAmount = getWithdrawFeeInBNB(router.calculateSharesUsdValue(shares));
        if (msg.value < withdrawFeeAmount) {
            revert WithdrawUnderDepositFeeValue();
        }

        // If receiptIds is not empty, redeem them to shares
        if (receiptIds.length > 0) admin.redeemReceiptsToSharesByModerators(receiptIds);

        // Check if the user has enough shares
        if (shares > sharesToken.balanceOf(msg.sender)) revert InsufficientShares();
        // Transfer shares from user to this contract
        sharesToken.transferFromAutoApproved(msg.sender, address(this), shares);

        // Updating cycle meta-info
        cycleData storage currentCycleInfo = cycleInfo[currentCycleId];
        if (currentCycleInfo.startAt == 0) currentCycleInfo.startAt = block.timestamp;

        currentCycleInfo.pendingShareWithdraw += shares;

        userWithdrawalData storage userCycleData = userWithdrawStorage[currentCycleId][withdrawTo];

        // Check if the user has made a request in this cycle before
        bool isNewRequest = userCycleData.user == address(0);
        if (isNewRequest) {
            currentCycleInfo.withdrawRequests += 1;
            userCycleData.user = withdrawTo;
            cycleWithdrawAddresses[currentCycleId].push(withdrawTo);
        }

        // Check if token exists in user's withdrawal request for the cycle
        int256 tokenIndex = -1;
        for (uint256 i = 0; i < userCycleData.shareData.token.length; i++) {
            if (userCycleData.shareData.token[i] == withdrawToken) {
                tokenIndex = int256(i);
                break;
            }
        }

        // If token exists in user's withdrawal request, update the shares
        // Else, add new token and shares to the arrays
        if (tokenIndex != -1) {
            userCycleData.shareData.sharesOrUnits[uint256(tokenIndex)] += shares;
        } else {
            userCycleData.shareData.token.push(withdrawToken);
            userCycleData.shareData.sharesOrUnits.push(shares);
        }

        // Update cycleWithdrawalData for the current cycle
        int256 cycleTokenIndex = -1;
        for (uint256 i = 0; i < currentCycleInfo.shareWithdrawRequest.token.length; i++) {
            if (currentCycleInfo.shareWithdrawRequest.token[i] == withdrawToken) {
                cycleTokenIndex = int256(i);
                break;
            }
        }
        if (cycleTokenIndex != -1) {
            currentCycleInfo.shareWithdrawRequest.sharesOrUnits[uint256(cycleTokenIndex)] += shares;
        } else {
            currentCycleInfo.shareWithdrawRequest.token.push(withdrawToken);
            currentCycleInfo.shareWithdrawRequest.sharesOrUnits.push(shares);
        }
    }

    function executeBatchWithdrawFromStrategyWithSwap() public {
        cycleData storage currentCycle = cycleInfo[currentCycleId];

        if (currentCycle.pendingShareWithdraw == 0) revert CycleNotClosableYet();

        // Step 1: Capture starting balances
        address[] memory tokensInCycle = currentCycle.shareWithdrawRequest.token;
        uint256[] memory startingBalances = new uint256[](tokensInCycle.length);
        for (uint256 i = 0; i < tokensInCycle.length; i++) {
            startingBalances[i] = IERC20(tokensInCycle[i]).balanceOf(address(this));
        }

        // Find the token with the most shares
        uint256 maxShares;
        address withdrawToken;
        for (uint256 i = 0; i < currentCycle.shareWithdrawRequest.token.length; i++) {
            if (currentCycle.shareWithdrawRequest.sharesOrUnits[i] > maxShares) {
                maxShares = currentCycle.shareWithdrawRequest.sharesOrUnits[i];
                withdrawToken = currentCycle.shareWithdrawRequest.token[i];
            }
        }

        uint256[] memory receiptIds = new uint256[](0);
        uint256 shares = currentCycle.pendingShareWithdraw;
        uint256 minTokenAmountToWithdraw = router.calculateSharesUsdValue(shares);
        (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(withdrawToken);
        minTokenAmountToWithdraw = (minTokenAmountToWithdraw * 10 ** oraclePriceDecimals) / tokenUsdPrice;
        minTokenAmountToWithdraw = (minTokenAmountToWithdraw * (MAX_BPS - maxSlippageToWithdrawInBps)) / MAX_BPS;
        // adjust decimals of the token amount
        minTokenAmountToWithdraw = fromUniform(minTokenAmountToWithdraw, withdrawToken);

        router.withdrawFromStrategies(receiptIds, withdrawToken, shares, minTokenAmountToWithdraw, true);

        TokenPrice memory usdPriceWithdrawToken = TokenPrice({
            price: tokenUsdPrice,
            priceDecimals: oraclePriceDecimals,
            token: withdrawToken
        });

        for (uint256 i = 0; i < currentCycle.shareWithdrawRequest.token.length; i++) {
            address currentToken = currentCycle.shareWithdrawRequest.token[i];
            uint256 tokenShares = currentCycle.shareWithdrawRequest.sharesOrUnits[i];

            if (tokenShares == 0 || currentToken == withdrawToken) continue;

            // Calculate the ideal USD value of the shares
            uint256 idealUsdValue = router.calculateSharesUsdValue(tokenShares);
            uint256 amountToSwap = (idealUsdValue * 10 ** oraclePriceDecimals) / tokenUsdPrice;
            // adjust decimals of the token amount
            amountToSwap = fromUniform(amountToSwap, withdrawToken);
            IERC20(withdrawToken).safeTransfer(address(exchange), amountToSwap);

            (uint256 currentTokenUsdPrice, uint8 currentTokenOraclePriceDecimals) = oracle.getTokenUsdPrice(
                currentToken
            );

            exchange.stablecoinSwap(
                amountToSwap,
                withdrawToken,
                currentToken,
                address(this),
                usdPriceWithdrawToken,
                TokenPrice({
                    price: currentTokenUsdPrice,
                    priceDecimals: currentTokenOraclePriceDecimals,
                    token: currentToken
                })
            );
        }

        // Step 2: Capture ending balances and compute differences
        for (uint256 i = 0; i < tokensInCycle.length; i++) {
            uint256 endingBalance = IERC20(tokensInCycle[i]).balanceOf(address(this));
            uint256 netChange = endingBalance - startingBalances[i];

            if (netChange > 0) {
                // Only record if there's a positive change
                _updateTokensWithdrawn(currentCycleId, tokensInCycle[i], netChange);
            }
        }

        // Set pendingShareWithdraw to 0
        currentCycle.pendingShareWithdraw = 0;

        // Add currentCycleId to notFulfilledCycleIds
        notFulfilledCycleIds.push(currentCycleId);

        // Increment currentCycleId
        currentCycleId++;
    }

    function _updateTokensWithdrawn(uint256 cycleId, address token, uint256 amount) internal {
        cycleData storage currentCycle = cycleInfo[cycleId];
        bool tokenExists = false;

        for (uint256 i = 0; i < currentCycle.tokensWithdrawn.token.length; i++) {
            if (currentCycle.tokensWithdrawn.token[i] == token) {
                currentCycle.tokensWithdrawn.sharesOrUnits[i] += amount;
                tokenExists = true;
                break;
            }
        }

        if (!tokenExists) {
            currentCycle.tokensWithdrawn.token.push(token);
            currentCycle.tokensWithdrawn.sharesOrUnits.push(amount);
        }
    }

    function getNotFulfilledCycleIds() external view returns (uint256[] memory) {
        return notFulfilledCycleIds;
    }

    // @notice Get a withdraw fee amount in tokens.
    // @param amountInUsd Amount USD with `UNIFORM_DECIMALS`.
    // @dev Returns a withdraw fee amount in BNB.
    function getWithdrawFeeInBNB(uint256 amountInUsd) public view returns (uint256 feeAmountInBNB) {
        uint256 feeAmountInUsd = calculateWithdrawFee(amountInUsd);

        // Now, find out the value of BNB in USD.
        (uint256 bnbUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(
            0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
        );

        // Convert the fee in USD to BNB.
        feeAmountInBNB = (feeAmountInUsd * (10 ** oraclePriceDecimals)) / bnbUsdPrice;
    }

    /// @notice calculate withdraw fee in USD.
    /// @param amountInUsd Amount USD with `UNIFORM_DECIMALS`.
    /// @dev returns fee amount of tokens in USD.
    function calculateWithdrawFee(uint256 amountInUsd) public view returns (uint256 feeAmountInUsd) {
        WithdrawFeeSettings memory _withdrawFeeSettings = withdrawFeeSettings;

        feeAmountInUsd = (amountInUsd * _withdrawFeeSettings.feeInBps) / MAX_BPS;

        // check ranges and apply needed fee limits
        if (feeAmountInUsd < _withdrawFeeSettings.minFeeInUsd) feeAmountInUsd = _withdrawFeeSettings.minFeeInUsd;
        else if (feeAmountInUsd > _withdrawFeeSettings.maxFeeInUsd) feeAmountInUsd = _withdrawFeeSettings.maxFeeInUsd;
    }

    function collectWithdrawFee() external onlyModerator {
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "Transfer failed");
    }

    function withdrawFulfill(uint256 cycleID) public {
        cycleData memory currentCycle = cycleInfo[cycleID];
        if (currentCycle.withdrawRequestsFullFilled == currentCycle.withdrawRequests) revert AllWithdrawalsFulfilled();

        uint256 end = cycleWithdrawAddresses[cycleID].length;
        if (end > currentCycle.withdrawRequests) {
            end = currentCycle.withdrawRequests;
        }
        for (uint256 i = currentCycle.withdrawRequestsFullFilled; i < end; i++) {
            address userAddress = cycleWithdrawAddresses[cycleID][i];
            userWithdrawalData memory userCycleData = userWithdrawStorage[cycleID][userAddress];

            // If user has already withdrawn, skip
            if (userCycleData.withdrawStatus) {
                continue;
            }

            for (uint256 j; j < userCycleData.shareData.token.length; j++) {
                address token = userCycleData.shareData.token[j];
                uint256 userShares = userCycleData.shareData.sharesOrUnits[j];

                // Find the respective token in the cycle's tokensWithdrawn
                int256 withdrawnTokenIndex = -1;
                for (uint256 l; l < currentCycle.tokensWithdrawn.token.length; l++) {
                    if (currentCycle.tokensWithdrawn.token[l] == token) {
                        withdrawnTokenIndex = int256(l);
                        break;
                    }
                }

                // If the token doesn't exist in the cycle data, skip
                if (withdrawnTokenIndex == -1) continue;

                // Find total shares requested for this token in the cycle
                int256 cycleSharesIndex = -1;
                for (uint256 m; m < currentCycle.shareWithdrawRequest.token.length; m++) {
                    if (currentCycle.shareWithdrawRequest.token[m] == token) {
                        cycleSharesIndex = int256(m);
                        break;
                    }
                }

                if (cycleSharesIndex == -1) continue;

                uint256 totalTokenSharesForCycle = currentCycle.shareWithdrawRequest.sharesOrUnits[
                    uint256(cycleSharesIndex)
                ];
                uint256 totalTokenAmountWithdrawn = currentCycle.tokensWithdrawn.sharesOrUnits[
                    uint256(withdrawnTokenIndex)
                ];

                uint256 userAmount = (userShares * totalTokenAmountWithdrawn) / totalTokenSharesForCycle;

                IERC20(token).safeTransfer(userAddress, userAmount);
            }
            userWithdrawStorage[cycleID][userAddress].withdrawStatus = true;
        }

        cycleInfo[cycleID].withdrawRequestsFullFilled = end;

        // remove fulfilled cycle from notFulfilledCycleIds
        if (end == currentCycle.withdrawRequests) {
            for (uint256 i = 0; i < notFulfilledCycleIds.length; i++) {
                if (notFulfilledCycleIds[i] == cycleID) {
                    // swap with last element and pop array to remove fulfilled cycle
                    uint256 lastCycleIdIndex = notFulfilledCycleIds.length - 1;
                    uint256 lastCycleId = notFulfilledCycleIds[lastCycleIdIndex];
                    notFulfilledCycleIds[i] = lastCycleId;
                    notFulfilledCycleIds.pop();
                    break;
                }
            }
        }
    }

    function withdrawAndDistribute() external {
        executeBatchWithdrawFromStrategyWithSwap();
        // should be subtracted by 1 because currentCycleId is already incremented by above function
        withdrawFulfill(currentCycleId - 1);
    }

    /// @notice Checks weather upkeep method is ready to be called.
    /// Method is compatible with AutomationCompatibleInterface from ChainLink smart contracts
    /// @return upkeepNeeded Returns weither upkeep method needs to be executed
    /// @dev Automation function
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory) {
        // check if there is any cycle to be fulfilled
        if (notFulfilledCycleIds.length > 0) {
            upkeepNeeded = true;
        } else {
            // if there is no cycle to be fulfilled, check the current cycle
            uint256 firstWithdrawRequestAt = cycleInfo[currentCycleId].startAt;

            // check if the first cycle is ready to be fulfilled
            upkeepNeeded = firstWithdrawRequestAt > 0 && firstWithdrawRequestAt + withdrawWindowTime < block.timestamp;
        }
    }

    /// @notice Execute upkeep routine that proxies to withdrawFulfill or withdrawAndDistribute
    /// Method is compatible with AutomationCompatibleInterface from ChainLink smart contracts
    /// @dev Automation function
    function performUpkeep(bytes calldata) external override {
        // check notFulfilledCycleIds first
        if (notFulfilledCycleIds.length > 0) {
            withdrawFulfill(notFulfilledCycleIds[0]);
        } else {
            this.withdrawAndDistribute();
        }
    }

    function setAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        IStrategyRouter _router,
        IReceiptNFT _receiptNft,
        ISharesToken _sharesToken,
        IRouterAdmin _admin
    ) external onlyModerator {
        exchange = _exchange;
        oracle = _oracle;
        router = _router;
        receiptContract = _receiptNft;
        sharesToken = _sharesToken;
        admin = _admin;
        emit SetAddresses(_exchange, _oracle, _router, _receiptNft, _sharesToken, _admin);
    }

    function setWithdrawWindowTime(uint256 timeInSeconds) external onlyModerator {
        withdrawWindowTime = timeInSeconds;
    }

    function setModerator(address _moderator) external onlyModerator {
        if (_moderator == address(0)) revert InvalidModeratorAddress();
        moderator = _moderator;
    }

    /// @notice Set withdraw fee settings in the batch.
    /// @param _withdrawFeeSettings Deposit settings.
    /// @dev Owner function.
    function setWithdrawFeeSettings(WithdrawFeeSettings calldata _withdrawFeeSettings) external onlyModerator {
        // Ensure that maxFeeInUsd is not greater than the threshold of 50 USD
        if (_withdrawFeeSettings.maxFeeInUsd > WITHDRAW_FEE_AMOUNT_THRESHOLD) {
            revert MaxWithdrawFeeExceedsThreshold();
        }

        // Ensure that feeInBps is not greater than the threshold of 300 bps (3%)
        if (_withdrawFeeSettings.feeInBps > WITHDRAW_FEE_PERCENT_THRESHOLD) {
            revert WithdrawFeePercentExceedsFeePercentageThreshold();
        }

        // Ensure that minFeeInUsd is not greater than maxFeeInUsd
        if (_withdrawFeeSettings.maxFeeInUsd < _withdrawFeeSettings.minFeeInUsd) revert MinWithdrawFeeExceedsMax();

        // Ensure that maxFeeInUsd also has a value if feeInBps is set
        if (_withdrawFeeSettings.maxFeeInUsd == 0 && _withdrawFeeSettings.feeInBps != 0) {
            revert NotSetMaxFeeInUsdWhenFeeInBpsIsSet();
        }

        withdrawFeeSettings = _withdrawFeeSettings;

        emit SetDepositFeeSettings(_withdrawFeeSettings);
    }

    function setMaxSlippageToWithdrawInBps(uint256 newMaxSlippage) external onlyModerator {
        if (newMaxSlippage > MAX_SLIPPAGE_TO_WITHDRAW_IN_BPS) revert NewValueIsAboveMaxBps();
        maxSlippageToWithdrawInBps = newMaxSlippage;
    }

    /* ERRORS */
    error NotModerator();
    error InvalidModeratorAddress();
    error NotReceiptOwner();
    error AmountNotSpecified();
    error InsufficientShares();
    error UnsupportedToken();
    error CycleNotClosableYet();
    error AllWithdrawalsFulfilled();
    error MaxWithdrawFeeExceedsThreshold();
    error MinWithdrawFeeExceedsMax();
    error WithdrawFeePercentExceedsFeePercentageThreshold();
    error NotSetMaxFeeInUsdWhenFeeInBpsIsSet();
    error WithdrawUnderDepositFeeValue();
    error NewValueIsAboveMaxBps();

    /* EVENTS */
    event SetAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        IStrategyRouter _router,
        IReceiptNFT _receiptNft,
        ISharesToken _sharesToken,
        IRouterAdmin _admin
    );
    event SetDepositFeeSettings(WithdrawFeeSettings withdrawFeeSettings);
}
