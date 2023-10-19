//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./deps/OwnableUpgradeable.sol";
import "./deps/Initializable.sol";
import "./deps/UUPSUpgradeable.sol";
import "./deps/EnumerableSetExtension.sol";

import {TokenPrice, StrategyInfo, IdleStrategyInfo, ReceiptData} from "./lib/Structs.sol";
import {toUniform, fromUniform, MAX_BPS} from "./lib/Math.sol";

import "./interfaces/IIdleStrategy.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import "./interfaces/IExchange.sol";
import "./interfaces/IStrategyRouter.sol";
import "./interfaces/IReceiptNFT.sol";

/// @notice This contract contains batch related code, serves as part of StrategyRouter.
/// @notice This contract should be owned by StrategyRouter.
contract Batch is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSetExtension for EnumerableSet.AddressSet;

    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17;

    uint256 private constant DEPOSIT_FEE_AMOUNT_THRESHOLD = 50e18; // 50 USD
    uint256 private constant DEPOSIT_FEE_PERCENT_THRESHOLD = 300; // 3% in basis points

    DepositFeeSettings public depositFeeSettings;

    IReceiptNFT public receiptContract;
    IExchange public exchange;
    IStrategyRouter public router;
    IUsdOracle public oracle;

    EnumerableSet.AddressSet private supportedTokens;

    struct DepositFeeSettings {
        uint256 minFeeInUsd; // Amount of USD, must be `UNIFORM_DECIMALS` decimals
        uint256 maxFeeInUsd; // Amount of USD, must be `UNIFORM_DECIMALS` decimals
        uint256 feeInBps; // Percentage of deposit fee, in basis points
    }

    struct TokenInfo {
        address tokenAddress;
        uint256 balance;
        bool insufficientBalance;
    }

    struct CapacityData {
        bool isLimitReached;
        uint256 underflowUniform;
    }

    modifier onlyStrategyRouter() {
        if (msg.sender != address(router)) revert CallerIsNotStrategyRouter();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();

        // transer ownership to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // Owner Functions

    function setAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        IStrategyRouter _router,
        IReceiptNFT _receiptNft
    ) external onlyOwner {
        exchange = _exchange;
        oracle = _oracle;
        router = _router;
        receiptContract = _receiptNft;
        emit SetAddresses(_exchange, _oracle, _router, _receiptNft);
    }

    /// @notice Set deposit fee settings in the batch.
    /// @param _depositFeeSettings Deposit settings.
    /// @dev Owner function.
    function setDepositFeeSettings(DepositFeeSettings calldata _depositFeeSettings) external onlyOwner {
        // Ensure that maxFeeInUsd is not greater than the threshold of 50 USD
        if (_depositFeeSettings.maxFeeInUsd > DEPOSIT_FEE_AMOUNT_THRESHOLD) {
            revert MaxDepositFeeExceedsThreshold();
        }

        // Ensure that feeInBps is not greater than the threshold of 300 bps (3%)
        if (_depositFeeSettings.feeInBps > DEPOSIT_FEE_PERCENT_THRESHOLD) {
            revert DepositFeePercentExceedsFeePercentageThreshold();
        }

        // Ensure that minFeeInUsd is not greater than maxFeeInUsd
        if (_depositFeeSettings.maxFeeInUsd < _depositFeeSettings.minFeeInUsd) revert MinDepositFeeExceedsMax();

        // Ensure that maxFeeInUsd also has a value if feeInBps is set
        if (_depositFeeSettings.maxFeeInUsd == 0 && _depositFeeSettings.feeInBps != 0) {
            revert NotSetMaxFeeInStableWhenFeeInBpsIsSet();
        }

        depositFeeSettings = _depositFeeSettings;
        emit SetDepositFeeSettings(depositFeeSettings);
    }

    // Universal Functions

    function supportsToken(address tokenAddress) public view returns (bool) {
        return supportedTokens.contains(tokenAddress);
    }

    /// @dev Returns list of supported tokens.
    function getSupportedTokens() public view returns (address[] memory) {
        return supportedTokens.values();
    }

    function getBatchValueUsd()
        public
        view
        returns (uint256 totalBalanceUsd, uint256[] memory supportedTokenBalancesUsd)
    {
        TokenPrice[] memory supportedTokenPrices = getSupportedTokensWithPriceInUsd();
        return this.getBatchValueUsdWithoutOracleCalls(supportedTokenPrices);
    }

    function getBatchValueUsdWithoutOracleCalls(
        TokenPrice[] calldata supportedTokenPrices
    ) public view returns (uint256 totalBalanceUsd, uint256[] memory supportedTokenBalancesUsd) {
        supportedTokenBalancesUsd = new uint256[](supportedTokenPrices.length);
        for (uint256 i; i < supportedTokenBalancesUsd.length; i++) {
            address token = supportedTokenPrices[i].token;
            uint256 balance = IERC20(token).balanceOf(address(this));

            balance = ((balance * supportedTokenPrices[i].price) / 10 ** supportedTokenPrices[i].priceDecimals);
            balance = toUniform(balance, token);
            supportedTokenBalancesUsd[i] = balance;
            totalBalanceUsd += balance;
        }
    }

    function getSupportedTokensWithPriceInUsd() public view returns (TokenPrice[] memory supportedTokenPrices) {
        address[] memory _supportedTokens = getSupportedTokens();
        uint256 supportedTokensLength = _supportedTokens.length;
        supportedTokenPrices = new TokenPrice[](supportedTokensLength);
        for (uint256 i; i < supportedTokensLength; i++) {
            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(_supportedTokens[i]);
            supportedTokenPrices[i] = TokenPrice({
                price: price,
                priceDecimals: priceDecimals,
                token: _supportedTokens[i]
            });
        }
    }

    // @notice Get a deposit fee amount in tokens.
    // @param amountInStableUniform Amount of tokens to deposit.
    // @dev Returns a deposit fee amount with token decimals.
    function getDepositFeeInBNB(uint256 amountInStableUniform) public view returns (uint256 feeAmountInBNB) {
        uint256 feeAmountStableCoin = calculateDepositFee(amountInStableUniform);

        // Now, find out the value of BNB in USD.
        (uint256 bnbUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(
            0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
        );

        // Convert the fee in USD to BNB.
        feeAmountInBNB = (feeAmountStableCoin * (10 ** oraclePriceDecimals)) / bnbUsdPrice;
    }

    // User Functions

    /// @notice Withdraw tokens from batch while receipts are in batch.
    /// @notice Receipts are burned.
    /// @param receiptIds Receipt NFTs ids.
    /// @dev Only callable by user wallets.
    function withdraw(
        address receiptOwner,
        uint256[] calldata receiptIds,
        uint256 _currentCycleId
    )
        public
        onlyStrategyRouter
        returns (uint256[] memory _receiptIds, address[] memory _tokens, uint256[] memory _withdrawnTokenAmounts)
    {
        // withdrawn tokens/amounts will be sent in event. due to solidity design can't do token=>amount array
        address[] memory tokens = new address[](receiptIds.length);
        uint256[] memory withdrawnTokenAmounts = new uint256[](receiptIds.length);

        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != receiptOwner) revert NotReceiptOwner();

            ReceiptData memory receipt = receiptContract.getReceipt(receiptId);

            // only for receipts in current batch
            if (receipt.cycleId != _currentCycleId) revert CycleClosed();

            uint256 transferAmount = fromUniform(receipt.tokenAmountUniform, receipt.token);
            IERC20(receipt.token).safeTransfer(receiptOwner, transferAmount);
            receiptContract.burn(receiptId);

            tokens[i] = receipt.token;
            withdrawnTokenAmounts[i] = transferAmount;
        }
        return (receiptIds, tokens, withdrawnTokenAmounts);
    }

    /// @notice Deposit token into batch.
    /// @notice Tokens not deposited into strategies immediately.
    /// @param depositToken Supported token to deposit.
    /// @param depositAmount Amount to deposit.
    /// @dev Returns deposited token amount and taken fee amount.
    /// @dev User should approve `amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function deposit(
        address depositor,
        address depositToken,
        uint256 depositAmount,
        uint256 _currentCycleId
    ) external payable onlyStrategyRouter returns (uint256 depositFeeAmount) {
        if (!supportsToken(depositToken)) revert UnsupportedToken();

        uint256 depositAmountUniform = toUniform(depositAmount, depositToken);
        depositFeeAmount = getDepositFeeInBNB(depositAmountUniform);
        if (msg.value < depositFeeAmount) {
            revert DepositUnderDepositFeeValue();
        }

        receiptContract.mint(_currentCycleId, depositAmountUniform, depositToken, depositor);
    }

    function transfer(address token, address to, uint256 amount) external onlyStrategyRouter {
        IERC20(token).safeTransfer(to, amount);
    }

    // Admin functions

    function rebalance(
        TokenPrice[] calldata supportedTokenPrices,
        StrategyInfo[] calldata strategies,
        uint256 remainingToAllocateStrategiesWeightSum,
        IdleStrategyInfo[] calldata idleStrategies
    ) public onlyStrategyRouter {
        uint256[] memory balancesPendingAllocationToStrategy;
        TokenInfo[] memory tokenInfos;

        (balancesPendingAllocationToStrategy, tokenInfos) = _rebalanceNoAllocation(
            supportedTokenPrices,
            strategies,
            remainingToAllocateStrategiesWeightSum
        );

        for (uint256 i; i < strategies.length; i++) {
            if (balancesPendingAllocationToStrategy[i] > 0) {
                IERC20(strategies[i].depositToken).safeTransfer(
                    strategies[i].strategyAddress,
                    balancesPendingAllocationToStrategy[i]
                );
                IStrategy(strategies[i].strategyAddress).deposit(balancesPendingAllocationToStrategy[i]);
            }
        }

        for (uint256 i; i < tokenInfos.length; i++) {
            uint256 supportedTokenBalance = tokenInfos[i].balance;
            if (supportedTokenBalance > 0) {
                IERC20(idleStrategies[i].depositToken).safeTransfer(
                    idleStrategies[i].strategyAddress,
                    supportedTokenBalance
                );
                IIdleStrategy(idleStrategies[i].strategyAddress).deposit(supportedTokenBalance);
            }
        }
    }

    function _rebalanceNoAllocation(
        TokenPrice[] calldata supportedTokenPrices,
        StrategyInfo[] memory strategies,
        uint256 remainingToAllocateStrategiesWeightSum
    ) internal returns (uint256[] memory balancesPendingAllocationToStrategy, TokenInfo[] memory tokenInfos) {
        uint256 totalBatchUnallocatedTokens;

        // point 1
        tokenInfos = new TokenInfo[](supportedTokenPrices.length);

        // point 2
        for (uint256 i; i < tokenInfos.length; i++) {
            tokenInfos[i].tokenAddress = supportedTokenPrices[i].token;
            tokenInfos[i].balance = IERC20(tokenInfos[i].tokenAddress).balanceOf(address(this));

            uint256 tokenBalanceUniform = toUniform(tokenInfos[i].balance, tokenInfos[i].tokenAddress);

            // point 3
            if (tokenBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                totalBatchUnallocatedTokens += tokenBalanceUniform;
            } else {
                tokenInfos[i].insufficientBalance = true;
            }
        }

        balancesPendingAllocationToStrategy = new uint256[](strategies.length);
        CapacityData[] memory capacityData = new CapacityData[](strategies.length);
        // first traversal over strategies
        // 1. try to allocate funds to a strategy if a batch has balance in strategy's deposit token
        // that minimises swaps between tokens – prefer to put a token to strategy that natively support it
        for (uint256 i; i < strategies.length; i++) {
            // necessary check in assumption that some strategies could have 0 weight
            if (remainingToAllocateStrategiesWeightSum == 0) {
                break;
            }

            (capacityData[i].isLimitReached, capacityData[i].underflowUniform, ) = IStrategy(
                strategies[i].strategyAddress
            ).getCapacityData();
            capacityData[i].underflowUniform = toUniform(capacityData[i].underflowUniform, strategies[i].depositToken);

            if (capacityData[i].isLimitReached || capacityData[i].underflowUniform <= REBALANCE_SWAP_THRESHOLD) {
                remainingToAllocateStrategiesWeightSum -= strategies[i].weight;
                strategies[i].weight = 0;

                continue;
            }

            uint256 desiredStrategyBalanceUniform = (totalBatchUnallocatedTokens * strategies[i].weight) /
                remainingToAllocateStrategiesWeightSum;

            if (desiredStrategyBalanceUniform > capacityData[i].underflowUniform) {
                desiredStrategyBalanceUniform = capacityData[i].underflowUniform;
            }

            // nothing to deposit to this strategy
            if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            if (tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].insufficientBalance) {
                continue;
            }

            uint256 batchTokenBalanceUniform = toUniform(
                tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].balance,
                strategies[i].depositToken
            );
            // if there anything to allocate to a strategy
            if (batchTokenBalanceUniform >= desiredStrategyBalanceUniform) {
                // reduce weight of the current strategy in this iteration of rebalance to 0
                remainingToAllocateStrategiesWeightSum -= strategies[i].weight;
                strategies[i].weight = 0;
                // manipulation to avoid dust:
                // if the case remaining balance of token is below allocation threshold –
                // send it to the current strategy
                if (batchTokenBalanceUniform - desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                    totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                    balancesPendingAllocationToStrategy[i] += tokenInfos[
                        strategies[i].depositTokenInSupportedTokensIndex
                    ].balance;
                    tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].balance = 0;
                    tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].insufficientBalance = true;
                } else {
                    uint256 desiredStrategyBalance = fromUniform(
                        desiredStrategyBalanceUniform,
                        strategies[i].depositToken
                    );
                    totalBatchUnallocatedTokens -= toUniform(desiredStrategyBalance, strategies[i].depositToken);
                    tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].balance -= desiredStrategyBalance;
                    balancesPendingAllocationToStrategy[i] += desiredStrategyBalance;
                }
            } else {
                // reduce strategy weight in the current rebalance iteration proportionally to the degree
                // at which the strategy's desired balance was saturated
                // For example: if a strategy's weight is 10,000 and the total weight is 100,000
                // and the strategy's desired balance was saturated by 80%
                // we reduce the strategy weight by 80%
                // strategy weight = 10,000 - 80% * 10,000 = 2,000
                // total strategy weight = 100,000 - 80% * 10,000 = 92,000
                uint256 unfulfilledStrategyTokens = desiredStrategyBalanceUniform - batchTokenBalanceUniform;
                totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                capacityData[i].underflowUniform -= batchTokenBalanceUniform;

                remainingToAllocateStrategiesWeightSum -= strategies[i].weight;

                if (unfulfilledStrategyTokens == totalBatchUnallocatedTokens) {
                    strategies[i].weight = 100;
                } else {
                    strategies[i].weight =
                        (unfulfilledStrategyTokens * remainingToAllocateStrategiesWeightSum) /
                        (totalBatchUnallocatedTokens - unfulfilledStrategyTokens);
                }

                remainingToAllocateStrategiesWeightSum += strategies[i].weight;

                balancesPendingAllocationToStrategy[i] += tokenInfos[strategies[i].depositTokenInSupportedTokensIndex]
                    .balance;
                tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].balance = 0;
                tokenInfos[strategies[i].depositTokenInSupportedTokensIndex].insufficientBalance = true;
            }
        }

        // if everything was rebalanced already then remainingToAllocateStrategiesWeightSum == 0, spare cycles
        if (remainingToAllocateStrategiesWeightSum > 0) {
            for (uint256 i; i < strategies.length; i++) {
                // necessary check as some strategies that go last could saturated on the previous step already
                if (remainingToAllocateStrategiesWeightSum == 0) {
                    break;
                }

                if (capacityData[i].isLimitReached) {
                    continue;
                }

                uint256 desiredStrategyBalanceUniform = (totalBatchUnallocatedTokens * strategies[i].weight) /
                    remainingToAllocateStrategiesWeightSum;
                remainingToAllocateStrategiesWeightSum -= strategies[i].weight;

                if (desiredStrategyBalanceUniform > capacityData[i].underflowUniform) {
                    desiredStrategyBalanceUniform = capacityData[i].underflowUniform;
                }

                if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                    continue;
                }

                for (uint256 j; j < tokenInfos.length; j++) {
                    if (j == strategies[i].depositTokenInSupportedTokensIndex) {
                        continue;
                    }

                    if (tokenInfos[j].insufficientBalance) {
                        continue;
                    }

                    uint256 batchTokenBalanceUniform = toUniform(tokenInfos[j].balance, tokenInfos[j].tokenAddress);

                    // is there anything to allocate to a strategy
                    uint256 toSell;
                    if (batchTokenBalanceUniform >= desiredStrategyBalanceUniform) {
                        // manipulation to avoid leaving dust
                        // if the case remaining balance of token is below allocation threshold –
                        // send it to the current strategy
                        if (batchTokenBalanceUniform - desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                            totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                            toSell = tokenInfos[j].balance;
                            desiredStrategyBalanceUniform = 0;
                            tokenInfos[j].balance = 0;
                            tokenInfos[j].insufficientBalance = true;
                        } else {
                            toSell = fromUniform(desiredStrategyBalanceUniform, tokenInfos[j].tokenAddress);
                            totalBatchUnallocatedTokens -= toUniform(toSell, tokenInfos[j].tokenAddress);
                            desiredStrategyBalanceUniform = 0;
                            tokenInfos[j].balance -= toSell;
                        }
                    } else {
                        totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                        toSell = tokenInfos[j].balance;
                        desiredStrategyBalanceUniform -= batchTokenBalanceUniform;
                        tokenInfos[j].balance = 0;
                        tokenInfos[j].insufficientBalance = true;
                    }

                    balancesPendingAllocationToStrategy[i] += _trySwap(
                        toSell,
                        tokenInfos[j].tokenAddress,
                        strategies[i].depositToken,
                        supportedTokenPrices[j],
                        supportedTokenPrices[strategies[i].depositTokenInSupportedTokensIndex]
                    );

                    // if remaining desired strategy amount is below the threshold then break the cycle
                    if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                        break;
                    }
                }
            }
        }
    }

    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function addSupportedToken(address tokenAddress) external onlyStrategyRouter {
        // attempt to check that token address is valid
        if (!oracle.isTokenSupported(tokenAddress)) {
            revert InvalidToken();
        }
        if (supportsToken(tokenAddress)) revert AlreadySupportedToken();

        supportedTokens.add(tokenAddress);
    }

    /// @notice Remove token as supported for user deposit and withdraw.
    /// @notice It returns whether token was removed from tail
    /// @notice And if not the tail token address and new index were it was moved to
    /// @notice (the way how elements remove from arrays in solidity)
    /// @dev Admin function.
    function removeSupportedToken(
        address tokenAddress
    )
        external
        onlyStrategyRouter
        returns (bool wasRemovedFromTail, address formerTailTokenAddress, uint256 newIndexOfFormerTailToken)
    {
        uint256 initialSupportedTokensLength = supportedTokens.length();
        for (uint256 i; i < initialSupportedTokensLength; i++) {
            if (supportedTokens.at(i) == tokenAddress) {
                newIndexOfFormerTailToken = i;
            }
        }

        uint256 strategiesLength = router.getStrategiesCount();
        // don't remove tokens that are in use by active strategies
        for (uint256 i = 0; i < strategiesLength; i++) {
            if (router.getStrategyDepositToken(i) == tokenAddress) {
                revert CantRemoveTokenOfActiveStrategy();
            }
        }

        supportedTokens.remove(tokenAddress);

        // if token was popped from the end no index replacement occurred
        if (newIndexOfFormerTailToken == initialSupportedTokensLength - 1) {
            return (true, address(0), type(uint256).max);
        } else {
            return (false, supportedTokens.at(newIndexOfFormerTailToken), newIndexOfFormerTailToken);
        }
    }

    // Internals

    /// @dev Swap tokens if they are different (i.e. not the same token)
    function _trySwap(
        uint256 amountA, // tokenFromAmount
        address tokenA, // tokenFrom
        address tokenB, // tokenTo
        TokenPrice memory usdPriceTokenA,
        TokenPrice memory usdPriceTokenB
    ) private returns (uint256 result) {
        if (tokenA != tokenB) {
            IERC20(tokenA).safeTransfer(address(exchange), amountA);
            result = exchange.stablecoinSwap(amountA, tokenA, tokenB, address(this), usdPriceTokenA, usdPriceTokenB);
            return result;
        }
        return amountA;
    }

    /// @notice calculate deposit fee in Stable
    /// @param amountInStableUniform Amount tokens in Stable with `UNIFORM_DECIMALS`.
    /// @dev returns fee amount of tokens in Stable.
    function calculateDepositFee(uint256 amountInStableUniform) public view returns (uint256 feeAmountInStable) {
        DepositFeeSettings memory _depositFeeSettings = depositFeeSettings;

        feeAmountInStable = (amountInStableUniform * _depositFeeSettings.feeInBps) / MAX_BPS;

        // check ranges and apply needed fee limits
        if (feeAmountInStable < _depositFeeSettings.minFeeInUsd) feeAmountInStable = _depositFeeSettings.minFeeInUsd;
        else if (feeAmountInStable > _depositFeeSettings.maxFeeInUsd)
            feeAmountInStable = _depositFeeSettings.maxFeeInUsd;
    }

    function collectDepositFee() external onlyOwner {
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "Transfer failed");
    }

    /* ERRORS */

    error AlreadySupportedToken();
    error CantRemoveTokenOfActiveStrategy();
    error UnsupportedToken();
    error NotReceiptOwner();
    error CycleClosed();
    error NotEnoughBalanceInBatch();
    error CallerIsNotStrategyRouter();
    error ErrorToCheckUpgradeContract();
    error MaxDepositFeeExceedsThreshold();
    error MinDepositFeeExceedsMax();
    error DepositFeePercentExceedsFeePercentageThreshold();
    error NotSetMaxFeeInStableWhenFeeInBpsIsSet();
    error DepositFeeTreasuryNotSet();
    error DepositUnderDepositFeeValue();
    error InvalidToken();

    /* EVENTS */

    event SetAddresses(IExchange _exchange, IUsdOracle _oracle, IStrategyRouter _router, IReceiptNFT _receiptNft);
    event SetDepositFeeSettings(Batch.DepositFeeSettings newDepositFeeSettings);
}
