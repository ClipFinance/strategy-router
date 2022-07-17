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
import "./ReceiptNFT.sol";
import "./exchange/Exchange.sol";
import "./deps/EnumerableSetExtension.sol";
import "./interfaces/IUsdOracle.sol";

// import "hardhat/console.sol";

/// @notice This contract contains batching related code, serves as part of StrategyRouter.
/// @notice This contract should be owned by StrategyRouter.
contract Batching is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSetExtension for EnumerableSet.AddressSet;

    /* ERRORS */

    error AlreadySupportedToken();
    error CantRemoveTokenOfActiveStrategy();
    error UnsupportedToken();
    error NotReceiptOwner();
    error CycleClosed();
    error DepositUnderMinimum();
    error NotEnoughBalanceInBatching();
    error CallerIsNotStrategyRouter();

    /// @notice Fires when user withdraw from batching.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromBatching(address indexed user, address token, uint256 amount);
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

    function getBatchingValueUsd()
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

    /// @notice Withdraw tokens from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fulfills requested amount will be updated.
    /// @notice Receipt is burned if withdrawn is whole amount
    /// @param receiptIds Receipt NFTs ids.
    /// @param receiptTokenAmounts Amounts to withdraw from each passed receipt.
    /// @dev Only callable by user wallets.
    function withdrawExactTokens(
        address receiptOwner,
        uint256[] calldata receiptIds,
        uint256[] calldata receiptTokenAmounts,
        uint256 _currentCycleId
    ) public onlyStrategyRouter {
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != receiptOwner) revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(receiptId);

            // only for receipts in current batching
            if (receipt.cycleId != _currentCycleId) revert CycleClosed();
            (uint256 originalDepositedTokenPriceUsd, uint8 priceDecimals) = oracle.getTokenUsdPrice(receipt.token);

            /* higher token amount may be passed than in tokens in receipt as we expect javascript to handle big numbers
               not super precisely or face a floating bug. in that case we just withdraw full receipt amount. */
            if (receiptTokenAmounts[i] >= receipt.tokenAmountUniform || receiptTokenAmounts[i] == 0) {
                // withdraw whole receipt and burn receipt
                uint256 transferAmount = fromUniform(receipt.tokenAmountUniform, receipt.token);
                ERC20(receipt.token).transfer(receiptOwner, transferAmount);
                receiptContract.burn(receiptId);
                emit WithdrawFromBatching(msg.sender, receipt.token, transferAmount);
            } else {
                // withdraw only part of receipt and update receipt
                uint256 transferAmount = fromUniform(receiptTokenAmounts[i], receipt.token);
                ERC20(receipt.token).transfer(receiptOwner, transferAmount);
                receiptContract.setAmount(receiptId, receipt.tokenAmountUniform - receiptTokenAmounts[i]);
                emit WithdrawFromBatching(msg.sender, receipt.token, transferAmount);
            }
        }
    }

    /// @notice Withdraw tokens from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fulfills requested amount will be updated.
    /// @notice Receipt is burned if withdrawn is whole amount
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported token that user wishes to receive.
    /// @param receiptTokenAmounts Amounts to withdraw from each passed receipt.
    /// @dev Only callable by user wallets.
    function withdrawByUsdValue(
        address receiptOwner,
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256[] calldata receiptTokenAmounts,
        uint256 _currentCycleId
    ) public onlyStrategyRouter returns (uint256 withdrawalTokenAmountToTransfer) {
        if (!supportsToken(withdrawToken)) revert UnsupportedToken();

        uint256 valueToWithdrawUsd;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != receiptOwner) revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(receiptId);

            // only for receipts in current batching
            if (receipt.cycleId != _currentCycleId) revert CycleClosed();
            (uint256 originalDepositedTokenPriceUsd, uint8 priceDecimals) = oracle.getTokenUsdPrice(receipt.token);

            /* higher token amount may be passed than in tokens in receipt as we expect javascript to handle big numbers
               not super precisely or face a floating bug. in that case we just withdraw full receipt amount. */
            if (receiptTokenAmounts[i] >= receipt.tokenAmountUniform || receiptTokenAmounts[i] == 0) {
                // withdraw whole receipt and burn receipt
                uint256 receiptValueUsd = ((receipt.tokenAmountUniform * originalDepositedTokenPriceUsd) /
                    10**priceDecimals);
                valueToWithdrawUsd += receiptValueUsd;
                receiptContract.burn(receiptId);
            } else {
                // withdraw only part of receipt and update receipt
                uint256 tokenAmountValueUsd = ((receiptTokenAmounts[i] * originalDepositedTokenPriceUsd) /
                    10**priceDecimals);
                valueToWithdrawUsd += tokenAmountValueUsd;
                receiptContract.setAmount(receiptId, receipt.tokenAmountUniform - receiptTokenAmounts[i]);
            }
        }

        withdrawalTokenAmountToTransfer = _withdrawByUsdValue(valueToWithdrawUsd, withdrawToken);

        IERC20(withdrawToken).transfer(receiptOwner, withdrawalTokenAmountToTransfer);
    }

    function _withdrawByUsdValue(uint256 valueToWithdrawUsd, address withdrawToken) public onlyStrategyRouter returns (uint256) {
        (uint256 totalBalanceUsd, uint256[] memory supportedTokenBalancesUsd) = getBatchingValueUsd();
        if (totalBalanceUsd < valueToWithdrawUsd) revert NotEnoughBalanceInBatching();

        uint256 tokenAmountToTransfer; // final token amount to transfer to user from batching
        uint256 withdrawTokenIndex = supportedTokens.indexOf(withdrawToken);

        // try withdraw requested token directly where is more than enough of same token in batching
        if (supportedTokenBalancesUsd[withdrawTokenIndex] >= valueToWithdrawUsd) {
            tokenAmountToTransfer = convertUsdAmountToTokenAmount(valueToWithdrawUsd, withdrawToken);
            return tokenAmountToTransfer;
        } else {
            // not enough withdraw token in batching
            // deduct usd amount of withdraw token
            valueToWithdrawUsd -= supportedTokenBalancesUsd[withdrawTokenIndex];
            tokenAmountToTransfer = convertUsdAmountToTokenAmount(
                supportedTokenBalancesUsd[withdrawTokenIndex],
                withdrawToken
            );
        }

        uint256 tokenAmountToSwap;

        // find another token which balance is enough to withdraw with only 1 swap
        for (uint256 i; i < supportedTokenBalancesUsd.length; i++) {
            if (i == withdrawTokenIndex) continue; // skip withdraw token in order to avoid unnecessary swap
            if (supportedTokenBalancesUsd[i] >= valueToWithdrawUsd) {
                address supportedToken = supportedTokens.at(i);
                tokenAmountToSwap = convertUsdAmountToTokenAmount(valueToWithdrawUsd, supportedToken);
                tokenAmountToTransfer += _trySwap(tokenAmountToSwap, supportedToken, withdrawToken);
                return tokenAmountToTransfer;
            }
        }

        // otherwise swap different tokens until withdraw amount is fulfilled
        for (uint256 i; i < supportedTokenBalancesUsd.length; i++) {
            if (i == withdrawTokenIndex) continue;
            address token = supportedTokens.at(i);
            (uint256 tokenUsdPrice, uint8 priceDecimals) = oracle.getTokenUsdPrice(token);

            // guarantees that valueToWithdrawUsd will never be less than 0
            uint256 tokenValueUsdToSwap = supportedTokenBalancesUsd[i] < valueToWithdrawUsd
                ? supportedTokenBalancesUsd[i]
                : valueToWithdrawUsd;

            // above we checked for underflow, so we don't need to check here again for that
            unchecked {
                valueToWithdrawUsd -= tokenValueUsdToSwap;
            }
            // convert usd value into token amount
            tokenAmountToSwap = (tokenValueUsdToSwap * 10**priceDecimals) / tokenUsdPrice;
            // adjust decimals of the token amount
            tokenAmountToSwap = fromUniform(tokenAmountToSwap, token);
            // swap for requested token
            tokenAmountToTransfer += _trySwap(tokenAmountToSwap, token, withdrawToken);
            if (valueToWithdrawUsd == 0) break;
        }
        return tokenAmountToTransfer;
    }

    /// @notice converting token USD amount to token amount, i.e $1000 worth of token with price of $0.5 is 2000 tokens
    function convertUsdAmountToTokenAmount(uint256 valueUsd, address token)
        internal
        view
        returns (uint256 tokenAmountToTransfer)
    {
        (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(token);
        tokenAmountToTransfer = (valueUsd * 10**oraclePriceDecimals) / tokenUsdPrice;
        tokenAmountToTransfer = fromUniform(tokenAmountToTransfer, token);
    }

    /// @notice Deposit token into batching.
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

    /// @notice Minimum to be deposited in the batching.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinDeposit(uint256 amount) external onlyStrategyRouter {
        minDeposit = amount;
    }

    /// @notice Rebalance batching, so that token balances will match strategies weight.
    /// @return balances Amounts to be deposited in strategies, balanced according to strategies weights.
    function rebalance() public onlyStrategyRouter returns (uint256[] memory balances) {
        /*
        1 store supported-tokens (set of unique addresses)
            [a,b,c]
        2 store their balances
            [10, 6, 8]
        3 store their sum with uniform decimals
            24
        4 create array of length = supported_tokens + strategies_tokens (e.g. [a])
            [a, b, c] + [a] = 4
        5 store in that array balances from step 2, duplicated tokens should be ignored
            [10, 0, 6, 8] (instead of [10,10...] we got [10,0...] because first two are both token a)
        6a get desired balance for every strategy using their weights
            [12, 0, 4.8, 7.2] (our 1st strategy will get 50%, 2nd and 3rd will get 20% and 30% respectively)
        6b store amounts that we need to sell or buy for each balance in order to match desired balances
            toSell [0, 0, 1.2, 0.8]
            toBuy  [2, 0, 0, 0]
            these arrays contain amounts with tokens' original decimals
        7 now sell 'toSell' amounts of respective tokens for 'toBuy' tokens
            (token to amount connection is derived by index in the array)
            (also track new strategies balances for cases where 1 token is shared by multiple strategies)
        */
        uint256 totalInBatch;

        // point 1
        uint256 supportedTokensCount = supportedTokens.length();
        address[] memory _tokens = new address[](supportedTokensCount);
        uint256[] memory _balances = new uint256[](supportedTokensCount);

        // point 2
        for (uint256 i; i < supportedTokensCount; i++) {
            _tokens[i] = supportedTokens.at(i);
            _balances[i] = ERC20(_tokens[i]).balanceOf(address(this));

            // point 3
            totalInBatch += toUniform(_balances[i], _tokens[i]);
        }

        // point 4
        uint256 strategiesCount = router.getStrategiesCount();

        uint256[] memory _strategiesAndSupportedTokensBalances = new uint256[](strategiesCount + supportedTokensCount);

        // point 5
        // We fill in strategies balances with tokens that strategies are accepting and ignoring duplicates
        for (uint256 i; i < strategiesCount; i++) {
            address depositToken = router.getStrategyDepositToken(i);
            for (uint256 j; j < supportedTokensCount; j++) {
                if (depositToken == _tokens[j] && _balances[j] > 0) {
                    _strategiesAndSupportedTokensBalances[i] = _balances[j];
                    _balances[j] = 0;
                    break;
                }
            }
        }

        // we fill in strategies balances with balances of remaining tokens that are supported as deposits but are not
        // accepted in strategies
        for (uint256 i = strategiesCount; i < _strategiesAndSupportedTokensBalances.length; i++) {
            _strategiesAndSupportedTokensBalances[i] = _balances[i - strategiesCount];
        }

        // point 6a
        uint256[] memory toBuy = new uint256[](strategiesCount);
        uint256[] memory toSell = new uint256[](_strategiesAndSupportedTokensBalances.length);
        for (uint256 i; i < strategiesCount; i++) {
            uint256 desiredBalance = (totalInBatch * router.getStrategyPercentWeight(i)) / 1e18;
            desiredBalance = fromUniform(desiredBalance, router.getStrategyDepositToken(i));
            // we skip safemath check since we already do comparison in if clauses
            unchecked {
                // point 6b
                if (desiredBalance > _strategiesAndSupportedTokensBalances[i]) {
                    toBuy[i] = desiredBalance - _strategiesAndSupportedTokensBalances[i];
                } else if (desiredBalance < _strategiesAndSupportedTokensBalances[i]) {
                    toSell[i] = _strategiesAndSupportedTokensBalances[i] - desiredBalance;
                }
            }
        }

        // point 7
        // all tokens we accept to deposit but are not part of strategies therefore we are going to swap them
        // to tokens that strategies are accepting
        for (uint256 i = strategiesCount; i < _strategiesAndSupportedTokensBalances.length; i++) {
            toSell[i] = _strategiesAndSupportedTokensBalances[i];
        }

        for (uint256 i; i < _strategiesAndSupportedTokensBalances.length; i++) {
            for (uint256 j; j < strategiesCount; j++) {
                // if we are not going to buy this token (nothing to sell), we simply skip to the next one
                // if we can sell this token we go into swap routine
                // we proceed to swap routine if there is some tokens to buy and some tokens sell
                // if found which token to buy and which token to sell we proceed to swap routine
                if (toSell[i] > 0 && toBuy[j] > 0) {
                    // if toSell's 'i' greater than strats-1 (e.g. strats 2, tokens 2, i=2, 2>2-1==true)
                    // then take supported_token[2-2=0]
                    // otherwise take strategy_token[0 or 1]
                    address sellToken = i > strategiesCount - 1
                        ? _tokens[i - strategiesCount]
                        : router.getStrategyDepositToken(i);
                    address buyToken = router.getStrategyDepositToken(j);

                    uint256 toSellUniform = toUniform(toSell[i], sellToken);
                    uint256 toBuyUniform = toUniform(toBuy[j], buyToken);
                    /*
                    Weight of strategies is in token amount not usd equivalent
                    In case of stablecoin depeg an administrative decision will be made to move out of the strategy
                    that has exposure to depegged stablecoin.
                    curSell should have sellToken decimals
                    */
                    uint256 curSell = toSellUniform > toBuyUniform
                        ? changeDecimals(toBuyUniform, UNIFORM_DECIMALS, ERC20(sellToken).decimals())
                        : toSell[i];

                    // no need to swap small amounts
                    if (toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD) {
                        toSell[i] = 0;
                        toBuy[j] -= changeDecimals(curSell, ERC20(sellToken).decimals(), ERC20(buyToken).decimals());
                        break;
                    }
                    uint256 received = _trySwap(curSell, sellToken, buyToken);

                    _strategiesAndSupportedTokensBalances[i] -= curSell;
                    _strategiesAndSupportedTokensBalances[j] += received;
                    toSell[i] -= curSell;
                    toBuy[j] -= changeDecimals(curSell, ERC20(sellToken).decimals(), ERC20(buyToken).decimals());
                }
            }
        }

        _balances = new uint256[](strategiesCount);
        for (uint256 i; i < strategiesCount; i++) {
            _balances[i] = _strategiesAndSupportedTokensBalances[i];
        }

        return _balances;
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
