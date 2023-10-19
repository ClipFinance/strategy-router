pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/AutomationCompatible.sol";
import "./deps/Initializable.sol";
import "./deps/UUPSUpgradeable.sol";

import {TokenPrice, StrategyInfo, IdleStrategyInfo, ReceiptData, Cycle} from "./lib/Structs.sol";
import {fromUniform, changeDecimals, UNIFORM_DECIMALS} from "./lib/Math.sol";
import "./StrategyRouterLib.sol";

import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import "./interfaces/IExchange.sol";
import "./interfaces/IReceiptNFT.sol";
import "./interfaces/ISharesToken.sol";
import "./interfaces/IBatch.sol";

/// @custom:oz-upgrades-unsafe-allow external-library-linking
contract StrategyRouter is Initializable, UUPSUpgradeable, AutomationCompatibleInterface {
    using SafeERC20 for IERC20;

    uint256 private constant PRECISION = 1e18;
    uint256 private constant MAX_FEE_PERCENT = 2000;
    uint256 private constant FEE_PERCENT_PRECISION = 100;
    /// @notice Protocol comission in percents taken from yield. One percent is 100.
    uint256 internal constant feePercent = 1200;
    // we do not try to withdraw amount below this threshold
    // cause gas spending are high compared to this amount
    uint256 private constant WITHDRAWAL_DUST_THRESHOLD_USD = 1e17; // 10 cents / 0.1 USD

    /// @notice The time of the first deposit that triggered a current cycle
    uint256 internal currentCycleFirstDepositAt;
    /// @notice Current cycle duration in seconds, until funds are allocated from batch to strategies
    uint256 internal allocationWindowTime;
    /// @notice Current cycle counter. Incremented at the end of the cycle
    uint256 internal currentCycleId;
    /// @notice Current cycle deposits counter. Incremented on deposit and decremented on withdrawal.
    uint256 internal currentCycleDepositsCount;

    IReceiptNFT private receiptContract;
    IExchange internal exchange;
    IUsdOracle private oracle;
    ISharesToken private sharesToken;
    IBatch internal batch;
    address internal moderator;

    StrategyInfo[] internal strategies;
    uint256 internal allStrategiesWeightSum;

    IdleStrategyInfo[] internal idleStrategies;

    mapping(uint256 => Cycle) internal cycles;
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
        __UUPSUpgradeable_init();
        moderator = tx.origin;
        cycles[0].startAt = block.timestamp;
        allocationWindowTime = 1 hours;
    }

    function setAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        ISharesToken _sharesToken,
        IBatch _batch,
        IReceiptNFT _receiptNft
    ) external onlyModerator {
        exchange = _exchange;
        oracle = _oracle;
        sharesToken = _sharesToken;
        batch = _batch;
        receiptContract = _receiptNft;
        emit SetAddresses(_exchange, _oracle, _sharesToken, _batch, _receiptNft);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyModerator {}

    // Universal Functions

    /// @notice Send pending money collected in the batch into the strategies.
    /// @notice Can be called when `allocationWindowTime` seconds has been passed or
    ///         batch usd value is more than zero.
    function allocateToStrategies() external {
        /*
        step 1 - preparing data and assigning local variables for later reference
        step 2 - check requirements to launch a cycle
            condition #1: deposit in the current cycle is greater than zero
        step 3 - store USD price of supported tokens as cycle information
        step 4 - collect yield and re-deposit/re-stake depending on strategy
        step 5 - rebalance token in batch to match our desired strategies ratio
        step 6 - batch transfers funds to strategies and strategies deposit tokens to their respective farms
        step 7 - we calculate share price for the current cycle and calculate a new amount of shares to issue

            Description:

                step 7.1 - Get previous TVL from previous cycle and calculate compounded profit: current TVL
                           minus previous cycle TVL. if current cycle = 0, then TVL = 0
                step 7.2 - Save corrected current TVL in Cycle[strategiesBalanceWithCompoundAndBatchDepositsInUsd] for the next cycle
                step 7.3 - Calculate price per share
                step 7.4 - Mint shares for the new protocol's deposits
                step 7.5 - Mint CLT for Clip's treasure address. CLT amount = fee / price per share

            Case example:

                Previous cycle strategies TVL = 1000 USD and total shares count is 1000 CLT
                Compound yield is 10 USD, hence protocol commission (protocolCommissionInUsd) is 10 USD * 20% = 2 USD
                TLV after compound is 1010 USD. TVL excluding platform's commission is 1008 USD

                Hence protocol commission in shares (protocolCommissionInShares) will be

                (1010 USD * 1000 CLT / (1010 USD - 2 USD)) - 1000 CLT = 1.98412698 CLT

        step 8 - Calculate protocol's commission and withhold commission by issuing share tokens
        step 9 - store remaining information for the current cycle
        */

        // step 1
        TokenPrice[] memory supportedTokenPrices = batch.getSupportedTokensWithPriceInUsd();

        (uint256 batchValueInUsd, ) = batch.getBatchValueUsdWithoutOracleCalls(supportedTokenPrices);

        uint256 _currentCycleId = currentCycleId;

        // step 2
        if (batchValueInUsd == 0) revert CycleNotClosableYet();

        currentCycleFirstDepositAt = 0;

        // step 3
        {
            for (uint256 i = 0; i < supportedTokenPrices.length; i++) {
                if (IERC20(supportedTokenPrices[i].token).balanceOf(address(batch)) > 0) {
                    cycles[_currentCycleId].prices[supportedTokenPrices[i].token] = changeDecimals(
                        supportedTokenPrices[i].price,
                        supportedTokenPrices[i].priceDecimals,
                        UNIFORM_DECIMALS
                    );
                }
            }
        }

        // step 4
        uint256 strategiesLength = strategies.length;
        for (uint256 i; i < strategiesLength; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }
        uint256 totalShares = sharesToken.totalSupply();
        (uint256 strategiesBalanceAfterCompoundInUsd, , , , ) = StrategyRouterLib.getStrategiesValueWithoutOracleCalls(
            strategies,
            idleStrategies,
            supportedTokenPrices
        );

        emit AfterCompound(_currentCycleId, strategiesBalanceAfterCompoundInUsd, totalShares);

        // step 5 and step 6
        batch.rebalance(supportedTokenPrices, strategies, allStrategiesWeightSum, idleStrategies);

        // step 7
        (uint256 strategiesBalanceAfterDepositInUsd, , , , ) = StrategyRouterLib.getStrategiesValueWithoutOracleCalls(
            strategies,
            idleStrategies,
            supportedTokenPrices
        );

        uint256 receivedByStrategiesInUsd = strategiesBalanceAfterDepositInUsd - strategiesBalanceAfterCompoundInUsd;

        if (totalShares == 0) {
            sharesToken.mint(address(this), receivedByStrategiesInUsd);
            cycles[_currentCycleId]
                .strategiesBalanceWithCompoundAndBatchDepositsInUsd = strategiesBalanceAfterDepositInUsd;
            cycles[_currentCycleId].pricePerShare =
                (strategiesBalanceAfterDepositInUsd * PRECISION) /
                sharesToken.totalSupply();
        } else {
            // step 7.1
            uint256 protocolCommissionInUsd = 0;
            if (
                strategiesBalanceAfterCompoundInUsd >
                cycles[_currentCycleId - 1].strategiesBalanceWithCompoundAndBatchDepositsInUsd
            ) {
                protocolCommissionInUsd =
                    ((strategiesBalanceAfterCompoundInUsd -
                        cycles[_currentCycleId - 1].strategiesBalanceWithCompoundAndBatchDepositsInUsd) * feePercent) /
                    (100 * FEE_PERCENT_PRECISION);
            }

            // step 7.2
            cycles[_currentCycleId]
                .strategiesBalanceWithCompoundAndBatchDepositsInUsd = strategiesBalanceAfterDepositInUsd;
            // step 7.3
            cycles[_currentCycleId].pricePerShare =
                ((strategiesBalanceAfterCompoundInUsd - protocolCommissionInUsd) * PRECISION) /
                totalShares;

            // step 7.4
            uint256 newShares = (receivedByStrategiesInUsd * PRECISION) / cycles[_currentCycleId].pricePerShare;
            sharesToken.mint(address(this), newShares);

            // step 7.5
            uint256 protocolCommissionInShares = (protocolCommissionInUsd * PRECISION) /
                cycles[_currentCycleId].pricePerShare;
            sharesToken.mint(moderator, protocolCommissionInShares);
        }

        // step 8
        cycles[_currentCycleId].receivedByStrategiesInUsd = receivedByStrategiesInUsd;
        cycles[_currentCycleId].totalDepositedInUsd = batchValueInUsd;

        emit AllocateToStrategies(_currentCycleId, receivedByStrategiesInUsd);

        // step 9
        ++currentCycleId;
        currentCycleDepositsCount = 0;
        cycles[_currentCycleId].startAt = block.timestamp;
    }

    /// @notice Harvest yield from farms, and reinvest these rewards into strategies.
    /// @notice Part of the harvested rewards is taken as protocol comission.
    function compoundAll() public {
        if (sharesToken.totalSupply() == 0) revert();

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }

        (uint256 balanceAfterCompoundInUsd, , , , ) = getStrategiesValue();
        uint256 totalShares = sharesToken.totalSupply();
        emit AfterCompound(currentCycleId, balanceAfterCompoundInUsd, totalShares);
    }

    /// @dev Returns list of supported tokens.
    function getSupportedTokens() public view returns (address[] memory) {
        return batch.getSupportedTokens();
    }

    /// @dev Returns strategy weight as percent of total weight.
    function getStrategyPercentWeight(uint256 _strategyId) public view returns (uint256 strategyPercentAllocation) {
        strategyPercentAllocation = (strategies[_strategyId].weight * PRECISION) / allStrategiesWeightSum;
    }

    /// @notice Returns count of strategies.
    function getStrategiesCount() public view returns (uint256 count) {
        return strategies.length;
    }

    /// @notice Returns array of strategies.
    function getStrategies() public view returns (StrategyInfo[] memory, uint256) {
        return (strategies, allStrategiesWeightSum);
    }

    /// @notice Returns array of idle strategies.
    function getIdleStrategies() public view returns (IdleStrategyInfo[] memory) {
        return idleStrategies;
    }

    /// @notice Returns deposit token of the strategy.
    function getStrategyDepositToken(uint256 i) public view returns (address) {
        return strategies[i].depositToken;
    }

    function getBatchValueUsd() public view returns (uint256 totalBalance, uint256[] memory balances) {
        return batch.getBatchValueUsd();
    }

    /// @notice Returns usd value of the token balances and their sum in the strategies.
    /// @notice All returned amounts have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total usd value.
    /// @return totalStrategyBalance Total usd active strategy tvl.
    /// @return totalIdleStrategyBalance Total usd idle strategy tvl.
    /// @return balances Array of usd value of strategy token balances.
    /// @return idleBalances Array of usd value of idle strategy token balances.
    function getStrategiesValue()
        public
        view
        returns (
            uint256 totalBalance,
            uint256 totalStrategyBalance,
            uint256 totalIdleStrategyBalance,
            uint256[] memory balances,
            uint256[] memory idleBalances
        )
    {
        (totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances, idleBalances) = StrategyRouterLib
            .getStrategiesValue(batch, strategies, idleStrategies);
    }

    /// @notice Returns stored address of the exchange address in `IExchange` interface.
    function getExchange() public view returns (IExchange) {
        return exchange;
    }

    /// @notice Calculates amount of redeemable shares by burning receipts.
    /// @notice Cycle noted in receipts should be closed.
    function calculateSharesFromReceipts(uint256[] calldata receiptIds) public view returns (uint256 shares) {
        IReceiptNFT _receiptContract = receiptContract;
        uint256 _currentCycleId = currentCycleId;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            shares += StrategyRouterLib.calculateSharesFromReceipt(
                receiptId,
                _currentCycleId,
                _receiptContract,
                cycles
            );
        }
    }

    /// @notice Reedem shares for receipts on behalf of their owners.
    /// @notice Cycle noted in receipts should be closed.
    /// @notice Only callable by moderators.
    function redeemReceiptsToSharesByModerators(uint256[] calldata receiptIds) public onlyModerator {
        StrategyRouterLib.redeemReceiptsToSharesByModerators(
            receiptIds,
            currentCycleId,
            receiptContract,
            sharesToken,
            cycles
        );
        emit RedeemReceiptsToSharesByModerators(msg.sender, receiptIds);
    }

    /// @notice Calculate current usd value of shares.
    /// @dev Returned amount has `UNIFORM_DECIMALS` decimals.
    function calculateSharesUsdValue(uint256 amountShares) public view returns (uint256 amountUsd) {
        uint256 totalShares = sharesToken.totalSupply();
        if (amountShares > totalShares) revert AmountExceedTotalSupply();
        (uint256 strategiesLockedUsd, , , , ) = getStrategiesValue();

        uint256 currentPricePerShare = (strategiesLockedUsd * PRECISION) / totalShares;

        return (amountShares * currentPricePerShare) / PRECISION;
    }

    /// @notice Calculate shares amount from usd value.
    /// @dev Returned amount has `UNIFORM_DECIMALS` decimals.
    function calculateSharesAmountFromUsdAmount(uint256 amount) public view returns (uint256 shares) {
        (uint256 strategiesLockedUsd, , , , ) = getStrategiesValue();
        uint256 currentPricePerShare = (strategiesLockedUsd * PRECISION) / sharesToken.totalSupply();
        shares = (amount * PRECISION) / currentPricePerShare;
    }

    /// @notice Returns whether this token is supported.
    /// @param tokenAddress Token address to lookup.
    function supportsToken(address tokenAddress) public view returns (bool isSupported) {
        return batch.supportsToken(tokenAddress);
    }

    // User Functions

    /// @notice Convert receipts into share tokens.
    /// @notice Cycle noted in receipt should be closed.
    /// @return shares Amount of shares redeemed by burning receipts.
    function redeemReceiptsToShares(uint256[] calldata receiptIds) public returns (uint256 shares) {
        shares = StrategyRouterLib.burnReceipts(receiptIds, currentCycleId, receiptContract, cycles);
        sharesToken.transfer(msg.sender, shares);
        emit RedeemReceiptsToShares(msg.sender, shares, receiptIds);
    }

    /// @notice Withdraw tokens from strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice If not enough shares unlocked from receipt, or no receipts are passed, then shares will be taken from user.
    /// @notice Receipts are burned.
    /// @notice Cycle noted in receipts should be closed.
    /// @param receiptIds Array of ReceiptNFT ids.
    /// @param withdrawToken Supported token that user wish to receive.
    /// @param shares Amount of shares to withdraw.
    function withdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 shares,
        uint256 minTokenAmountToWithdraw,
        bool performCompound
    ) external returns (uint256 withdrawnAmount) {
        if (shares == 0) revert AmountNotSpecified();
        uint256 supportedTokenIndex = type(uint256).max;
        address[] memory supportedTokens = getSupportedTokens();
        {
            uint256 supportedTokensLength = supportedTokens.length;
            for (uint256 i; i < supportedTokensLength; i++) {
                if (supportedTokens[i] == withdrawToken) {
                    supportedTokenIndex = i;
                    break;
                }
            }
        }
        if (supportedTokenIndex == type(uint256).max) {
            revert UnsupportedToken();
        }

        IReceiptNFT _receiptContract = receiptContract;
        uint256 _currentCycleId = currentCycleId;
        uint256 unlockedShares;

        // first try to get all shares from receipts
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (_receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();
            uint256 receiptShares = StrategyRouterLib.calculateSharesFromReceipt(
                receiptId,
                _currentCycleId,
                _receiptContract,
                cycles
            );
            unlockedShares += receiptShares;
            if (unlockedShares > shares) {
                // receipts fulfilled requested shares and more,
                // so get rid of extra shares and update receipt amount
                uint256 leftoverShares = unlockedShares - shares;
                unlockedShares -= leftoverShares;

                ReceiptData memory receipt = receiptContract.getReceipt(receiptId);
                uint256 newReceiptAmount = (receipt.tokenAmountUniform * leftoverShares) / receiptShares;
                _receiptContract.setAmount(receiptId, newReceiptAmount);
            } else {
                // unlocked shares less or equal to requested, so can take whole receipt amount
                _receiptContract.burn(receiptId);
            }
            if (unlockedShares == shares) break;
        }

        // if receipts didn't fulfill requested shares amount, then try to take more from caller
        if (unlockedShares < shares) {
            // lack of shares -> get from user
            sharesToken.transferFromAutoApproved(msg.sender, address(this), shares - unlockedShares);
        }

        // Compound before calculate shares USD value and withdrawal if requested by user
        if (performCompound) compoundAll();

        // shares into usd using current PPS
        uint256 usdToWithdraw = calculateSharesUsdValue(shares);
        sharesToken.burn(address(this), shares);

        // Withhold withdrawn amount from cycle's TVL, to not to affect AllocateToStrategies calculations in this cycle
        uint256 adjustPreviousCycleStrategiesBalanceByInUsd = (shares * cycles[currentCycleId - 1].pricePerShare) /
            PRECISION;
        cycles[currentCycleId - 1]
            .strategiesBalanceWithCompoundAndBatchDepositsInUsd -= adjustPreviousCycleStrategiesBalanceByInUsd;

        withdrawnAmount = _withdrawFromStrategies(
            usdToWithdraw,
            withdrawToken,
            minTokenAmountToWithdraw,
            supportedTokenIndex
        );
    }

    /// @notice Withdraw tokens from batch.
    /// @notice Receipts are burned and user receives amount of tokens that was noted.
    /// @notice Cycle noted in receipts should be current cycle.
    /// @param _receiptIds Receipt NFTs ids.
    function withdrawFromBatch(uint256[] calldata _receiptIds) public {
        (uint256[] memory receiptIds, address[] memory tokens, uint256[] memory withdrawnTokenAmounts) = batch.withdraw(
            msg.sender,
            _receiptIds,
            currentCycleId
        );

        currentCycleDepositsCount -= receiptIds.length;
        if (currentCycleDepositsCount == 0) currentCycleFirstDepositAt = 0;

        emit WithdrawFromBatch(msg.sender, receiptIds, tokens, withdrawnTokenAmounts);
    }

    /// @notice Deposit token into batch.
    /// @param depositToken Supported token to deposit.
    /// @param depositAmount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    function depositToBatch(address depositToken, uint256 depositAmount, string calldata referral) external payable {
        uint256 depositFeeAmount = batch.deposit{value: msg.value}(
            msg.sender,
            depositToken,
            depositAmount,
            currentCycleId
        );

        IERC20(depositToken).safeTransferFrom(msg.sender, address(batch), depositAmount);

        currentCycleDepositsCount++;
        if (currentCycleFirstDepositAt == 0) currentCycleFirstDepositAt = block.timestamp;

        emit Deposit(msg.sender, depositToken, depositAmount, depositFeeAmount, referral);
    }

    // Admin functions

    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function setSupportedToken(address tokenAddress, bool supported, address idleStrategy) external onlyModerator {
        if (!supported) {
            TokenPrice[] memory supportedTokensWithPricesWithRemovedToken = batch.getSupportedTokensWithPriceInUsd();

            (bool wasRemovedFromTail, address formerTailTokenAddress, uint256 newIndexOfFormerTailToken) = batch
                .removeSupportedToken(tokenAddress);

            StrategyRouterLib._removeIdleStrategy(
                idleStrategies,
                batch,
                exchange,
                strategies,
                allStrategiesWeightSum,
                tokenAddress,
                supportedTokensWithPricesWithRemovedToken,
                moderator
            );
            if (!wasRemovedFromTail) {
                uint256 strategiesLength = strategies.length;
                for (uint256 i; i < strategiesLength; i++) {
                    if (strategies[i].depositToken == formerTailTokenAddress) {
                        strategies[i].depositTokenInSupportedTokensIndex = newIndexOfFormerTailToken;
                    }
                }
            }
        } else {
            batch.addSupportedToken(tokenAddress);
            address[] memory supportedTokens = getSupportedTokens();
            StrategyRouterLib.setIdleStrategy(
                idleStrategies,
                supportedTokens,
                supportedTokens.length - 1,
                idleStrategy,
                moderator
            );
        }
    }

    /// @notice Set address for fees collected by protocol.
    /// @dev Admin function.
    function setFeesCollectionAddress(address _moderator) external onlyModerator {
        if (_moderator == address(0)) revert();
        moderator = _moderator;
        emit SetModeratorAddress(_moderator);
    }

    /// @notice Minimum time needed to be able to close the cycle.
    /// @param timeInSeconds Duration of cycle in seconds.
    /// @dev Admin function.
    function setAllocationWindowTime(uint256 timeInSeconds) external onlyModerator {
        allocationWindowTime = timeInSeconds;
        emit SetAllocationWindowTime(timeInSeconds);
    }

    // ///
    // function viewParams() external view returns (uint256, address) {
    //     return (allocationWindowTime, address(batch));
    // }

    /// @notice Add strategy.
    /// @param _strategyAddress Address of the strategy.
    /// @param _weight Weight of the strategy. Used to split user deposit between strategies.
    /// @dev Admin function.
    /// @dev Deposit token must be supported by the router.
    function addStrategy(address _strategyAddress, uint256 _weight) external onlyModerator {
        address strategyDepositTokenAddress = IStrategy(_strategyAddress).depositToken();
        address[] memory supportedTokens = getSupportedTokens();
        bool isDepositTokenSupported = false;
        uint256 depositTokenInSupportedTokensIndex;
        uint256 supportedTokensLength = supportedTokens.length;
        for (uint256 i; i < supportedTokensLength; i++) {
            if (supportedTokens[i] == strategyDepositTokenAddress) {
                depositTokenInSupportedTokensIndex = i;
                isDepositTokenSupported = true;
            }
        }
        if (!isDepositTokenSupported) {
            revert UnsupportedToken();
        }

        uint256 len = strategies.length;
        for (uint256 i = 0; i < len; i++) {
            if (strategies[i].strategyAddress == _strategyAddress) revert DuplicateStrategy();
        }

        strategies.push(
            StrategyInfo({
                strategyAddress: _strategyAddress,
                depositToken: strategyDepositTokenAddress,
                weight: _weight,
                depositTokenInSupportedTokensIndex: depositTokenInSupportedTokensIndex
            })
        );
        allStrategiesWeightSum += _weight;
    }

    /// @notice Update strategy weight.
    /// @param _strategyId Id of the strategy.
    /// @param _weight New weight of the strategy.
    /// @dev Admin function.
    function updateStrategy(uint256 _strategyId, uint256 _weight) external onlyModerator {
        allStrategiesWeightSum -= strategies[_strategyId].weight;
        allStrategiesWeightSum += _weight;

        strategies[_strategyId].weight = _weight;
    }

    /// @notice Remove strategy and deposit its balance in other strategies.
    /// @notice Will revert when there is only 1 strategy left.
    /// @param _strategyId Id of the strategy.
    /// @dev Admin function.
    function removeStrategy(uint256 _strategyId) external onlyModerator {
        if (strategies.length < 2) revert CantRemoveLastStrategy();
        StrategyInfo memory removedStrategyInfo = strategies[_strategyId];
        IStrategy removedStrategy = IStrategy(removedStrategyInfo.strategyAddress);

        uint256 len = strategies.length - 1;
        strategies[_strategyId] = strategies[len];
        strategies.pop();
        allStrategiesWeightSum -= removedStrategyInfo.weight;

        // compound removed strategy
        removedStrategy.compound();

        // withdraw all from removed strategy
        removedStrategy.withdrawAll();

        // compound all strategies
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // deposit withdrawn funds into other strategies
        TokenPrice[] memory supportedTokenPrices = batch.getSupportedTokensWithPriceInUsd();
        StrategyRouterLib.rebalanceStrategies(exchange, strategies, allStrategiesWeightSum, supportedTokenPrices);

        Ownable(address(removedStrategy)).transferOwnership(moderator);
    }

    function setIdleStrategy(uint256 i, address idleStrategy) external onlyModerator {
        StrategyRouterLib.setIdleStrategy(idleStrategies, getSupportedTokens(), i, idleStrategy, moderator);
    }

    /// @notice Rebalance strategies, so that their balances will match their weights.
    /// @return balances Balances of the strategies after rebalancing.
    /// @dev Admin function.
    function rebalanceStrategies() external onlyModerator returns (uint256[] memory balances) {
        TokenPrice[] memory supportedTokenPrices = batch.getSupportedTokensWithPriceInUsd();
        return
            StrategyRouterLib.rebalanceStrategies(exchange, strategies, allStrategiesWeightSum, supportedTokenPrices);
    }

    /// @notice Checks weather upkeep method is ready to be called.
    /// Method is compatible with AutomationCompatibleInterface from ChainLink smart contracts
    /// @return upkeepNeeded Returns weither upkeep method needs to be executed
    /// @dev Automation function
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory) {
        upkeepNeeded =
            currentCycleFirstDepositAt > 0 &&
            currentCycleFirstDepositAt + allocationWindowTime < block.timestamp;
    }

    function timestamp() external view returns (uint256 upkeepNeeded) {
        upkeepNeeded = block.timestamp;
    }

    /// @notice Execute upkeep routine that proxies to allocateToStrategies
    /// Method is compatible with AutomationCompatibleInterface from ChainLink smart contracts
    /// @dev Automation function
    function performUpkeep(bytes calldata) external override {
        this.allocateToStrategies();
    }

    // @dev Returns cycle data
    function getCycle(
        uint256 _cycleId
    )
        public
        view
        returns (
            uint256 startAt,
            uint256 totalDepositedInUsd,
            uint256 receivedByStrategiesInUsd,
            uint256 strategiesBalanceWithCompoundAndBatchDepositsInUsd,
            uint256 pricePerShare
        )
    {
        Cycle storage requestedCycle = cycles[_cycleId];

        startAt = requestedCycle.startAt;
        totalDepositedInUsd = requestedCycle.totalDepositedInUsd;
        receivedByStrategiesInUsd = requestedCycle.receivedByStrategiesInUsd;
        strategiesBalanceWithCompoundAndBatchDepositsInUsd = requestedCycle
            .strategiesBalanceWithCompoundAndBatchDepositsInUsd;
        pricePerShare = requestedCycle.pricePerShare;
    }

    // Internals

    /// @param withdrawAmountUsd - USD value to withdraw. `UNIFORM_DECIMALS` decimals.
    /// @param withdrawToken Supported token to receive after withdraw.
    /// @param minTokenAmountToWithdraw min amount expected to be withdrawn
    /// @param supportedTokenIndex index in supported tokens
    /// @return tokenAmountToWithdraw amount of tokens that were actually withdrawn
    function _withdrawFromStrategies(
        uint256 withdrawAmountUsd,
        address withdrawToken,
        uint256 minTokenAmountToWithdraw,
        uint256 supportedTokenIndex
    ) private returns (uint256 tokenAmountToWithdraw) {
        (
            ,
            uint256 totalStrategyBalance,
            uint256 totalIdleStrategyBalance,
            uint256[] memory strategyTokenBalancesUsd,
            uint256[] memory idleStrategyTokenBalancesUsd
        ) = getStrategiesValue();

        if (totalIdleStrategyBalance != 0) {
            if (idleStrategyTokenBalancesUsd[supportedTokenIndex] != 0) {
                // at this moment its in USD
                uint256 tokenAmountToWithdrawFromIdle = idleStrategyTokenBalancesUsd[supportedTokenIndex] <
                    withdrawAmountUsd
                    ? idleStrategyTokenBalancesUsd[supportedTokenIndex]
                    : withdrawAmountUsd;

                unchecked {
                    // we assume that the whole requested amount was withdrawn
                    // we on purpose do not adjust for slippage, fees, etc
                    // otherwise a user will be able to withdraw on Clip at better rates than on DEXes at other LPs expense
                    // if not the whole amount withdrawn from a strategy the slippage protection will sort this out
                    withdrawAmountUsd -= tokenAmountToWithdrawFromIdle;
                }

                (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(withdrawToken);

                // convert usd value into token amount
                tokenAmountToWithdrawFromIdle =
                    (tokenAmountToWithdrawFromIdle * 10 ** oraclePriceDecimals) /
                    tokenUsdPrice;
                // adjust decimals of the token amount
                tokenAmountToWithdrawFromIdle = fromUniform(tokenAmountToWithdrawFromIdle, withdrawToken);
                tokenAmountToWithdraw += IStrategy(idleStrategies[supportedTokenIndex].strategyAddress).withdraw(
                    tokenAmountToWithdrawFromIdle
                );
            }

            if (withdrawAmountUsd != 0) {
                for (uint256 i; i < idleStrategies.length; i++) {
                    if (i == supportedTokenIndex) {
                        continue;
                    }
                    if (idleStrategyTokenBalancesUsd[i] == 0) {
                        continue;
                    }

                    // at this moment its in USD
                    uint256 tokenAmountToSwap = idleStrategyTokenBalancesUsd[i] < withdrawAmountUsd
                        ? idleStrategyTokenBalancesUsd[i]
                        : withdrawAmountUsd;

                    unchecked {
                        // we assume that the whole requested amount was withdrawn
                        // we on purpose do not adjust for slippage, fees, etc
                        // otherwise a user will be able to withdraw on Clip at better rates than on DEXes at other LPs expense
                        // if not the whole amount withdrawn from a strategy the slippage protection will sort this out
                        withdrawAmountUsd -= tokenAmountToSwap;
                    }

                    (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(
                        idleStrategies[i].depositToken
                    );

                    // convert usd value into token amount
                    tokenAmountToSwap = (tokenAmountToSwap * 10 ** oraclePriceDecimals) / tokenUsdPrice;
                    // adjust decimals of the token amount
                    tokenAmountToSwap = fromUniform(tokenAmountToSwap, idleStrategies[i].depositToken);
                    tokenAmountToSwap = IStrategy(idleStrategies[i].strategyAddress).withdraw(tokenAmountToSwap);
                    // swap for requested token
                    tokenAmountToWithdraw += StrategyRouterLib.trySwap(
                        exchange,
                        tokenAmountToSwap,
                        idleStrategies[i].depositToken,
                        withdrawToken
                    );

                    if (withdrawAmountUsd == 0) break;
                }
            }
        }

        if (withdrawAmountUsd != 0) {
            for (uint256 i; i < strategies.length; i++) {
                if (strategyTokenBalancesUsd[i] == 0) {
                    continue;
                }

                uint256 tokenAmountToSwap = (withdrawAmountUsd * strategyTokenBalancesUsd[i]) / totalStrategyBalance;
                totalStrategyBalance -= strategyTokenBalancesUsd[i];

                withdrawAmountUsd -= tokenAmountToSwap;

                // at this moment its in USD
                tokenAmountToSwap = strategyTokenBalancesUsd[i] < tokenAmountToSwap
                    ? strategyTokenBalancesUsd[i]
                    : tokenAmountToSwap;

                (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(
                    strategies[i].depositToken
                );

                // convert usd value into token amount
                tokenAmountToSwap = (tokenAmountToSwap * 10 ** oraclePriceDecimals) / tokenUsdPrice;
                // adjust decimals of the token amount
                tokenAmountToSwap = fromUniform(tokenAmountToSwap, strategies[i].depositToken);
                tokenAmountToSwap = IStrategy(strategies[i].strategyAddress).withdraw(tokenAmountToSwap);
                // swap for requested token
                tokenAmountToWithdraw += StrategyRouterLib.trySwap(
                    exchange,
                    tokenAmountToSwap,
                    strategies[i].depositToken,
                    withdrawToken
                );
            }
        }

        if (tokenAmountToWithdraw < minTokenAmountToWithdraw) {
            revert WithdrawnAmountLowerThanExpectedAmount();
        }

        IERC20(withdrawToken).safeTransfer(msg.sender, tokenAmountToWithdraw);
        emit WithdrawFromStrategies(msg.sender, withdrawToken, tokenAmountToWithdraw);

        return tokenAmountToWithdraw;
    }

    /* ERRORS */

    error AmountExceedTotalSupply();
    error UnsupportedToken();
    error NotReceiptOwner();
    error CycleNotClosed();
    error CycleClosed();
    error InsufficientShares();
    error DuplicateStrategy();
    error CycleNotClosableYet();
    error AmountNotSpecified();
    error CantRemoveLastStrategy();
    error NothingToRebalance();
    error NotModerator();
    error WithdrawnAmountLowerThanExpectedAmount();
    error InvalidIdleStrategy();
    error InvalidIndexForIdleStrategy();
    error IdleStrategySupportedTokenMismatch();

    /* EVENTS */

    /// @notice Fires when user deposits in batch.
    /// @param token Supported token that user want to deposit.
    /// @param amountAfterFee Amount of `token` transferred from user after fee.
    /// @param feeAmount Amount of `token` fee taken for deposit to the batch.
    /// @param referral Code that is given to individuals who can refer other users
    event Deposit(address indexed user, address token, uint256 amountAfterFee, uint256 feeAmount, string referral);
    /// @notice Fires when batch is deposited into strategies.
    /// @param closedCycleId Index of the cycle that is closed.
    /// @param amount Sum of different tokens deposited into strategies.
    event AllocateToStrategies(uint256 indexed closedCycleId, uint256 amount);
    /// @notice Fires when compound process is finished.
    /// @param currentCycle Index of the current cycle.
    /// @param currentTvlInUsd Current TVL in USD.
    /// @param totalShares Current amount of shares.
    event AfterCompound(uint256 indexed currentCycle, uint256 currentTvlInUsd, uint256 totalShares);
    /// @notice Fires when user withdraw from strategies.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromStrategies(address indexed user, address token, uint256 amount);
    /// @notice Fires when user converts his receipt into shares token.
    /// @param shares Amount of shares received by user.
    /// @param receiptIds Indexes of the receipts burned.
    event RedeemReceiptsToShares(address indexed user, uint256 shares, uint256[] receiptIds);
    /// @notice Fires when moderator converts foreign receipts into shares token.
    /// @param receiptIds Indexes of the receipts burned.
    event RedeemReceiptsToSharesByModerators(address indexed moderator, uint256[] receiptIds);

    /// @notice Fires when user withdraw from batch.
    /// @param user who initiated withdrawal.
    /// @param receiptIds original IDs of the corresponding deposited receipts (NFTs).
    /// @param tokens that is being withdrawn. can be one token multiple times.
    /// @param amounts Amount of respective token from `tokens` received by user.
    event WithdrawFromBatch(address indexed user, uint256[] receiptIds, address[] tokens, uint256[] amounts);

    // Events for setters.
    event SetAllocationWindowTime(uint256 newDuration);
    event SetModeratorAddress(address newAddress);
    event SetAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        ISharesToken _sharesToken,
        IBatch _batch,
        IReceiptNFT _receiptNft
    );
}
