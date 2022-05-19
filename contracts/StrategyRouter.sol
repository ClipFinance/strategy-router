//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import "./ReceiptNFT.sol";
import "./Exchange.sol";
import "./SharesToken.sol";
import "./Batching.sol";

import "hardhat/console.sol";

contract StrategyRouter is Ownable {
    /* EVENTS */

    /// @notice Fires when user deposits in batching.
    /// @param token Supported token that user want to deposit.
    /// @param amount Amount of `token` transferred from user.
    event Deposit(address indexed user, address token, uint256 amount);
    /// @notice Fires when batching is deposited into strategies.
    /// @param closedCycleId Index of the cycle that is closed.
    /// @param amount Sum of different tokens deposited into strategies.
    event DepositToStrategies(uint256 indexed closedCycleId, uint256 amount);
    /// @notice Fires when user withdraw from batching.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromBatching(
        address indexed user,
        address token,
        uint256 amount
    );
    /// @notice Fires when user withdraw from strategies.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromStrategies(
        address indexed user,
        address token,
        uint256 amount
    );
    /// @notice Fires when user converts his receipt into shares token.
    /// @param receiptId Index of the receipt to burn.
    /// @param shares Amount of shares received by user.
    event UnlockShares(address indexed user, uint256 receiptId, uint256 shares);

    /* ERRORS */

    error UnsupportedStablecoin();
    error NotReceiptOwner();
    error CycleNotClosed();
    error CycleClosed();
    error InsufficientShares();
    error DuplicateStrategy();
    error NotCallableByContracts();
    error CycleNotClosableYet();
    error AmountNotSpecified();
    error PleaseWithdrawFromBatching();
    error CantRemoveLastStrategy();
    error NothingToRebalance();
    // error InitialSharesAreUnwithdrawable();

    /// @notice Restrict msg.sender to be externally owned accounts only.
    modifier OnlyEOW() {
        if (msg.sender != tx.origin) revert NotCallableByContracts();
        _;
    }

    struct StrategyInfo {
        address strategyAddress;
        address depositToken;
        uint256 weight;
    }

    struct Cycle {
        uint256 startAt;
        uint256 pricePerShare;
        // usd value transferred into strategies
        uint256 totalDeposited;
        // actual usd value received by strategies
        uint256 receivedByStrats;
        // cross withdrawn amount from batching by strategy receipt
        // TODO it has to be changed to work with new oracle logic
        uint256 stratsDebtInShares;
    }

    uint8 public constant UNIFORM_DECIMALS = 18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17; 
    uint256 public constant INITIAL_SHARES = 1e12;
    address private constant DEAD_ADDRESS =
        0x000000000000000000000000000000000000dEaD;

    uint256 public cycleDuration = 1 days;
    uint256 public minUsdPerCycle;
    uint256 public minDeposit;
    uint256 public feePercent;
    uint256 public currentCycleId;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    IUsdOracle public oracle;
    SharesToken public sharesToken;
    Batching public batching;
    address public feeAddress;

    StrategyInfo[] public strategies;
    mapping(uint256 => Cycle) public cycles;

    constructor() {
        receiptContract = new ReceiptNFT();
        sharesToken = new SharesToken();
        batching = new Batching();
        batching.init(
            StrategyRouter(address(this)),
            exchange,
            sharesToken,
            receiptContract
        );
        receiptContract.setManager(address(this));
        receiptContract.setManager(address(batching));
        cycles[0].startAt = block.timestamp;
    }

    // Universal Functions

    /// @notice Deposit money collected in the batching into strategies.
    /// @notice Can be called when `cycleDuration` seconds has been passed or
    ///         batch usd value has reached `minUsdPerCycle`.
    /// @dev Only callable by user wallets.
    function depositToStrategies() external OnlyEOW {
        console.log("~~~~~~~~~~~~~ depositToStrategies ~~~~~~~~~~~~~");
        uint256 _currentCycleId = currentCycleId;
        (uint256 totalValue, ) = viewBatchingValue();
        uint256 stratsDebtInShares = cycles[_currentCycleId]
            .stratsDebtInShares;
        uint256 stratsDebtValue;
        if(stratsDebtInShares > 0)
            stratsDebtValue = sharesToAmount(stratsDebtInShares);
        console.log("totalValue", totalValue);
        if (
            cycles[_currentCycleId].startAt + cycleDuration > block.timestamp &&
            totalValue+stratsDebtValue < minUsdPerCycle
        ) revert CycleNotClosableYet();

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // get total strategies value after compound
        (uint256 balanceAfterCompound, ) = viewStrategiesValue();
        // rebalance tokens in batching and get new balances
        (
            uint256 totalDepositUniform,
            uint256[] memory depositAmounts
        ) = batching.rebalanceBatching();

        uint256 totalValueDeposited;
        for (uint256 i; i < len; i++) {
            address strategyAssetAddress = strategies[i].depositToken;

            if (depositAmounts[i] > 0) {
                // calculate total usd deposited in strategies
                (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                    strategyAssetAddress
                );
                totalValueDeposited +=
                    (toUniform(depositAmounts[i], strategyAssetAddress) *
                        price) /
                    10**priceDecimals;
                console.log(depositAmounts[i]);

                // transfer tokens from batching into strategies
                batching.transfer(
                    strategyAssetAddress,
                    strategies[i].strategyAddress,
                    depositAmounts[i]
                );

                IStrategy(strategies[i].strategyAddress).deposit(
                    depositAmounts[i]
                );
            }
        }

        // get total strategies balance after deposit
        (uint256 balanceAfterDeposit, ) = viewStrategiesValue();
        uint256 receivedByStrats = balanceAfterDeposit - balanceAfterCompound;

        // receivedByStrats += stratsDebtValue;
        // balanceAfterCompound -= stratsDebtValue;

        console.log(
            balanceAfterCompound,
            balanceAfterDeposit,
            receivedByStrats,
            totalValueDeposited
        );

        uint256 totalShares = sharesToken.totalSupply();
        if (totalShares == 0) {
            sharesToken.mint(DEAD_ADDRESS, INITIAL_SHARES);
            cycles[_currentCycleId].pricePerShare =
                balanceAfterDeposit /
                sharesToken.totalSupply();
        } else {
            cycles[_currentCycleId].pricePerShare =
                balanceAfterCompound /
                totalShares;

            uint256 newShares = receivedByStrats /
                cycles[_currentCycleId].pricePerShare;
            console.log(
                "newShares, receivedByStrats",
                newShares,
                receivedByStrats
            );
            sharesToken.mint(address(this), newShares);
        }

        // console.log("receivedByStrats, totalDep", (receivedByStrats), cycles[_currentCycleId].totalDeposited , cycles[_currentCycleId].pricePerShare);
        cycles[_currentCycleId].receivedByStrats = receivedByStrats + stratsDebtValue;
        cycles[_currentCycleId].totalDeposited = totalValueDeposited + stratsDebtValue;

        emit DepositToStrategies(_currentCycleId, receivedByStrats);
        // start new cycle
        currentCycleId++;
        cycles[_currentCycleId + 1].startAt = block.timestamp;
    }

    /// @notice Compound all strategies.
    /// @dev Only callable by user wallets.
    function compoundAll() external OnlyEOW {
        if (sharesToken.totalSupply() == 0) revert();

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }
    }

    /// @dev Returns list of supported stablecoins.
    function viewStablecoins() public view returns (address[] memory) {
        return batching.viewStablecoins();
    }

    /// @dev Returns strategy weight as percent of total weight.
    function viewStrategyPercentWeight(uint256 _strategyId)
        public
        view
        returns (uint256 strategyPercentAllocation)
    {
        uint256 totalStrategyWeight;
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            totalStrategyWeight += strategies[i].weight;
        }
        strategyPercentAllocation =
            (strategies[_strategyId].weight * 1e18) /
            totalStrategyWeight;

        return strategyPercentAllocation;
    }

    /// @notice Returns count of strategies.
    function viewStrategiesCount() public view returns (uint256 count) {
        return strategies.length;
    }

    /// @notice Returns array of strategies.
    function viewStrategies() public view returns (StrategyInfo[] memory) {
        return strategies;
    }

    /// @notice Returns deposit token of the strategy.
    function viewStrategyDepositToken(uint256 i) public view returns (address) {
        return strategies[i].depositToken;
    }

    /// @notice Returns usd value of the token balances and their sum in the strategies.
    /// @notice All returned amounts have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total batching usd value.
    /// @return balances Array of usd value of token balances in the batching.
    function viewStrategiesValue()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](strategies.length);
        for (uint256 i; i < balances.length; i++) {
            address token = strategies[i].depositToken;
            uint256 balance = IStrategy(strategies[i].strategyAddress)
                .totalTokens();
            balance = toUniform(balance, token);
            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                token
            );
            balance = ((balance * price) / 10**priceDecimals);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    /// @notice Returns usd values of the tokens balances and their sum in the batching.
    /// @notice All returned amounts have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total batching usd value.
    /// @return balances Array of usd value of token balances in the batching.
    function viewBatchingValue()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        return batching.viewBatchingValue();
    }

    /// @notice Returns amount of shares locked by multiple receipts.
    /// @notice Cycle noted in receipts should be closed.
    function receiptsToShares(uint256[] calldata receiptIds)
        public
        view
        returns (uint256 shares)
    {
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            shares += receiptToShares(receiptId);
        }
    }

    /// @notice Returns usd value of shares.
    /// @dev Returned amount has `UNIFORM_DECIMALS` decimals.
    function sharesToAmount(uint256 shares)
        public
        view
        returns (uint256 amount)
    {
        (uint256 strategiesBalance, ) = viewStrategiesValue();
        uint256 currentPricePerShare = strategiesBalance /
            sharesToken.totalSupply();
        amount = shares * currentPricePerShare;
    }

    /// @notice Returns shares equivalent of the usd vulue.
    /// @dev Returned amount has `UNIFORM_DECIMALS` decimals.
    function amountToShares(uint256 amount)
        public
        view
        returns (uint256 shares)
    {
        (uint256 strategiesBalance, ) = viewStrategiesValue();
        uint256 currentPricePerShare = strategiesBalance /
            sharesToken.totalSupply();
        shares = amount / currentPricePerShare;
    }

    /// @notice Returns whether this stablecoin is supported.
    /// @param stablecoinAddress Address to lookup.
    function supportsCoin(address stablecoinAddress)
        public
        view
        returns (bool isSupported)
    {
        return batching.supportsCoin(stablecoinAddress);
    }

    // User Functions

    /// @notice Convert receipts into share tokens. Withdraw functions doing it internally.
    /// @notice Cycle noted in receipt should be closed.
    function unlockShares(uint256[] calldata receiptIds)
        public
        OnlyEOW
        returns (uint256 shares)
    {
        shares = _unlockShares(receiptIds);
        sharesToken.transfer(msg.sender, shares);
    }

    /// @notice Withdraw stablecoins from strategies while receipts are in strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice If not enough shares unlocked from receipt, more will be taken from user.
    /// @notice Receipts are burned.
    /// @param receiptIds ReceiptNFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param shares Amount of shares to withdraw.
    /// @dev Only callable by user wallets.
    function withdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 shares
    ) external OnlyEOW {
        // console.log("~~~~~~~~~~~~~ withdrawFromStrategies ~~~~~~~~~~~~~");

        if (shares == 0) revert AmountNotSpecified();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 unlockedShares = _unlockShares(receiptIds);

        if (unlockedShares > shares) {
            // leftover shares -> send to user
            sharesToken.transfer(msg.sender, unlockedShares - shares);
        } else if (unlockedShares < shares) {
            // lack of shares -> get from user
            sharesToken.routerTransferFrom(
                msg.sender,
                address(this),
                shares - unlockedShares
            );
        }

        // shares into usd using current PPS
        uint256 amountWithdraw = sharesToAmount(shares);
        console.log(
            shares,
            sharesToken.balanceOf(address(this)),
            unlockedShares,
            amountWithdraw
        );
        sharesToken.burn(address(this), shares);
        _withdrawFromStrategies(amountWithdraw, withdrawToken);
    }

    /// @notice Withdraw stablecoins from strategies while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds ReceiptNFT ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount of USD to withdraw.
    /// @dev Only callable by user wallets.
    function crossWithdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 amount
    ) public OnlyEOW {
        // console.log("~~~~~~~~~~~~~ crossWithdrawFromStrategies ~~~~~~~~~~~~~");
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();
        if (amount == 0) revert AmountNotSpecified();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 _currentCycleId = currentCycleId;
        // receipt in batching withdraws from strategies
        uint256 toWithdraw;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != msg.sender)
                revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            // only for receipts in batching
            if (receipt.cycleId != _currentCycleId) revert CycleClosed();
            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                receipt.token
            );
            uint256 receiptValue = ((receipt.amount * price) / 10**priceDecimals);
            if (amount >= receiptValue) {
                toWithdraw += receiptValue;
                amount -= receiptValue;
                receiptContract.burn(receiptId);
            } else {
                toWithdraw += amount;
                uint256 newReceiptAmount = receipt.amount * (receiptValue-amount) / receiptValue;
                if(newReceiptAmount > 0)
                    receiptContract.setAmount(receiptId, newReceiptAmount);
                else
                    receiptContract.burn(receiptId);
                amount = 0;
            }
            if (amount == 0) break;
        }

        // console.log(cycles[currentCycleId].stratsDebtInShares, toWithdraw);
        uint256 sharesToRepay = amountToShares(toWithdraw);
        if (cycles[_currentCycleId].stratsDebtInShares < sharesToRepay)
            revert PleaseWithdrawFromBatching();
        _withdrawFromStrategies(toWithdraw, withdrawToken);
        cycles[_currentCycleId].stratsDebtInShares -= sharesToRepay;
    }

    /// @notice Withdraw stablecoins from strategies by shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function withdrawShares(uint256 shares, address withdrawToken)
        public
        OnlyEOW
    {
        if (sharesToken.balanceOf(msg.sender) < shares)
            revert InsufficientShares();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 amount = sharesToAmount(shares);
        sharesToken.burn(msg.sender, shares);
        _withdrawFromStrategies(amount, withdrawToken);
    }

    /// @notice Withdraw stablecoins from batching by shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function crossWithdrawShares(uint256 shares, address withdrawToken)
        public
        OnlyEOW
    {
        if (sharesToken.balanceOf(msg.sender) < shares)
            revert InsufficientShares();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 amount = sharesToAmount(shares);
        // these shares will be owned by depositors of the current batch, when they burn receipts
        sharesToken.routerTransferFrom(msg.sender, address(this), shares);
        _withdrawFromBatching(amount, withdrawToken);
        cycles[currentCycleId].stratsDebtInShares += shares;
    }

    /// @notice Withdraw stablecoins from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount of USD to withdraw.
    /// @dev Only callable by user wallets.
    function withdrawFromBatching(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 amount
    ) public OnlyEOW {
        batching.withdrawFromBatching(
            msg.sender,
            receiptIds,
            withdrawToken,
            amount
        );
    }

    /// @notice Withdraw stablecoins from batching while receipts are in strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice Receipts are burned.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param shares Amount of shares from receipts to withdraw.
    /// @dev Only callable by user wallets.
    function crossWithdrawFromBatching(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 shares
    ) external OnlyEOW {
        // console.log("~~~~~~~~~~~~~ crossWithdrawFromBatching ~~~~~~~~~~~~~");
        if (shares == 0) revert AmountNotSpecified();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 unlockedShares = _unlockShares(receiptIds);
        if (unlockedShares > shares) {
            // leftover shares -> send to user
            sharesToken.transfer(msg.sender, unlockedShares - shares);
        } else if (unlockedShares < shares) {
            // lack of shares -> get from user
            sharesToken.routerTransferFrom(
                msg.sender,
                address(this),
                shares - unlockedShares
            );
        }

        uint256 amountWithdraw = sharesToAmount(shares);

        _withdrawFromBatching(amountWithdraw, withdrawToken);
        cycles[currentCycleId].stratsDebtInShares += shares;
    }

    /// @notice Allows to withdraw from batching and from strategies at the same time.
    /// @notice It also can cross withdraw from batching if there is enough.
    /// @notice This function internally rely on the other withdraw functions, thus inherit some bussines logic.
    /// @param receiptIdsBatch Receipt NFTs ids from batching.
    /// @param receiptIdsStrats Receipt NFTs ids from strategies.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount to withdraw from NFTs and share tokens holded by user.
    /// @dev Only callable by user wallets.
    // function withdrawUniversal(
    //     uint256[] calldata receiptIdsBatch,
    //     uint256[] calldata receiptIdsStrats,
    //     address withdrawToken,
    //     uint256 amount
    // ) external OnlyEOW {
    //     // // console.log("~~~~~~~~~~~~~ crossWithdrawFromBatching ~~~~~~~~~~~~~");
    //     if (amount == 0) revert AmountNotSpecified();
    //     if (supportsCoin(withdrawToken) == false)
    //         revert UnsupportedStablecoin();

    //     uint256 fromBatchAmount;
    //     uint256 _currentCycleId = currentCycleId;
    //     for (uint256 i = 0; i < receiptIdsBatch.length; i++) {
    //         uint256 receiptId = receiptIdsBatch[i];
    //         ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
    //             receiptId
    //         );
    //         fromBatchAmount += receipt.amount;
    //     }

    //     if (fromBatchAmount > amount) fromBatchAmount = amount;

    //     if (fromBatchAmount > 0) {
    //         amount -= fromBatchAmount;
    //         (uint256 totalBalance, ) = viewBatchingBalance();

    //         if (fromBatchAmount <= totalBalance) {
    //             // console.log("withdrawFromBatching fromBatchAmount", fromBatchAmount);
    //             withdrawFromBatching(
    //                 receiptIdsBatch,
    //                 withdrawToken,
    //                 fromBatchAmount
    //             );
    //         } else {
    //             if (totalBalance > 0) {
    //                 // console.log("withdrawFromBatching totalBalance", totalBalance);
    //                 withdrawFromBatching(
    //                     receiptIdsBatch,
    //                     withdrawToken,
    //                     totalBalance
    //                 );
    //                 fromBatchAmount -= totalBalance;
    //             }
    //             if (
    //                 cycles[_currentCycleId].stratsDebtInShares <
    //                 fromBatchAmount
    //             ) revert PleaseWithdrawFromBatching();
    //             // console.log("crossWithdrawFromStrategies", fromBatchAmount);
    //             crossWithdrawFromStrategies(
    //                 receiptIdsBatch,
    //                 withdrawToken,
    //                 fromBatchAmount
    //             );
    //         }
    //     }
    //     // console.log(amount);

    //     if (amount == 0) return;

    //     // shares related code
    //     uint256 unlockedShares = _unlockShares(receiptIdsStrats);
    //     sharesToken.transfer(msg.sender, unlockedShares);
    //     // shares to withdraw calculated using user input amount
    //     uint256 shares = amountToShares(amount);
    //     // if user trying to withdraw more than he have, don't allow
    //     uint256 sharesBalance = sharesToken.balanceOf(msg.sender);
    //     if (sharesBalance < shares) shares = sharesBalance;

    //     uint256 fromStratsAmount = sharesToAmount(shares);

    //     (uint256 totalBalance, ) = viewBatchingBalance();

    //     if (fromStratsAmount <= totalBalance) {
    //         crossWithdrawShares(shares, withdrawToken);
    //         // console.log("crossWithdrawShares", shares);
    //     } else {
    //         if (totalBalance > 0) {
    //             uint256 _withdrawShares = (shares * totalBalance) /
    //                 fromStratsAmount;
    //             shares -= _withdrawShares;
    //             uint256 _withdrawAmount = sharesToAmount(_withdrawShares);
    //             sharesToken.burn(msg.sender, _withdrawShares);
    //             // console.log("_withdrawFromBatching", _withdrawAmount);
    //             _withdrawFromBatching(_withdrawAmount, withdrawToken);
    //             cycles[currentCycleId].stratsDebtInShares += _withdrawAmount;
    //         }
    //         // console.log("withdrawShares", shares);
    //         if (shares > 0) withdrawShares(shares, withdrawToken);
    //     }
    // }

    /// @notice Deposit stablecoin into batching.
    /// @notice Tokens not deposited into strategies immediately.
    /// @param depositToken Supported stablecoin to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function depositToBatch(address depositToken, uint256 _amount)
        external
        OnlyEOW
    {
        IERC20(depositToken).transferFrom(
            msg.sender,
            address(batching),
            _amount
        );
        batching.depositToBatch(msg.sender, depositToken, _amount);
    }

    // Admin functions

    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function setSupportedStablecoin(address tokenAddress, bool supported)
        external
        onlyOwner
    {
        batching.setSupportedStablecoin(tokenAddress, supported);
    }

    /// @notice Set address of oracle contract.
    /// @dev Admin function.
    function setOracle(IUsdOracle _oracle) external onlyOwner {
        oracle = _oracle;
        batching.setOracle(_oracle);
    }

    /// @notice Set address of exchange contract.
    /// @dev Admin function.
    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
        batching.setExchange(newExchange);
    }

    /// @notice Set address for collecting fees from rewards.
    /// @dev Admin function.
    function setFeeAddress(address _feeAddress) external onlyOwner {
        if (_feeAddress == address(0)) revert();
        feeAddress = _feeAddress;
    }

    /// @notice Set percent to take of rewards for owners.
    /// @dev Admin function.
    function setFeePercent(uint256 percent) external onlyOwner {
        feePercent = percent;
    }

    /// @notice Minimum usd needed to be able to close the cycle.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinUsdPerCycle(uint256 amount) external onlyOwner {
        minUsdPerCycle = amount;
    }

    /// @notice Minimum to be deposited in the batching.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinDeposit(uint256 amount) external onlyOwner {
        batching.setMinDeposit(amount);
    }

    /// @notice Minimum time needed to be able to close the cycle.
    /// @param duration Duration of cycle in seconds.
    /// @dev Admin function.
    function setCycleDuration(uint256 duration) external onlyOwner {
        cycleDuration = duration;
    }

    /// @notice Add strategy.
    /// @param _strategyAddress Address of the strategy.
    /// @param _depositAssetAddress Asset to be deposited into strategy.
    /// @param _weight Weight of the strategy. Used to split user deposit between strategies.
    /// @dev Admin function.
    /// @dev Deposit asset must be supported by the router.
    function addStrategy(
        address _strategyAddress,
        address _depositAssetAddress,
        uint256 _weight
    ) external onlyOwner {
        if (!supportsCoin(_depositAssetAddress)) revert UnsupportedStablecoin();
        uint256 len = strategies.length;
        for (uint256 i = 0; i < len; i++) {
            if (strategies[i].strategyAddress == _strategyAddress)
                revert DuplicateStrategy();
        }
        strategies.push(
            StrategyInfo({
                strategyAddress: _strategyAddress,
                depositToken: _depositAssetAddress,
                weight: _weight
            })
        );
    }

    /// @notice Update strategy weight.
    /// @param _strategyId Id of the strategy.
    /// @param _weight Weight of the strategy.
    /// @dev Admin function.
    function updateStrategy(uint256 _strategyId, uint256 _weight)
        external
        onlyOwner
    {
        strategies[_strategyId].weight = _weight;
    }

    /// @notice Remove strategy, deposit its balance in other strategies.
    /// @param _strategyId Id of the strategy.
    /// @dev Admin function.
    function removeStrategy(uint256 _strategyId) external onlyOwner {
        // console.log("~~~~~~~~~~~~~ removeStrategy ~~~~~~~~~~~~~");
        if (strategies.length < 2) revert CantRemoveLastStrategy();
        StrategyInfo memory removedStrategyInfo = strategies[_strategyId];
        IStrategy removedStrategy = IStrategy(
            removedStrategyInfo.strategyAddress
        );
        address removedDepositToken = removedStrategyInfo.depositToken;

        uint256 len = strategies.length - 1;
        strategies[_strategyId] = strategies[len];
        strategies.pop();

        // compound removed strategy
        removedStrategy.compound();

        // withdraw all from removed strategy
        uint256 withdrawnAmount = removedStrategy.withdrawAll();

        // compound all strategies
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // deposit withdrawn funds into other strategies
        for (uint256 i; i < len; i++) {
            uint256 depositAmount = (withdrawnAmount *
                viewStrategyPercentWeight(i)) / 1e18;
            address strategyAssetAddress = strategies[i].depositToken;

            depositAmount = _trySwap(
                depositAmount,
                removedDepositToken,
                strategyAssetAddress
            );

            IERC20(strategyAssetAddress).transfer(
                strategies[i].strategyAddress,
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
        }
        Ownable(address(removedStrategy)).transferOwnership(msg.sender);
    }

    /// @notice Rebalance batching, so that token balances will match strategies weight.
    /// @return totalDeposit Total batching balance to be deposited into strategies with uniform decimals.
    /// @return balances Amounts to be deposited in strategies, balanced according to strategies weights.
    function rebalanceBatching()
        external
        onlyOwner
        returns (uint256 totalDeposit, uint256[] memory balances)
    {
        return batching.rebalanceBatching();
    }

    /// @notice Rebalance strategies, so that their balances will match their weights.
    /// @return totalInStrategies Total balance of the strategies with uniform decimals.
    /// @return balances Balances of the strategies after rebalancing.
    /// @dev Admin function.
    function rebalanceStrategies()
        external
        onlyOwner
        returns (uint256 totalInStrategies, uint256[] memory balances)
    {
        // console.log("~~~~~~~~~~~~~ rebalance strategies ~~~~~~~~~~~~~");

        uint256 totalBalance;

        uint256 len = strategies.length;
        if (len < 2) revert NothingToRebalance();
        uint256[] memory _strategiesBalances = new uint256[](len);
        address[] memory _strategiesTokens = new address[](len);
        address[] memory _strategies = new address[](len);
        for (uint256 i; i < len; i++) {
            _strategiesTokens[i] = strategies[i].depositToken;
            _strategies[i] = strategies[i].strategyAddress;
            _strategiesBalances[i] = IStrategy(_strategies[i]).totalTokens();
            totalBalance += toUniform(
                _strategiesBalances[i],
                _strategiesTokens[i]
            );
        }

        uint256[] memory toAdd = new uint256[](len);
        uint256[] memory toSell = new uint256[](len);
        for (uint256 i; i < len; i++) {
            uint256 desiredBalance = (totalBalance *
                viewStrategyPercentWeight(i)) / 1e18;
            desiredBalance = fromUniform(desiredBalance, _strategiesTokens[i]);
            unchecked {
                if (desiredBalance > _strategiesBalances[i]) {
                    toAdd[i] = desiredBalance - _strategiesBalances[i];
                } else if (desiredBalance < _strategiesBalances[i]) {
                    toSell[i] = _strategiesBalances[i] - desiredBalance;
                }
            }
        }

        for (uint256 i; i < len; i++) {
            for (uint256 j; j < len; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    uint256 curSell = toSell[i] > toAdd[j]
                        ? toAdd[j]
                        : toSell[i];

                    address sellToken = _strategiesTokens[i];
                    if (
                        toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD
                    ) {
                        unchecked {
                            toSell[i] = 0;
                            toAdd[j] -= curSell;
                        }
                        break;
                    }
                    address buyToken = _strategiesTokens[j];

                    uint256 received = IStrategy(_strategies[i]).withdraw(
                        curSell
                    );
                    received = _trySwap(received, sellToken, buyToken);
                    ERC20(buyToken).transfer(_strategies[j], received);
                    IStrategy(_strategies[j]).deposit(received);

                    unchecked {
                        toSell[i] -= curSell;
                        toAdd[j] -= curSell;
                    }
                }
            }
        }

        for (uint256 i; i < len; i++) {
            _strategiesBalances[i] = IStrategy(_strategies[i]).totalTokens();
            totalBalance += toUniform(
                _strategiesBalances[i],
                _strategiesTokens[i]
            );
        }

        return (totalBalance, _strategiesBalances);
    }

    // Internals


    /// @param amount USD value to withdraw.
    function _withdrawFromBatching(uint256 amount, address withdrawToken)
        private
    {
        batching._withdrawFromBatching(msg.sender, amount, withdrawToken);
    }

    /// @param amount USD value to withdraw.
    function _withdrawFromStrategies(uint256 amount, address withdrawToken)
        private
    {
        (
            uint256 strategiesBalance,
            uint256[] memory balances
        ) = viewStrategiesValue();
        uint256 len = strategies.length;

        uint256 amountToTransfer;
        // try withdraw requested token directly
        for (uint256 i; i < len; i++) {
            if (
                strategies[i].depositToken == withdrawToken &&
                balances[i] >= amount
            ) {
                (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                    withdrawToken
                );
                amountToTransfer = (amount * 10**priceDecimals) / price;
                amountToTransfer = fromUniform(amountToTransfer, withdrawToken);
                amountToTransfer = IStrategy(strategies[i].strategyAddress)
                    .withdraw(amountToTransfer);
                amount = 0;
                break;
            }
        }

        // try withdraw token which balance is enough to do only 1 swap
        if (amount != 0) {
            for (uint256 i; i < len; i++) {
                if (balances[i] >= amount) {
                    address token = strategies[i].depositToken;
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getAssetUsdPrice(token);
                    amountToTransfer = (amount * 10**priceDecimals) / price;
                    amountToTransfer = fromUniform(amountToTransfer, token);
                    amountToTransfer = IStrategy(strategies[i].strategyAddress)
                        .withdraw(amountToTransfer);
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
            for (uint256 i; i < len; i++) {
                address token = strategies[i].depositToken;
                uint256 toSwap;
                if (balances[i] < amount) {
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getAssetUsdPrice(token);

                    // convert usd value into token amount
                    toSwap = (balances[i] * 10**priceDecimals) / price;
                    // adjust decimals of the token amount
                    toSwap = fromUniform(toSwap, token);
                    toSwap = IStrategy(strategies[i].strategyAddress).withdraw(
                        toSwap
                    );
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
                    toSwap = IStrategy(strategies[i].strategyAddress).withdraw(
                        toSwap
                    );
                    // swap for requested token
                    amountToTransfer += _trySwap(toSwap, token, withdrawToken);
                    amount = 0;
                    break;
                }
            }
        }

        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromStrategies(
            msg.sender,
            withdrawToken,
            amountToTransfer
        );
    }

    /// burn receipts and return amount of freed shares.
    function _unlockShares(uint256[] calldata receiptIds)
        private
        returns (uint256 shares)
    {
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != msg.sender)
                revert NotReceiptOwner();
            shares += receiptToShares(receiptId);
            receiptContract.burn(receiptId);
            emit UnlockShares(msg.sender, receiptId, shares);
        }
    }

    // returns amount of shares locked by receipt.
    function receiptToShares(uint256 receiptId)
        private
        view
        returns (uint256 shares)
    {
        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
            receiptId
        );
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
            receipt.token
        );
        // calculate usd value
        receipt.amount = (receipt.amount * price) / 10**priceDecimals;
        console.log("receipt.amount", receipt.amount);
        // adjust according to what was actually deposited into strategies
        receipt.amount =
            (receipt.amount * cycles[receipt.cycleId].receivedByStrats) /
            cycles[receipt.cycleId].totalDeposited;
        console.log("receipt.amount", receipt.amount);

        console.log(
            "totalDeposited %s, receivedByStrats %s, receipt.amount(after calc)",
            cycles[receipt.cycleId].totalDeposited,
            cycles[receipt.cycleId].receivedByStrats,
            receipt.amount
        );

        shares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
    }

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
