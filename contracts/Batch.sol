//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

//import "hardhat/console.sol";

/// @notice This contract contains batch related code, serves as part of StrategyRouter.
/// @notice This contract should be owned by StrategyRouter.
contract Batch is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSetExtension for EnumerableSet.AddressSet;

    /* ERRORS */

    error AlreadySupportedToken();
    error CantRemoveTokenOfActiveStrategy();
    error UnsupportedToken();
    error NotReceiptOwner();
    error CycleClosed();
    error DepositUnderMinimum();
    error NotEnoughBalanceInBatch();
    error CallerIsNotStrategyRouter();

    event SetAddresses(Exchange _exchange, IUsdOracle _oracle, StrategyRouter _router, ReceiptNFT _receiptNft);

    uint8 public constant UNIFORM_DECIMALS = 18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17;

    uint256 public minDeposit;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    StrategyRouter public router;
    IUsdOracle public oracle;

    EnumerableSet.AddressSet private supportedTokens;

    struct TokenInfo {
        address tokenAddress;
        uint256 balance;
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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

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
            uint256 balance = ERC20(token).balanceOf(address(this));

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(token);
            balance = ((balance * price) / 10**priceDecimals);
            balance = toUniform(balance, token);
            supportedTokenBalancesUsd[i] = balance;
            totalBalanceUsd += balance;
        }
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
            ERC20(receipt.token).transfer(receiptOwner, transferAmount);
            receiptContract.burn(receiptId);

            tokens[i] = receipt.token;
            withdrawnTokenAmounts[i] = transferAmount;
        }
        return (receiptIds, tokens, withdrawnTokenAmounts);
    }

    /// @notice converting token USD amount to token amount, i.e $1000 worth of token with price of $0.5 is 2000 tokens
    function calculateTokenAmountFromUsdAmount(uint256 valueUsd, address token)
        internal
        view
        returns (uint256 tokenAmountToTransfer)
    {
        (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(token);
        tokenAmountToTransfer = (valueUsd * 10**oraclePriceDecimals) / tokenUsdPrice;
        tokenAmountToTransfer = fromUniform(tokenAmountToTransfer, token);
    }

    /// @notice Deposit token into batch.
    /// @notice Tokens not deposited into strategies immediately.
    /// @param depositToken Supported token to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function deposit(
        address depositor,
        address depositToken,
        uint256 _amount,
        uint256 _currentCycleId
    ) external onlyStrategyRouter {
        if (!supportsToken(depositToken)) revert UnsupportedToken();
        (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(depositToken);
        uint256 depositedUsd = toUniform((_amount * price) / 10**priceDecimals, depositToken);
        if (minDeposit > depositedUsd) revert DepositUnderMinimum();

        uint256 amountUniform = toUniform(_amount, depositToken);

        receiptContract.mint(_currentCycleId, amountUniform, depositToken, depositor);
    }

    function transfer(
        address token,
        address to,
        uint256 amount
    ) external onlyStrategyRouter {
        ERC20(token).transfer(to, amount);
    }

    // Admin functions

    /// @notice Minimum to be deposited in the batch.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinDepositUsd(uint256 amount) external onlyStrategyRouter {
        minDeposit = amount;
    }

    function rebalance() public onlyStrategyRouter returns (uint256[] memory balances) {
        uint256 totalBatchUnallocatedTokens;

        // point 1
        TokenInfo[] memory tokenInfos = new TokenInfo[](supportedTokens.length());

        // point 2
        for (uint256 i; i < tokenInfos.length; i++) {
            tokenInfos[i].tokenAddress = supportedTokens.at(i);
            tokenInfos[i].balance = ERC20(tokenInfos[i].tokenAddress).balanceOf(address(this));

            // point 3
            totalBatchUnallocatedTokens += toUniform(
                tokenInfos[i].balance,
                tokenInfos[i].tokenAddress
            );
        }

        // temporal solution, rework in a separate PR
        (StrategyRouter.StrategyInfo[] memory strategies, uint256 totalStrategyWeight) = router.getStrategies();

        balances = new uint256[](strategies.length);
        uint256[] memory strategyToSupportedTokenIndexMap = new uint256[](strategies.length);
        // first traversal over strategies
        // 1. collect info: supported token index that corresponds to a strategy
        // 2. try to allocate funds to a strategy if a batch has balance in strategy's deposit token
        // that minimises swaps between tokens – prefer to put a token to strategy that natively support it
        for (uint256 i; i < strategies.length; i++) {
            // necessary check in assumption that some strategies could have 0 weight
            if (totalStrategyWeight == 0) {
                break;
            }
            address strategyToken = strategies[i].depositToken;
            uint256 desiredStrategyBalanceUniform = totalBatchUnallocatedTokens * strategies[i].weight / totalStrategyWeight;

            // nothing to deposit to this strategy
            if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            uint256 desiredStrategyBalance = fromUniform(desiredStrategyBalanceUniform, strategyToken);
            // figure out corresponding token index in supported tokens list
            // TODO corresponding token index in supported tokens list should be known upfront
            for (uint256 j; j < tokenInfos.length; j++) {
                if (strategyToken == tokenInfos[j].tokenAddress) {
                    strategyToSupportedTokenIndexMap[i] = j;
                    break;
                }
            }

            uint256 batchTokenBalanceUniform = toUniform(
                tokenInfos[strategyToSupportedTokenIndexMap[i]].balance,
                strategyToken
            );
            // if there anything to allocate to a strategy
            if (batchTokenBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                if (batchTokenBalanceUniform >= desiredStrategyBalanceUniform) {
                    // reduce weight of the current strategy in this iteration of rebalance to 0
                    totalStrategyWeight -= strategies[i].weight;
                    strategies[i].weight = 0;
                    // manipulation to avoid dust:
                    // if the case remaining balance of token is below allocation threshold –
                    // send it to the current strategy
                    if (batchTokenBalanceUniform - desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                        totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                        balances[i] += tokenInfos[strategyToSupportedTokenIndexMap[i]].balance;
                        desiredStrategyBalance = 0;
                        desiredStrategyBalanceUniform = 0;
                        tokenInfos[strategyToSupportedTokenIndexMap[i]].balance = 0;
                    } else {
                        // !!!IMPORTANT: reduce total in batch by desiredStrategyBalance in real tokens
                        // converted back to uniform tokens instead of using desiredStrategyBalanceUniform
                        // because desiredStrategyBalanceUniform is a virtual value
                        // that could mismatch the real token number
                        // Example: here can be desiredStrategyBalanceUniform = 333333333333333333 (10**18 decimals)
                        // while real value desiredStrategyBalance = 33333333 (10**8 real token precision)
                        // we should subtract 333333330000000000
                        totalBatchUnallocatedTokens -= toUniform(desiredStrategyBalance, strategyToken);
                        tokenInfos[strategyToSupportedTokenIndexMap[i]].balance -= desiredStrategyBalance;
                        balances[i] += desiredStrategyBalance;
                        desiredStrategyBalance = 0;
                        desiredStrategyBalanceUniform = 0;
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
                    totalStrategyWeight -= strategyWeightFulfilled;
                    strategies[i].weight -= strategyWeightFulfilled;

                    totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                    balances[i] += tokenInfos[strategyToSupportedTokenIndexMap[i]].balance;
                    desiredStrategyBalance -= tokenInfos[strategyToSupportedTokenIndexMap[i]].balance;
                    desiredStrategyBalanceUniform -= batchTokenBalanceUniform;
                    tokenInfos[strategyToSupportedTokenIndexMap[i]].balance = 0;
                }
            } else {
                totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
            }
        }

        // if everything was rebalanced already then totalStrategyWeight == 0, spare cycles
        if (totalStrategyWeight > 0) {
            for (uint256 i; i < strategies.length; i++) {
                // necessary check as some strategies that go last could saturated on the previous step already
                if (totalStrategyWeight == 0) {
                    break;
                }

                uint256 desiredStrategyBalanceUniform = totalBatchUnallocatedTokens * strategies[i].weight
                    / totalStrategyWeight;
                totalStrategyWeight -= strategies[i].weight;

                if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                    continue;
                }

                address strategyToken = strategies[i].depositToken;
                uint256 desiredStrategyBalance = fromUniform(desiredStrategyBalanceUniform, strategyToken);
                for (uint256 j; j < tokenInfos.length; j++) {
                    if (j == strategyToSupportedTokenIndexMap[i]) {
                        continue;
                    }

                    uint256 batchTokenBalanceUniform = toUniform(tokenInfos[j].balance, tokenInfos[j].tokenAddress);
                    // is there anything to allocate to a strategy
                    if (batchTokenBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                        uint256 toSell;
                        if (batchTokenBalanceUniform >= desiredStrategyBalanceUniform) {
                            // manipulation to avoid leaving dust
                            // if the case remaining balance of token is below allocation threshold –
                            // send it to the current strategy
                            if (batchTokenBalanceUniform - desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                                totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                                toSell = tokenInfos[j].balance;
                                desiredStrategyBalance = 0;
                                desiredStrategyBalanceUniform = 0;
                                tokenInfos[j].balance = 0;
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
                                desiredStrategyBalance = 0;
                                desiredStrategyBalanceUniform = 0;
                                tokenInfos[j].balance -= toSell;
                            }
                        } else {
                            totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                            toSell = tokenInfos[j].balance;
                            desiredStrategyBalance -= fromUniform(batchTokenBalanceUniform, strategyToken);
                            desiredStrategyBalanceUniform -= batchTokenBalanceUniform;
                            tokenInfos[j].balance = 0;
                        }

                        balances[i] += _trySwap(toSell, tokenInfos[j].tokenAddress, strategyToken);

                        // if remaining desired strategy amount is below the threshold then break the cycle
                        if (desiredStrategyBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                            break;
                        }
                    } else {
                        totalBatchUnallocatedTokens -= batchTokenBalanceUniform;
                    }
                }
            }
        }
    }

    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function setSupportedToken(address tokenAddress, bool supported) external onlyStrategyRouter {
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
            IERC20(from).transfer(address(exchange), amount);
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
}
