//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./ReceiptNFT.sol";
import "./Exchange.sol";
import "./SharesToken.sol";
import "./EnumerableSetExtension.sol";
import "./interfaces/IUsdOracle.sol";

import "hardhat/console.sol";

contract Batching is Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSetExtension for EnumerableSet.AddressSet;

    /// @notice Fires when user deposits in batching.
    /// @param token Supported token that user want to deposit.
    /// @param amount Amount of `token` transferred from user.
    event Deposit(address indexed user, address token, uint256 amount);
    /// @notice Fires when user withdraw from batching.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromBatching(
        address indexed user,
        address token,
        uint256 amount
    );

    /* ERRORS */

    error AlreadyAddedStablecoin();
    error CantRemoveTokenOfActiveStrategy();
    error UnsupportedStablecoin();
    error NotReceiptOwner();
    error CycleNotClosed();
    error CycleClosed();
    error InsufficientShares();
    error DuplicateStrategy();
    error NotCallableByContracts();
    error CycleNotClosableYet();
    error DepositUnderMinimum();
    error BadPercent();
    error AmountNotSpecified();
    error PleaseWithdrawFromBatching();
    error NotEnoughInBatching();
    error CantRemoveLastStrategy();
    error NothingToRebalance();

    uint8 public constant UNIFORM_DECIMALS = 18;
    // used in rebalance function
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17; // UNIFORM_DECIMALS, so 1e17 == 0.1

    uint256 public minDeposit;
    // uint256 public totalTokens;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    SharesToken public sharesToken;
    StrategyRouter public router;
    IUsdOracle public oracle;

    EnumerableSet.AddressSet private stablecoins;

    constructor() {}

    function init(
        StrategyRouter _router,
        Exchange _exchange,
        SharesToken _sharesToken,
        ReceiptNFT _receiptContract
    ) public onlyOwner {
        if (address(router) != address(0)) revert();
        router = _router;
        exchange = _exchange;
        sharesToken = _sharesToken;
        receiptContract = _receiptContract;
    }

    // Universal Functions

    function supportsCoin(address stablecoinAddress)
        public
        view
        returns (bool)
    {
        return stablecoins.contains(stablecoinAddress);
    }

    /// @dev Returns list of supported stablecoins.
    function viewStablecoins() public view returns (address[] memory) {
        return stablecoins.values();
    }

    function viewBatchingValue()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](stablecoins.length());
        for (uint256 i; i < balances.length; i++) {
            address token = stablecoins.at(i);
            uint256 balance = ERC20(token).balanceOf(address(this));
            balance = toUniform(balance, token);

            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                token
            );
            balance = ((balance * price) / 10**priceDecimals);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    /// @notice Returns token balances and their sum in the batching.
    /// @notice Shows total batching balance, possibly not total to be deposited into strategies.
    ///         because strategies might not take all token supported by router.
    /// @notice All returned amounts have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total tokens in the batching.
    /// @return balances Array of token balances in the batching.
    function viewBatchingBalance()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](stablecoins.length());
        for (uint256 i; i < balances.length; i++) {
            address token = stablecoins.at(i);
            uint256 balance = ERC20(token).balanceOf(address(this));
            balance = toUniform(balance, token);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    // User Functions

    /// @notice Withdraw from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Uniform amount from receipt to withdraw, only for current cycle. Put max uint to withdraw all.
    /// @dev Only callable by user wallets.
    function withdrawFromBatching(
        address msgSender,
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 amount
    ) public onlyOwner returns (uint256 withdrawnUniform) {
        console.log("~~~~~~~~~~~~~ withdrawFromBatching ~~~~~~~~~~~~~");

        if (amount == 0) revert AmountNotSpecified();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 _currentCycleId = router.currentCycleId();
        uint256 toWithdraw;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != msgSender)
                revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            // only for receipts in batching
            if (receipt.cycleId != _currentCycleId) revert CycleClosed();

            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                receipt.token
            );
            if (amount >= receipt.amount) {
                toWithdraw += ((receipt.amount * price) / 10**priceDecimals);
                amount -= receipt.amount;
                receiptContract.burn(receiptId);
            } else {
                toWithdraw += ((amount * price) / 10**priceDecimals);
                receiptContract.setAmount(receiptId, receipt.amount - amount);
                amount = 0;
            }
            if (amount == 0) break;
        }
        console.log("toWithdraw", toWithdraw);
        _withdrawFromBatchingOracle(msgSender, toWithdraw, withdrawToken);
        return toWithdraw;
    }

    function _withdrawFromBatchingOracle(
        address msgSender,
        uint256 amount,
        address withdrawToken
    ) public onlyOwner returns (uint256 withdrawnUniform) {
        (uint256 totalBalance, uint256[] memory balances) = viewBatchingValue();
        // console.log("total %s, amount %s", totalBalance, amount);
        if (totalBalance < amount) revert NotEnoughInBatching();
        // totalTokens -= amount;
        withdrawnUniform = amount;

        uint256 amountToTransfer;
        // try withdraw requested token directly
        if (balances[stablecoins.indexOf(withdrawToken)] >= amount) {
            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                withdrawToken
            );
            amountToTransfer = (amount * 10**priceDecimals) / price;
            amountToTransfer = fromUniform(amountToTransfer, withdrawToken);
            amount = 0;
        }

        // try withdraw token which balance is enough to do only 1 swap
        if(amount != 0) {

            for (uint256 i; i < balances.length; i++) {
                if(balances[i] >= amount) {
                    address token = stablecoins.at(i);
                    (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                        token
                    );
                    amountToTransfer = (amount * 10**priceDecimals) / price;
                    amountToTransfer = fromUniform(amountToTransfer, token);
                    amountToTransfer = _trySwap(amountToTransfer, token, withdrawToken);
                    amount = 0;
                    break;
                }
            }
        }

        // swap different tokens until withraw amount is fulfilled
        if(amount != 0) {
            for (uint256 i; i < balances.length; i++) {
                address token = stablecoins.at(i);
                uint256 toSwap;
                if (balances[i] < amount) {
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getAssetUsdPrice(token);

                    // convert usd value into token amount
                    toSwap = (balances[i] * 10**priceDecimals) / price;
                    // adjust decimals of the token amount
                    toSwap = fromUniform(toSwap, token);
                    // swap for requested token
                    amountToTransfer += _trySwap(
                        toSwap,
                        token,
                        withdrawToken
                    );
                    // reduce total withdraw usd value
                    amount -= balances[i];
                    balances[i] = 0;
                } else {
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getAssetUsdPrice(token);
                    // convert usd value into token amount
                    toSwap = (amount * 10**priceDecimals) / price;
                    // adjust decimals of the token amount
                    toSwap = fromUniform(toSwap, token);
                    // swap for requested token
                    amountToTransfer += _trySwap(
                        toSwap,
                        token,
                        withdrawToken
                    );
                    amount = 0;
                    break;
                }
            }
        }
        IERC20(withdrawToken).transfer(msgSender, amountToTransfer);
    }

    function _withdrawFromBatching(
        address msgSender,
        uint256 amount,
        address withdrawToken
    ) public onlyOwner returns (uint256 withdrawnUniform) {
        (
            uint256 totalBalance,
            uint256[] memory balances
        ) = viewBatchingBalance();
        // console.log("total %s, amount %s", totalBalance, amount);
        if (totalBalance < amount) revert NotEnoughInBatching();
        // totalTokens -= amount;
        withdrawnUniform = amount;

        uint256 amountToTransfer;
        uint256 withdrawTokenBalance = ERC20(withdrawToken).balanceOf(
            address(this)
        );
        if (withdrawTokenBalance >= amount) {
            amountToTransfer = fromUniform(amount, withdrawToken);
        } else {
            // uint256 len = strategies.length;
            for (uint256 i; i < balances.length; i++) {
                address token = stablecoins.at(i);
                // split withdraw amount proportionally between strategies
                uint256 amountWithdraw = (amount * balances[i]) / totalBalance;
                amountWithdraw = fromUniform(amountWithdraw, token);

                // swap strategies tokens to withdraw token
                amountWithdraw = _trySwap(amountWithdraw, token, withdrawToken);
                amountToTransfer += amountWithdraw;
            }
        }
        // cycles[currentCycleId].totalInBatch -= amount;
        IERC20(withdrawToken).transfer(msgSender, amountToTransfer);
    }

    /// @notice Deposit stablecoin into batching.
    /// @notice Tokens not deposited into strategies immediately.
    /// @param depositToken Supported stablecoin to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function depositToBatch(
        address msgSender,
        address depositToken,
        uint256 _amount
    ) external onlyOwner {
        if (!supportsCoin(depositToken)) revert UnsupportedStablecoin();
        if (fromUniform(minDeposit, depositToken) > _amount)
            revert DepositUnderMinimum();

        // console.log("~~~~~~~~~~~~~ depositToBatch ~~~~~~~~~~~~~");

        uint256 amountUniform = toUniform(_amount, depositToken);

        emit Deposit(msgSender, depositToken, _amount);
        receiptContract.mint(
            router.currentCycleId(),
            amountUniform,
            depositToken,
            msgSender
        );
    }

    function transfer(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        ERC20(token).transfer(to, amount);
    }

    // Admin functions

    /// @notice Set address of oracle contract.
    /// @dev Admin function.
    function setOracle(IUsdOracle _oracle) external onlyOwner {
        oracle = _oracle;
    }

    /// @notice Set address of exchange contract.
    /// @dev Admin function.
    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
    }

    /// @notice Minimum to be deposited in the batching.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinDeposit(uint256 amount) external onlyOwner {
        minDeposit = amount;
    }

    /// @notice Rebalance batching, so that token balances will match strategies weight.
    /// @return totalDeposit Total batching balance to be deposited into strategies with uniform decimals.
    /// @return balances Amounts to be deposited in strategies, balanced according to strategies weights.
    function rebalanceBatching()
        public
        onlyOwner
        returns (uint256 totalDeposit, uint256[] memory balances)
    {
        // console.log("~~~~~~~~~~~~~ rebalance batching ~~~~~~~~~~~~~");

        uint256 totalInBatch;

        uint256 lenStables = stablecoins.length();
        address[] memory _tokens = new address[](lenStables);
        uint256[] memory _balances = new uint256[](lenStables);

        for (uint256 i; i < lenStables; i++) {
            _tokens[i] = stablecoins.at(i);
            _balances[i] = ERC20(_tokens[i]).balanceOf(address(this));

            totalInBatch += toUniform(_balances[i], _tokens[i]);
        }

        uint256 lenStrats = router.viewStrategiesCount();

        uint256[] memory _strategiesBalances = new uint256[](
            lenStrats + lenStables
        );
        for (uint256 i; i < lenStrats; i++) {
            address depositToken = router.viewStrategyDepositToken(i);
            for (uint256 j; j < lenStables; j++) {
                if (depositToken == _tokens[j] && _balances[j] > 0) {
                    _strategiesBalances[i] = _balances[j];
                    _balances[j] = 0;
                    break;
                } else if (
                    depositToken == _tokens[j] /* && _balances[j] == 0 */
                ) {
                    break;
                }
            }
        }

        for (uint256 i = lenStrats; i < _strategiesBalances.length; i++) {
            _strategiesBalances[i] = _balances[i - lenStrats];
        }

        uint256[] memory toAdd = new uint256[](lenStrats);
        uint256[] memory toSell = new uint256[](_strategiesBalances.length);
        for (uint256 i; i < lenStrats; ) {
            uint256 desiredBalance = (totalInBatch *
                router.viewStrategyPercentWeight(i)) / 1e18;
            desiredBalance = fromUniform(
                desiredBalance,
                router.viewStrategyDepositToken(i)
            );
            unchecked {
                if (desiredBalance > _strategiesBalances[i]) {
                    toAdd[i] = desiredBalance - _strategiesBalances[i];
                } else if (desiredBalance < _strategiesBalances[i]) {
                    toSell[i] = _strategiesBalances[i] - desiredBalance;
                }
                i++;
            }
        }

        for (uint256 i = lenStrats; i < _strategiesBalances.length; i++) {
            toSell[i] = _strategiesBalances[i];
        }

        for (uint256 i; i < _strategiesBalances.length; i++) {
            for (uint256 j; j < lenStrats; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    uint256 curSell = toSell[i] > toAdd[j]
                        ? toAdd[j]
                        : toSell[i];

                    address sellToken = i > lenStrats - 1
                        ? _tokens[i - lenStrats]
                        : router.viewStrategyDepositToken(i);

                    // its not worth to swap too small amounts
                    if (
                        toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD
                    ) {
                        unchecked {
                            toSell[i] = 0;
                            toAdd[j] -= curSell;
                        }
                        break;
                    }
                    address buyToken = router.viewStrategyDepositToken(j);
                    uint256 received = _trySwap(curSell, sellToken, buyToken);

                    _strategiesBalances[i] -= curSell;
                    _strategiesBalances[j] += received;
                    unchecked {
                        toSell[i] -= curSell;
                        toAdd[j] -= curSell;
                    }
                }
            }
        }

        _balances = new uint256[](lenStrats);
        for (uint256 i; i < lenStrats; i++) {
            _balances[i] = _strategiesBalances[i];
            totalDeposit += toUniform(
                _balances[i],
                router.viewStrategyDepositToken(i)
            );
        }

        return (totalDeposit, _balances);
    }

    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function setSupportedStablecoin(address tokenAddress, bool supported)
        external
        onlyOwner
    {
        if (supported && supportsCoin(tokenAddress))
            revert AlreadyAddedStablecoin();

        if (supported) {
            stablecoins.add(tokenAddress);
        } else {
            uint8 len = uint8(router.viewStrategiesCount());
            // shouldn't disallow tokens that are in use by active strategies
            for (uint256 i = 0; i < len; i++) {
                if (router.viewStrategyDepositToken(i) == tokenAddress) {
                    revert CantRemoveTokenOfActiveStrategy();
                }
            }
            stablecoins.remove(tokenAddress);
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
        uint256 amount,
        address from,
        address to
    ) private returns (uint256 result) {
        if (from != to) {
            IERC20(from).transfer(address(exchange), amount);
            result = exchange.swapRouted(
                amount,
                IERC20(from),
                IERC20(to),
                address(this)
            );
            // console.log("swapped amount %s, got %s", amount, result);
            return result;
        }
        return amount;
    }

    /// @dev Change decimal places to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address token)
        private
        view
        returns (uint256)
    {
        return
            changeDecimals(amount, ERC20(token).decimals(), UNIFORM_DECIMALS);
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address token)
        private
        view
        returns (uint256)
    {
        return
            changeDecimals(amount, UNIFORM_DECIMALS, ERC20(token).decimals());
    }
}
