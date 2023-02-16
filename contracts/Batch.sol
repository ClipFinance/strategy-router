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

import "hardhat/console.sol";

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
        uint256 totalInBatch;

        // point 1
        TokenInfo[] memory tokenInfos = new TokenInfo[](supportedTokens.length());

        // point 2
        for (uint256 i; i < tokenInfos.length; i++) {
            tokenInfos[i].tokenAddress = supportedTokens.at(i);
            tokenInfos[i].balance = ERC20(tokenInfos[i].tokenAddress).balanceOf(address(this));
//            _tokens[i] = supportedTokens.at(i);
//            _tokens[i] = supportedTokens.at(i);
//            _balances[i] = ERC20(_tokens[i]).balanceOf(address(this));

            // point 3
            totalInBatch += toUniform(
                tokenInfos[i].balance,
                tokenInfos[i].tokenAddress
            );
        }
        console.log('totalInBatch', totalInBatch);

        // temporal solution, rework in a separate PR
        StrategyRouter.StrategyInfo[] memory strategies = router.getStrategies();
//        uint256 strategiesLength = strategies.length;
        uint totalStrategyWeight;
        for (uint i; i < strategies.length; i++) {
            totalStrategyWeight += strategies[i].weight;
        }

        balances = new uint256[](strategies.length);
//        uint256[] memory desiredBalancesUniform = new uint256[](strategies.length);
        uint256[] memory strategySupportedTokenIndexes = new uint256[](strategies.length);
        for (uint256 i; i < strategies.length; i++) {
            if (totalStrategyWeight == 0) {
                break;
            }
            address strategyToken = strategies[i].depositToken;
            uint256 desiredBalanceUniform = totalInBatch * strategies[i].weight / totalStrategyWeight;

            console.log('===========');
            console.log('totalInBatch', totalInBatch);
            console.log('strategies[i].weight', i, strategies[i].weight);
            console.log('totalStrategyWeight', totalStrategyWeight);
            console.log('desiredBalanceUniform', desiredBalanceUniform);
            console.log('router.getStrategyPercentWeight(i)', i, router.getStrategyPercentWeight(i));
            if (desiredBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                continue;
            }
            uint256 desiredBalance = fromUniform(desiredBalanceUniform, strategyToken);
            for (uint256 j; j < tokenInfos.length; j++) {
                if (strategyToken == tokenInfos[j].tokenAddress) {
                    strategySupportedTokenIndexes[i] = j;
                    break;
                }
            }

            uint256 tokenBalanceUniform = toUniform(tokenInfos[strategySupportedTokenIndexes[i]].balance, strategyToken);
            if (tokenBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                console.log('tokenBalanceUniform', tokenBalanceUniform);
                console.log('desiredBalanceUniform', i, desiredBalanceUniform);
                console.log('tokenInfos[strategySupportedTokenIndexes[i]].balance', i, strategySupportedTokenIndexes[i], tokenInfos[strategySupportedTokenIndexes[i]].balance);
                console.log('desiredBalance', desiredBalance);
                if (tokenBalanceUniform >= desiredBalanceUniform) {
                    totalStrategyWeight -= strategies[i].weight;
                    strategies[i].weight = 0;
                    // manipulation to avoid leaving dust
                    if (tokenBalanceUniform - desiredBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                        totalInBatch -= tokenBalanceUniform;
                        balances[i] += tokenInfos[strategySupportedTokenIndexes[i]].balance;
                        desiredBalance = 0;
                        desiredBalanceUniform = 0;
                        tokenInfos[strategySupportedTokenIndexes[i]].balance = 0;
                    } else {
                        totalInBatch -= toUniform(desiredBalance, strategyToken);
                        tokenInfos[strategySupportedTokenIndexes[i]].balance -= desiredBalance;
                        balances[i] += desiredBalance;
                        desiredBalance = 0;
                        desiredBalanceUniform = 0;
                    }
                } else {
                    uint256 strategyWeightFulfillment = strategies[i].weight * tokenBalanceUniform / desiredBalanceUniform;
                    totalStrategyWeight -= strategyWeightFulfillment;
                    strategies[i].weight -= strategyWeightFulfillment;

                    totalInBatch -= tokenBalanceUniform;
                    balances[i] += tokenInfos[strategySupportedTokenIndexes[i]].balance;
                    desiredBalance -= tokenInfos[strategySupportedTokenIndexes[i]].balance;
                    desiredBalanceUniform -= tokenBalanceUniform;
                    tokenInfos[strategySupportedTokenIndexes[i]].balance = 0;
                }
            }
            console.log('totalInBatch after manipulation', totalInBatch);
            console.log('desiredBalance', desiredBalance);
            console.log('desiredBalanceUniform', desiredBalanceUniform);

            console.log('balances[i]', i, balances[i]);
        }

        console.log('===========');
        console.log('SWAP SECTION');
        console.log('===========');
        if (totalStrategyWeight > 0) {
            for (uint256 i; i < strategies.length; i++) {
                if (totalStrategyWeight == 0) {
                    break;
                }
                uint256 desiredBalanceUniform = totalInBatch * strategies[i].weight / totalStrategyWeight;
                console.log('===========');
                console.log('desiredBalanceUniform', desiredBalanceUniform);
                console.log('totalInBatch', totalInBatch);
                console.log('strategies[i].weight', i, strategies[i].weight);
                console.log('totalStrategyWeight', totalStrategyWeight);

                totalStrategyWeight -= strategies[i].weight;

                if (desiredBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                    address strategyToken = strategies[i].depositToken;
                    uint256 desiredBalance = fromUniform(desiredBalanceUniform, strategyToken);
                    for (uint256 j; j < tokenInfos.length; j++) {
                        if (j == strategySupportedTokenIndexes[i]) {
                            continue;
                        }

                        uint256 tokenBalanceUniform = toUniform(tokenInfos[j].balance, tokenInfos[j].tokenAddress);
                        console.log('tokenBalanceUniform', tokenBalanceUniform);
                        if (tokenBalanceUniform > REBALANCE_SWAP_THRESHOLD) {
                            uint256 toSell;
                            if (tokenBalanceUniform >= desiredBalanceUniform) {
                                // manipulation to avoid leaving dust
                                if (tokenBalanceUniform - desiredBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                                    totalInBatch -= tokenBalanceUniform;
                                    toSell = tokenInfos[j].balance;
                                    desiredBalance = 0;
                                    desiredBalanceUniform = 0;
                                    tokenInfos[j].balance = 0;
                                } else {
                                    toSell = fromUniform(desiredBalanceUniform, tokenInfos[j].tokenAddress);
                                    totalInBatch -= toUniform(toSell, tokenInfos[j].tokenAddress);
                                    desiredBalance = 0;
                                    desiredBalanceUniform = 0;
                                    tokenInfos[j].balance -= toSell;
                                }
                            } else {
                                totalInBatch -= tokenBalanceUniform;
                                toSell = tokenInfos[j].balance;
                                desiredBalance -= fromUniform(tokenBalanceUniform, strategyToken);
                                desiredBalanceUniform -= tokenBalanceUniform;
                                tokenInfos[j].balance = 0;
                            }
                            console.log('totalInBatch after manipulation', totalInBatch);
                            console.log('tokenBalanceUniform', tokenBalanceUniform);
                            console.log('desiredBalanceUniform', desiredBalanceUniform);
                            console.log('toSell', toSell);

                            balances[i] += _trySwap(toSell, tokenInfos[j].tokenAddress, strategyToken);

                            if (desiredBalanceUniform <= REBALANCE_SWAP_THRESHOLD) {
                                break;
                            }
                        }
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
