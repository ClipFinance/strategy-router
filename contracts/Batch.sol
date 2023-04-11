//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./deps/OwnableUpgradeable.sol";
import "./deps/Initializable.sol";
import "./deps/UUPSUpgradeable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import {ReceiptNFT} from "./ReceiptNFT.sol";
import {StrategyRouter} from "./StrategyRouter.sol";
import {Exchange} from "./exchange/Exchange.sol";
import "./deps/EnumerableSetExtension.sol";
import "./interfaces/IUsdOracle.sol";

// import "hardhat/console.sol";

/// @notice This contract contains batch related code, serves as part of StrategyRouter.
/// @notice This contract should be owned by StrategyRouter.
contract Batch is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSetExtension for EnumerableSet.AddressSet;

    /* ERRORS */

    error AlreadySupportedToken();
    error CantRemoveTokenOfActiveStrategy();
    error UnsupportedToken();
    error NotReceiptOwner();
    error CycleClosed();
    error NotEnoughBalanceInBatch();
    error CallerIsNotStrategyRouter();
    error DepositFeeExceedsDepositAmountOrTheyAreEqual();
    error MaxDepositFeeExceedsThreshold();
    error MinDepositFeeExceedsMax();
    error DepositFeePercentExceedsFeePercentageThreshold();
    error NotSetMaxFeeInUsdWhenFeeInBpsIsSet();
    error DepositFeeTreasuryNotSet();
    error DepositUnderDepositFeeValue();
    error InvalidToken();

    event SetAddresses(Exchange _exchange, IUsdOracle _oracle, StrategyRouter _router, ReceiptNFT _receiptNft);
    event SetDepositFeeSettings(Batch.DepositFeeSettings newDepositFeeSettings);

    uint8 public constant UNIFORM_DECIMALS = 18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17;

    uint256 private constant DEPOSIT_FEE_AMOUNT_THRESHOLD = 50e18; // 50 USD
    uint256 private constant DEPOSIT_FEE_PERCENT_THRESHOLD = 300; // 3% in basis points
    uint256 private constant MAX_BPS = 10000; // 100%

    DepositFeeSettings public depositFeeSettings;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    StrategyRouter public router;
    IUsdOracle public oracle;

    EnumerableSet.AddressSet private supportedTokens;

    struct DepositFeeSettings {
        uint256 minFeeInUsd;    // Amount of USD, must be `UNIFORM_DECIMALS` decimals
        uint256 maxFeeInUsd;    // Amount of USD, must be `UNIFORM_DECIMALS` decimals
        uint256 feeInBps;       // Percentage of deposit fee, in basis points
        address feeTreasury;    // Address to send deposit fee to
    }

    struct TokenInfo {
        address tokenAddress;
        uint256 balance;
        bool insufficientBalance;
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

    function initialize() external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // Owner Functions

    function setAddresses(
        Exchange _exchange,
        IUsdOracle _oracle,
        StrategyRouter _router,
        ReceiptNFT _receiptNft
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
            revert NotSetMaxFeeInUsdWhenFeeInBpsIsSet();
        }

        if (
            (
                // Ensure that either maxFeeInUsd or feeInBps is set
                (_depositFeeSettings.maxFeeInUsd != 0 && _depositFeeSettings.feeInBps != 0) ||
                // Or ensure that minFeeInUsd set as fixed fee when feeInBps is not set
                (_depositFeeSettings.minFeeInUsd != 0 && _depositFeeSettings.feeInBps == 0)
            )
            &&
            _depositFeeSettings.feeTreasury == address(0) // set 0x000...0dEaD if you want to use a burn address
        ) revert DepositFeeTreasuryNotSet();

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
        supportedTokenBalancesUsd = new uint256[](supportedTokens.length());
        for (uint256 i; i < supportedTokenBalancesUsd.length; i++) {
            address token = supportedTokens.at(i);
            uint256 balance = IERC20(token).balanceOf(address(this));

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(token);
            balance = ((balance * price) / 10**priceDecimals);
            balance = toUniform(balance, token);
            supportedTokenBalancesUsd[i] = balance;
            totalBalanceUsd += balance;
        }
    }

    // @notice Get a deposit fee amount in tokens.
    // @param depositAmount Amount of tokens to deposit.
    // @param depositToken Token address.
    // @dev Returns a deposit fee amount with token decimals.
    function getDepositFeeInTokens(uint256 depositAmount, address depositToken)
        public
        view
        returns (uint256 feeAmount)
    {
        // convert deposit amount to USD
        (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(depositToken);
        if (tokenUsdPrice == 0) return 0; // token is not supported by oracle
        uint256 depositAmountInUsd = (depositAmount * tokenUsdPrice) / 10**oraclePriceDecimals;
        depositAmountInUsd = toUniform(depositAmountInUsd, depositToken);

        // calculate fee amount in USD
        uint256 feeAmountInUsd = calculateDepositFee(depositAmountInUsd);
        if (feeAmountInUsd == 0) return 0;

        // ensure that fee amount is not exceed deposit amount to avoid overflow
        // and they are not equal to avoid 0 deposit
        if (feeAmountInUsd >= depositAmountInUsd) revert DepositFeeExceedsDepositAmountOrTheyAreEqual();

        // convert fee amount in usd to tokens amount
        feeAmount = (feeAmountInUsd * 10**oraclePriceDecimals) / tokenUsdPrice;
        feeAmount = fromUniform(feeAmount, depositToken);
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
    ) public onlyStrategyRouter returns (
        uint256[] memory _receiptIds,
        address[] memory _tokens,
        uint256[] memory _withdrawnTokenAmounts)
    {

        // withdrawn tokens/amounts will be sent in event. due to solidity design can't do token=>amount array
        address[] memory tokens = new address[](receiptIds.length);
        uint256[] memory withdrawnTokenAmounts = new uint256[](receiptIds.length);

        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != receiptOwner) revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(receiptId);

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
    /// @param amount Amount to deposit.
    /// @dev Returns deposited token amount and taken fee amount.
    /// @dev User should approve `amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function deposit(
        address depositor,
        address depositToken,
        uint256 amount,
        uint256 _currentCycleId
    ) external onlyStrategyRouter returns (uint256 depositAmount, uint256 depositFeeAmount) {
        if (!supportsToken(depositToken)) revert UnsupportedToken();

        uint256 feeAmount = getDepositFeeInTokens(amount, depositToken);

        depositAmount = amount - feeAmount;

        if (feeAmount != 0) IERC20(depositToken).safeTransfer(depositFeeSettings.feeTreasury, feeAmount);

        uint256 amountUniform = toUniform(depositAmount, depositToken);

        receiptContract.mint(_currentCycleId, amountUniform, depositToken, depositor);

        return (depositAmount, feeAmount);
    }

    function transfer(
        address token,
        address to,
        uint256 amount
    ) external onlyStrategyRouter {
        IERC20(token).safeTransfer(to, amount);
    }

    // Admin functions

    function rebalance() public onlyStrategyRouter returns (uint256[] memory balancesPendingAllocationToStrategy) {
        uint256 totalBatchUnallocatedTokens;

        // point 1
        TokenInfo[] memory tokenInfos = new TokenInfo[](supportedTokens.length());

        // point 2
        for (uint256 i; i < tokenInfos.length; i++) {
            tokenInfos[i].tokenAddress = supportedTokens.at(i);
            tokenInfos[i].balance = IERC20(tokenInfos[i].tokenAddress).balanceOf(address(this));

            uint tokenBalanceUniform = toUniform(
                tokenInfos[i].balance,
                tokenInfos[i].tokenAddress
            );

            // point 3
            if (tokenBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                totalBatchUnallocatedTokens += tokenBalanceUniform;
            } else {
                tokenInfos[i].insufficientBalance = true;
            }
        }

        (StrategyRouter.StrategyInfo[] memory strategies, uint256 remainingToAllocateStrategiesWeightSum)
            = router.getStrategies();

        balancesPendingAllocationToStrategy = new uint256[](strategies.length);
        uint256[] memory strategyToSupportedTokenIndexMap = new uint256[](strategies.length);
        // first traversal over strategies
        // 1. collect info: supported token index that corresponds to a strategy
        // 2. try to allocate funds to a strategy if a batch has balance in strategy's deposit token
        // that minimises swaps between tokens – prefer to put a token to strategy that natively support it
        for (uint256 i; i < strategies.length; i++) {
            // necessary check in assumption that some strategies could have 0 weight
            if (remainingToAllocateStrategiesWeightSum == 0) {
                break;
            }
            address strategyToken = strategies[i].depositToken;
            uint256 desiredStrategyBalanceUniform = totalBatchUnallocatedTokens * strategies[i].weight
                / remainingToAllocateStrategiesWeightSum;

            // nothing to deposit to this strategy
            if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            // figure out corresponding token index in supported tokens list
            // TODO corresponding token index in supported tokens list should be known upfront
            for (uint256 j; j < tokenInfos.length; j++) {
                if (strategyToken == tokenInfos[j].tokenAddress) {
                    strategyToSupportedTokenIndexMap[i] = j;
                    break;
                }
            }

            if (tokenInfos[strategyToSupportedTokenIndexMap[i]].insufficientBalance) {
                continue;
            }

            uint256 batchTokenBalanceUniform = toUniform(
                tokenInfos[strategyToSupportedTokenIndexMap[i]].balance,
                strategyToken
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
                    balancesPendingAllocationToStrategy[i] += tokenInfos[strategyToSupportedTokenIndexMap[i]].balance;
                    // tokenInfos[strategyToSupportedTokenIndexMap[i]].balance = 0; CAREFUL!!! optimisation, works only with the following flag
                    tokenInfos[strategyToSupportedTokenIndexMap[i]].insufficientBalance = true;
                } else {
                    // !!!IMPORTANT: reduce total in batch by desiredStrategyBalance in real tokens
                    // converted back to uniform tokens instead of using desiredStrategyBalanceUniform
                    // because desiredStrategyBalanceUniform is a virtual value
                    // that could mismatch the real token number
                    // Example: here can be desiredStrategyBalanceUniform = 333333333333333333 (10**18 decimals)
                    // while real value desiredStrategyBalance = 33333333 (10**8 real token precision)
                    // we should subtract 333333330000000000
                    uint256 desiredStrategyBalance = fromUniform(desiredStrategyBalanceUniform, strategyToken);
                    totalBatchUnallocatedTokens -= toUniform(desiredStrategyBalance, strategyToken);
                    tokenInfos[strategyToSupportedTokenIndexMap[i]].balance -= desiredStrategyBalance;
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
                uint256 strategyWeightFulfilled = strategies[i].weight * batchTokenBalanceUniform
                    / desiredStrategyBalanceUniform;
                remainingToAllocateStrategiesWeightSum -= strategyWeightFulfilled;
                strategies[i].weight -= strategyWeightFulfilled;

                totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                balancesPendingAllocationToStrategy[i] += tokenInfos[strategyToSupportedTokenIndexMap[i]].balance;
                // tokenInfos[strategyToSupportedTokenIndexMap[i]].balance = 0; CAREFUL!!! optimisation, works only with the following flag
                tokenInfos[strategyToSupportedTokenIndexMap[i]].insufficientBalance = true;
            }
        }

        // if everything was rebalanced already then remainingToAllocateStrategiesWeightSum == 0, spare cycles
        if (remainingToAllocateStrategiesWeightSum > 0) {
            for (uint256 i; i < strategies.length; i++) {
                // necessary check as some strategies that go last could saturated on the previous step already
                if (remainingToAllocateStrategiesWeightSum == 0) {
                    break;
                }

                uint256 desiredStrategyBalanceUniform = totalBatchUnallocatedTokens * strategies[i].weight
                    / remainingToAllocateStrategiesWeightSum;
                remainingToAllocateStrategiesWeightSum -= strategies[i].weight;

                if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                    continue;
                }

                address strategyToken = strategies[i].depositToken;
                for (uint256 j; j < tokenInfos.length; j++) {
                    if (j == strategyToSupportedTokenIndexMap[i]) {
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
                            // tokenInfos[j].balance = 0; CAREFUL!!! optimisation, works only with the following flag
                            tokenInfos[j].insufficientBalance = true;
                        } else {
                            // !!!IMPORTANT: reduce total in batch by desiredStrategyBalance in real tokens
                            // converted back to uniform tokens instead of using desiredStrategyBalanceUniform
                            // because desiredStrategyBalanceUniform is a virtual value
                            // that could mismatch the real token number
                            // Example: here can be desiredStrategyBalanceUniform = 333333333333333333 (10**18 decimals)
                            // while real value desiredStrategyBalance = 33333333 (10**8 real token precision)
                            // we should subtract 333333330000000000
                            toSell = fromUniform(desiredStrategyBalanceUniform, tokenInfos[j].tokenAddress);
                            totalBatchUnallocatedTokens -= toUniform(toSell, tokenInfos[j].tokenAddress);
                            desiredStrategyBalanceUniform = 0;
                            tokenInfos[j].balance -= toSell;
                        }
                    } else {
                        totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                        toSell = tokenInfos[j].balance;
                        desiredStrategyBalanceUniform -= batchTokenBalanceUniform;
                        // tokenInfos[j].balance = 0; CAREFUL!!! optimisation, works only with the following flag
                        tokenInfos[j].insufficientBalance = true;
                    }

                    balancesPendingAllocationToStrategy[i] += _trySwap(toSell, tokenInfos[j].tokenAddress, strategyToken);

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
    function setSupportedToken(address tokenAddress, bool supported) external onlyStrategyRouter {
        // attempt to check that token address is valid
        if (!oracle.isTokenSupported(tokenAddress)) {
            revert InvalidToken();
        }
        if (supported && supportsToken(tokenAddress)) revert AlreadySupportedToken();

        if (supported) {
            supportedTokens.add(tokenAddress);
        } else {
            uint8 len = uint8(router.getStrategiesCount());
            // don't remove tokens that are in use by active strategies
            for (uint256 i = 0; i < len; i++) {
                if (router.getStrategyDepositToken(i) == tokenAddress) {
                    revert CantRemoveTokenOfActiveStrategy();
                }
            }
            supportedTokens.remove(tokenAddress);
        }
    }

    // Internals

    /// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
    function changeDecimals(
        uint256 amount,
        uint8 oldDecimals,
        uint8 newDecimals
    ) private pure returns (uint256) {
        if (oldDecimals < newDecimals) {
            return amount * (10**(newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10**(oldDecimals - newDecimals));
        }
        return amount;
    }

    /// @dev Swap tokens if they are different (i.e. not the same token)
    function _trySwap(
        uint256 amount, // tokenFromAmount
        address from, // tokenFrom
        address to // tokenTo
    ) private returns (uint256 result) {
        if (from != to) {
            IERC20(from).safeTransfer(address(exchange), amount);
            result = exchange.swap(amount, from, to, address(this));
            return result;
        }
        return amount;
    }

    /// @dev Change decimal places from token decimals to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address token) private view returns (uint256) {
        return changeDecimals(amount, ERC20(token).decimals(), UNIFORM_DECIMALS);
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address token) private view returns (uint256) {
        return changeDecimals(amount, UNIFORM_DECIMALS, ERC20(token).decimals());
    }

    /// @notice calculate deposit fee in USD
    /// @param amountInUsd Amount tokens in USD with `UNIFORM_DECIMALS`.
    /// @dev returns fee amount of tokens in USD.
    function calculateDepositFee(uint256 amountInUsd)
        internal
        view
        returns (uint256 feeAmountInUsd)
    {
        DepositFeeSettings memory _depositFeeSettings = depositFeeSettings;

        feeAmountInUsd = amountInUsd * _depositFeeSettings.feeInBps / MAX_BPS;

        // check ranges and apply needed fee limits
        if (feeAmountInUsd < _depositFeeSettings.minFeeInUsd) feeAmountInUsd = _depositFeeSettings.minFeeInUsd;
        else if (feeAmountInUsd > _depositFeeSettings.maxFeeInUsd) feeAmountInUsd = _depositFeeSettings.maxFeeInUsd;

    }
}
