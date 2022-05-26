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

// import "hardhat/console.sol";

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
    error CycleClosed();
    error DepositUnderMinimum();
    error AmountNotSpecified();
    error NotEnoughInBatching();

    uint8 public constant UNIFORM_DECIMALS = 18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17;

    uint256 public minDeposit;

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

    // User Functions

    /// @notice Withdraw stablecoins from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount of USD to withdraw.
    /// @dev Only callable by user wallets.
    function withdrawFromBatching(
        address msgSender,
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 amount
    ) public onlyOwner {
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
            uint256 receiptValue = ((receipt.amount * price) /
                10**priceDecimals);
            if (amount >= receiptValue) {
                toWithdraw += receiptValue;
                amount -= receiptValue;
                receiptContract.burn(receiptId);
            } else {
                toWithdraw += amount;
                uint256 newReceiptAmount = (receipt.amount *
                    (receiptValue - amount)) / receiptValue;
                if (newReceiptAmount > 0)
                    receiptContract.setAmount(receiptId, newReceiptAmount);
                else receiptContract.burn(receiptId);
                amount = 0;
            }
            if (amount == 0) break;
        }
        _withdrawFromBatching(msgSender, toWithdraw, withdrawToken);
    }

    function _withdrawFromBatching(
        address msgSender,
        uint256 amount,
        address withdrawToken
    ) public onlyOwner {
        (uint256 totalBalance, uint256[] memory balances) = viewBatchingValue();
        if (totalBalance < amount) revert NotEnoughInBatching();

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
        if (amount != 0) {
            for (uint256 i; i < balances.length; i++) {
                if (balances[i] >= amount) {
                    address token = stablecoins.at(i);
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getAssetUsdPrice(token);
                    amountToTransfer = (amount * 10**priceDecimals) / price;
                    amountToTransfer = fromUniform(amountToTransfer, token);
                    amountToTransfer = _trySwap(
                        amountToTransfer,
                        token,
                        withdrawToken
                    );
                    amount = 0;
                    break;
                }
            }
        }

        // swap different tokens until withraw amount is fulfilled
        if (amount != 0) {
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
                    amountToTransfer += _trySwap(toSwap, token, withdrawToken);
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
                    amountToTransfer += _trySwap(toSwap, token, withdrawToken);
                    amount = 0;
                    break;
                }
            }
        }
        IERC20(withdrawToken).transfer(msgSender, amountToTransfer);
    }

    /// @notice Deposit stablecoin into batching.
    /// @notice Tokens not deposited into strategies immediately.
    /// @param depositToken Supported stablecoin to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function depositToBatch(
        address depositor,
        address depositToken,
        uint256 _amount
    ) external onlyOwner {
        if (!supportsCoin(depositToken)) revert UnsupportedStablecoin();
        if (fromUniform(minDeposit, depositToken) > _amount)
            revert DepositUnderMinimum();

        uint256 amountUniform = toUniform(_amount, depositToken);

        emit Deposit(depositor, depositToken, _amount);
        receiptContract.mint(
            router.currentCycleId(),
            amountUniform,
            depositToken,
            depositor
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
        /*
        1 store supported-stables (set of unique addrs)
            [a,b,c]
        2 store their balances
            [1,1,1]
        3 store their sum with uniform decimals
            3
        4 create array of length = supported_stables + strategeis_stables (e.g. [a])
            [a,b,c] + [a] = 4
        5 store in that array balances from step 2, duplicated tokens should be ignored
            [1, 0, 1, 1] (instead of [1,1...] we got [1,0...] because first two are both token a)
        6 get desired balance for every strategy using their weights
            [3] (our 1 strategy will get 100%)
        6 store amounts that we need to sell or buy for each balance in order to match desired balances
            toSell [0, 0, 1, 1] 
            toBuy  [2, 0, 0, 0] (here we have 1 strategy so it takes 100% weight)
            these arrays contain amounts with tokens' decimals
        7 now sell 'toSell' amounts of respective tokens for 'toBuy' tokens
            (token to amount connection is derived by index in the array)
            (also track new strategies balances for cases where 1 token is shared by multiple strategies)
    */
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
                }
            }
        }

        for (uint256 i = lenStrats; i < _strategiesBalances.length; i++) {
            _strategiesBalances[i] = _balances[i - lenStrats];
        }

        uint256[] memory toAdd = new uint256[](lenStrats);
        uint256[] memory toSell = new uint256[](_strategiesBalances.length);
        for (uint256 i; i < lenStrats; i++) {
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
            }
        }

        for (uint256 i = lenStrats; i < _strategiesBalances.length; i++) {
            toSell[i] = _strategiesBalances[i];
        }

        for (uint256 i; i < _strategiesBalances.length; i++) {
            for (uint256 j; j < lenStrats; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    // if toSell's 'i' greater than strats-1 (e.g. strats 2, stables 2, i=2, 2>2-1==true)
                    // then take supported_stablecoin[2-2=0]
                    // otherwise take strategy_stablecoin[0 or 1]
                    address sellToken = i > lenStrats - 1
                        ? _tokens[i - lenStrats]
                        : router.viewStrategyDepositToken(i);
                    address buyToken = router.viewStrategyDepositToken(j);

                    uint256 sellUniform = toUniform(toSell[i], sellToken);
                    uint256 addUniform = toUniform(toAdd[j], buyToken);
                    // curSell should have sellToken decimals
                    uint256 curSell = sellUniform > addUniform
                        ? changeDecimals(
                            addUniform,
                            UNIFORM_DECIMALS,
                            ERC20(sellToken).decimals()
                        )
                        : toSell[i];

                    // no need to swap small amounts
                    if (
                        toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD
                    ) {
                        toSell[i] = 0;
                        toAdd[j] -= changeDecimals(
                            curSell,
                            ERC20(sellToken).decimals(),
                            ERC20(buyToken).decimals()
                        );
                        break;
                    }
                    uint256 received = _trySwap(curSell, sellToken, buyToken);

                    _strategiesBalances[i] -= curSell;
                    _strategiesBalances[j] += received;
                    toSell[i] -= curSell;
                    toAdd[j] -= changeDecimals(
                        curSell,
                        ERC20(sellToken).decimals(),
                        ERC20(buyToken).decimals()
                    );
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
            // don't remove tokens that are in use by active strategies
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
