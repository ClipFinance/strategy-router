//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./ReceiptNFT.sol";
import "./Exchange.sol";
import "./SharesToken.sol";

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
    event UnlockSharesFromNFT(
        address indexed user,
        uint256 receiptId,
        uint256 shares
    );

    /* ERRORS */

    error AlreadyAddedStablecoin();
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
    error SpecifyOnlySharesOrAmount();
    error PleaseWithdrawFromBatching();
    error NotEnoughInBatching();
    error CantRemoveLastStrategy();
    // error InitialSharesAreUnwithdrawable();

    /// @notice Restrict msg.sender to be externally owned accounts only.
    modifier OnlyEOW() {
        if (msg.sender != tx.origin) revert NotCallableByContracts();
        _;
    }

    struct StrategyInfo {
        address strategyAddress;
        uint256 weight;
    }

    struct Cycle {
        uint256 startAt;
        uint256 pricePerShare;
        uint256 totalInBatch;
        uint256 receivedByStrats;
        uint256 totalDepositUniform;
        // cross withdrawn amount from batching by strategy receipt
        uint256 totalWithdrawnUniform;
    }

    uint8 public constant UNIFORM_DECIMALS = 18;
    uint256 public constant INITIAL_SHARES = 1e12;
    address private constant DEAD_ADDRESS =
        0x000000000000000000000000000000000000dEaD;

    uint256 public cycleDuration = 1 days;
    uint256 public currentCycleId;
    uint256 public minUsdPerCycle;
    uint256 public minDeposit;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    SharesToken public sharesToken;

    StrategyInfo[] public strategies;
    address[] private stablecoins;
    mapping(address => bool) private stablecoinsMap;
    mapping(uint256 => Cycle) public cycles;

    constructor() {
        receiptContract = new ReceiptNFT();
        sharesToken = new SharesToken();
        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    /// @notice Deposit money collected in the batching into strategies.
    /// @notice Can be called when `cycleDuration` seconds has been passed or
    ///         batch has reached `minUsdPerCycle` amount of coins.
    /// @dev Only callable by user wallets.
    function depositToStrategies() external OnlyEOW {
        if (
            cycles[currentCycleId].startAt + cycleDuration > block.timestamp &&
            cycles[currentCycleId].totalInBatch < minUsdPerCycle
        ) revert CycleNotClosableYet();

        // console.log("~~~~~~~~~~~~~ depositToStrategies ~~~~~~~~~~~~~");

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // get total strategies balance after compound
        (uint256 balanceAfterCompound, ) = viewStrategiesBalance();
        (
            uint256 totalDepositUniform,
            uint256[] memory depositAmounts
        ) = rebalanceBatching();

        for (uint256 i; i < len; i++) {
            // deposit to strategy
            IERC20 strategyAssetAddress = IERC20(
                IStrategy(strategies[i].strategyAddress).depositToken()
            );

            console.log("depositAmounts[i]", depositAmounts[i]);
            console.log("depositAmounts[i]", depositAmounts[i]);
            strategyAssetAddress.transfer(
                strategies[i].strategyAddress,
                depositAmounts[i]
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmounts[i]);

            // console.log("depositAmount %s leftoverAmount %s", depositAmount);
        }

        // get total strategies balance after deposit
        (uint256 balanceAfterDeposit, ) = viewStrategiesBalance();
        uint256 receivedByStrats = balanceAfterDeposit - balanceAfterCompound;
        console.log(
            "receivedByStrats %s, withdrawFromBatch %s, sum %s",
            receivedByStrats,
            cycles[currentCycleId].totalWithdrawnUniform,
            receivedByStrats + cycles[currentCycleId].totalWithdrawnUniform
        );
        receivedByStrats += cycles[currentCycleId].totalWithdrawnUniform;
        balanceAfterCompound -= cycles[currentCycleId].totalWithdrawnUniform;

        // console.log(
        //     "balanceAfterDeposit %s, balanceAfterCompound %s, pps before math",
        //     balanceAfterDeposit,
        //     balanceAfterCompound,
        //     cycles[currentCycleId].pricePerShare
        // );

        uint256 totalShares = sharesToken.totalSupply();
        if (totalShares == 0) {
            sharesToken.mint(DEAD_ADDRESS, INITIAL_SHARES);
            cycles[currentCycleId].pricePerShare =
                balanceAfterDeposit /
                sharesToken.totalSupply();
            console.log(
                "initial pps %s, shares %s",
                cycles[currentCycleId].pricePerShare,
                sharesToken.totalSupply()
            );
        } else {
            cycles[currentCycleId].pricePerShare =
                balanceAfterCompound /
                totalShares;

            console.log(
                "cycle %s, pps %s, shares %s",
                currentCycleId,
                cycles[currentCycleId].pricePerShare,
                sharesToken.totalSupply()
            );

            console.log(
                "totalDepositUniform %s totalDepositUniform/pps %s",
                totalDepositUniform,
                totalDepositUniform / cycles[currentCycleId].pricePerShare
            );
            uint256 newShares = receivedByStrats /
                cycles[currentCycleId].pricePerShare;
            sharesToken.mint(address(this), newShares);
        }

        // start new cycle
        cycles[currentCycleId].receivedByStrats = receivedByStrats;
        cycles[currentCycleId].totalDepositUniform =
            totalDepositUniform +
            cycles[currentCycleId].totalWithdrawnUniform;
        console.log(
            "totalWithdrawnUniform %s, totalDepositUniform %s, receivedByStrats %s",
            cycles[currentCycleId].totalWithdrawnUniform,
            totalDepositUniform,
            receivedByStrats
        );
        // cycles[currentCycleId].totalWithdrawnUniform = 0;
        emit DepositToStrategies(currentCycleId, receivedByStrats);
        currentCycleId++;
        cycles[currentCycleId].startAt = block.timestamp;
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
        return stablecoins;
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
            (strategies[_strategyId].weight * 1e4) /
            totalStrategyWeight;

        return strategyPercentAllocation;
    }

    /// @notice Returns count of strategies.
    function viewStrategiesCount() public view returns (uint256 count) {
        return strategies.length;
    }

    /// @notice Returns amount of tokens in strategies.
    /// @notice All returned numbers have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total amount of tokens in strategies.
    /// @return balances Array of token amount in each strategy.
    function viewStrategiesBalance()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](strategies.length);
        for (uint256 i; i < balances.length; i++) {
            address strategyAssetAddress = IStrategy(
                strategies[i].strategyAddress
            ).depositToken();
            uint256 balance = IStrategy(strategies[i].strategyAddress)
                .totalTokens();
            balance = toUniform(balance, strategyAssetAddress);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    /// @notice Returns token balances and their sum in the batching.
    /// @notice All returned numbers have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total tokens in the batching.
    /// @return balances Array of token balances in the batching.
    function viewBatchingBalance()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](stablecoins.length);
        for (uint256 i; i < balances.length; i++) {
            address token = stablecoins[i];
            uint256 balance = ERC20(token).balanceOf(address(this));
            balance = toUniform(balance, token);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    /// @notice Returns amount of shares retrievable by receipt.
    /// @notice Cycle noted in receipt should be closed.
    function receiptToShares(uint256 receiptId)
        public
        view
        returns (uint256 shares)
    {
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
            receiptId
        );
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        receipt.amount =
            (receipt.amount * cycles[receipt.cycleId].receivedByStrats) /
            cycles[receipt.cycleId].totalDepositUniform;
        shares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
    }

    /// @notice Converts shares to uniform amount using current price per share.
    /// @dev Returns amount with uniform decimals
    function sharesToAmount(uint256 shares)
        public
        view
        returns (uint256 amount)
    {
        (uint256 strategiesBalance, ) = viewStrategiesBalance();
        uint256 currentPricePerShare = (strategiesBalance -
            cycles[currentCycleId].totalWithdrawnUniform) /
            sharesToken.totalSupply();
        console.log(
            "currentPricePerShare %s, totalShares %s, strategiesBalance-w %s",
            currentPricePerShare,
            sharesToken.totalSupply(),
            (strategiesBalance - cycles[currentCycleId].totalWithdrawnUniform)
        );
        amount = shares * currentPricePerShare;
    }

    // User Functions

    /// @notice Convert receipt NFT into share tokens.
    /// @notice Cycle noted in receipt should be closed.
    function unlockSharesFromNFT(uint256 receiptId)
        public
        OnlyEOW
        returns (uint256 shares)
    {
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();
        if (receiptContract.ownerOf(receiptId) != msg.sender)
            revert NotReceiptOwner();

        shares = receiptToShares(receiptId);
        receiptContract.burn(receiptId);
        sharesToken.transfer(msg.sender, shares);
        emit UnlockSharesFromNFT(msg.sender, receiptId, shares);
    }

    /// @notice User withdraw usd from strategies via receipt NFT.
    /// @notice On partial withdraw leftover shares transfered to user.
    /// @notice Receipt is burned.
    /// @param receiptId Receipt NFT id.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param shares Amount of shares from receipt to withdraw.
    /// @param amount Uniform amount from receipt to withdraw, only for current cycle.
    /// @dev Only callable by user wallets.
    function withdrawFromStrategies(
        uint256 receiptId,
        address withdrawToken,
        uint256 shares,
        uint256 amount
    ) external OnlyEOW {
        console.log("~~~~~~~~~~~~~ withdrawFromStrategies ~~~~~~~~~~~~~");
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();
        if (receiptContract.ownerOf(receiptId) != msg.sender)
            revert NotReceiptOwner();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();
        if (shares > 0 && amount > 0) revert SpecifyOnlySharesOrAmount();

        if (shares > 0) {
            // receipt in strategies withdraw from strategies
            uint256 unlockedShares = receiptToShares(receiptId);
            receiptContract.burn(receiptId);
            if (shares > unlockedShares) shares = unlockedShares;
            // all shares are minted to this contract, so transfer leftover shares to user
            uint256 unlocked = unlockedShares - shares;
            if (unlocked > 0) {
                sharesToken.transfer(msg.sender, unlocked);
            }
            // shares was locked in router
            amount = sharesToAmount(shares);
            sharesToken.burn(address(this), shares);
            console.log("shares %s, amount %s", shares, amount);

            emit UnlockSharesFromNFT(msg.sender, receiptId, unlockedShares);
            _withdrawFromStrategies(amount, withdrawToken);
        } else {
            // receipt in batching withdraws from strategies
            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            // only for receipts in batching
            if (receipt.cycleId != currentCycleId) revert CycleClosed();
            if (amount >= receipt.amount) {
                amount = receipt.amount;
                receiptContract.burn(receiptId);
            } else {
                receiptContract.setAmount(receiptId, receipt.amount - amount);
            }

            if (cycles[currentCycleId].totalWithdrawnUniform < amount)
                revert PleaseWithdrawFromBatching();
            cycles[currentCycleId].totalWithdrawnUniform -= amount;
            _withdrawFromStrategies(amount, withdrawToken);
        }
    }

    /// @notice User withdraw stablecoins from strategies via shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function withdrawShares(uint256 shares, address withdrawToken)
        external
        OnlyEOW
    {
        // TODO: if succeed with new cross-withdraw optimization, then should also adjust this function
        if (sharesToken.balanceOf(msg.sender) < shares)
            revert InsufficientShares();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 amount = sharesToAmount(shares);
        sharesToken.burn(msg.sender, shares);
        _withdrawFromStrategies(amount, withdrawToken);
    }

    function _withdrawFromStrategies(uint256 amount, address withdrawToken)
        private
    {
        (
            uint256 strategiesBalance,
            uint256[] memory balances
        ) = viewStrategiesBalance();
        uint256 withdrawAmountTotal = amount;

        // convert uniform amount to amount of withdraw token
        uint256 amountToTransfer;
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            address strategyAssetAddress = IStrategy(
                strategies[i].strategyAddress
            ).depositToken();
            uint256 withdrawAmount = (withdrawAmountTotal * balances[i]) /
                strategiesBalance;
            withdrawAmount = fromUniform(withdrawAmount, strategyAssetAddress);
            withdrawAmount = IStrategy(strategies[i].strategyAddress).withdraw(
                withdrawAmount
            );

            withdrawAmount = _trySwap(
                withdrawAmount,
                strategyAssetAddress,
                withdrawToken
            );
            amountToTransfer += withdrawAmount;
        }
        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromStrategies(
            msg.sender,
            withdrawToken,
            amountToTransfer
        );
    }

    /// @notice User withdraw tokens from batching.
    /// @notice On partial withdraw amount noted in receipt is updated.
    /// @notice Receipt is burned when withdrawing whole amount.
    /// @param receiptId Receipt NFT id.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount to withdraw. Max amount to withdraw is noted in NFT,
    ///        passing greater than that or 0 will choose maximum noted in NFT.
    /// @dev Cycle noted in receipt must match current cycle (i.e. not closed).
    /// @dev Only callable by user wallets.
    function withdrawFromBatching(
        uint256 receiptId,
        address withdrawToken,
        uint256 shares,
        uint256 amount
    ) external OnlyEOW {
        // console.log("~~~~~~~~~~~~~ withdrawFromBatching ~~~~~~~~~~~~~");
        if (receiptContract.ownerOf(receiptId) != msg.sender)
            revert NotReceiptOwner();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();
        if (shares > 0 && amount > 0) revert SpecifyOnlySharesOrAmount();

        if (shares > 0) {
            // receipt in strategies withdraw from batching
            uint256 unlockedShares = receiptToShares(receiptId);
            receiptContract.burn(receiptId);
            if (shares > unlockedShares) shares = unlockedShares;
            uint256 unlocked = unlockedShares - shares;
            if (unlocked > 0) {
                sharesToken.transfer(msg.sender, unlocked);
            }
            amount = sharesToAmount(shares);
            sharesToken.burn(address(this), shares);
            _withdrawFromBatching(amount, withdrawToken);
            cycles[currentCycleId].totalWithdrawnUniform += amount;
            emit UnlockSharesFromNFT(msg.sender, receiptId, unlocked);
        } else {
            // receipt in batching withdraws from batching
            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            // receipt in strategies should not pass this check
            if (receipt.cycleId != currentCycleId) revert CycleClosed();
            if (amount >= receipt.amount) {
                amount = receipt.amount;
                receiptContract.burn(receiptId);
            } else {
                receiptContract.setAmount(receiptId, receipt.amount - amount);
            }
            _withdrawFromBatching(amount, withdrawToken);
        }
    }

    function _withdrawFromBatching(uint256 amount, address withdrawToken)
        private
    {
        (
            uint256 totalBalance,
            uint256[] memory balances
        ) = viewBatchingBalance();
        // console.log("total %s, amount %s", totalBalance, amount);
        if (totalBalance < amount) revert NotEnoughInBatching();

        uint256 amountToTransfer;
        // uint256 len = strategies.length;
        for (uint256 i; i < balances.length; i++) {
            address strategyAssetAddress = IStrategy(
                strategies[i].strategyAddress
            ).depositToken();
            // split withdraw amount proportionally between strategies
            uint256 amountWithdraw = (amount * balances[i]) / totalBalance;
            amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

            // swap strategies tokens to withdraw token
            amountWithdraw = _trySwap(
                amountWithdraw,
                strategyAssetAddress,
                withdrawToken
            );
            amountToTransfer += amountWithdraw;
        }
        cycles[currentCycleId].totalInBatch -= amount;

        // console.log(
        //     "withdraw token balance %s, total withdraw %s",
        //     IERC20(withdrawToken).balanceOf(address(this)),
        //     amountToTransfer
        // );
        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromBatching(msg.sender, withdrawToken, amountToTransfer);
    }

    /// @notice Deposit stablecoin into batching.
    /// @notice Tokens immediately swapped to stablecoins required by strategies
    ///         according to their weights, but not deposited into strategies.
    /// @param depositToken Supported stablecoin to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function depositToBatch(address depositToken, uint256 _amount)
        external
        OnlyEOW
    {
        if (!supportsCoin(depositToken)) revert UnsupportedStablecoin();
        if (fromUniform(minDeposit, depositToken) > _amount)
            revert DepositUnderMinimum();

        // console.log("~~~~~~~~~~~~~ depositToBatch ~~~~~~~~~~~~~");
        IERC20(depositToken).transferFrom(msg.sender, address(this), _amount);

        uint256 amountUniform = toUniform(_amount, depositToken);
        cycles[currentCycleId].totalInBatch += amountUniform;

        emit Deposit(msg.sender, depositToken, _amount);
        receiptContract.mint(currentCycleId, amountUniform, msg.sender);
    }

    // Admin functions

    /// @notice Set address of exchange contract.
    /// @dev Admin function.
    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
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
        minDeposit = amount;
    }

    /// @notice Minimum time needed to be able to close the cycle.
    /// @param duration Duration of cycle in seconds.
    /// @dev Admin function.
    function setCycleDuration(uint256 duration) external onlyOwner {
        cycleDuration = duration;
    }

    /// @notice Add strategy.
    /// @param _strategyAddress Address of the strategy.
    /// @param _weight Weight of the strategy.
    /// @dev Admin function.
    function addStrategy(address _strategyAddress, uint256 _weight)
        external
        onlyOwner
    {
        uint256 len = strategies.length;
        for (uint256 i = 0; i < len; i++) {
            if (strategies[i].strategyAddress == _strategyAddress)
                revert DuplicateStrategy();
        }
        strategies.push(
            StrategyInfo({strategyAddress: _strategyAddress, weight: _weight})
        );
        updateStablecoinMap(IStrategy(_strategyAddress).depositToken(), true);
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
        address removedDepositToken = IStrategy(
            removedStrategyInfo.strategyAddress
        ).depositToken();

        uint256 len = strategies.length - 1;
        strategies[_strategyId] = strategies[len];
        strategies.pop();
        // this update should be after pop
        updateStablecoinMap(removedDepositToken, false);

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
                viewStrategyPercentWeight(i)) / 10000;
            address strategyAssetAddress = IStrategy(
                strategies[i].strategyAddress
            ).depositToken();

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
    }

    /// @notice Rebalance batching, so that token balances will match strategies weight.
    /// @return totalInBatching Total batching balance with uniform decimals.
    /// @return balances Amounts to be deposited in strategies, balanced according to strategies weights.
    function rebalanceBatching()
        private
        returns (uint256 totalInBatching, uint256[] memory balances)
    {
        // TODO: NEED to make the same function but for strategies
        console.log("~~~~~~~~~~~~~ rebalance batching ~~~~~~~~~~~~~");

        uint256 totalInBatch;

        uint256 lenStables = stablecoins.length;
        address[] memory _tokens = new address[](lenStables);
        uint256[] memory _balances = new uint256[](lenStables);

        for (uint256 i; i < lenStables; i++) {
            _tokens[i] = stablecoins[i];
            _balances[i] = ERC20(_tokens[i]).balanceOf(address(this));
            totalInBatch += toUniform(_balances[i], _tokens[i]);
            console.log(_balances[i]);
        }

        uint256 len = strategies.length;
        uint256[] memory _strategiesBalances = new uint256[](len);
        for (uint256 i; i < len; i++) {
            for (uint256 j; j < lenStables; j++) {
                address depositToken = IStrategy(strategies[i].strategyAddress)
                    .depositToken();
                if (_balances[j] > 0 && depositToken == _tokens[j]) {
                    _strategiesBalances[i] = _balances[j];
                    _balances[j] = 0;
                }
            }
        }

        uint256[] memory toAdd = new uint256[](len);
        uint256[] memory toSell = new uint256[](len);
        for (uint256 i; i < len; ) {
            uint256 desiredBalance = (totalInBatch *
                viewStrategyPercentWeight(i)) / 10000;
            desiredBalance = fromUniform(
                desiredBalance,
                IStrategy(strategies[i].strategyAddress).depositToken()
            );
            unchecked {
                if (desiredBalance > _strategiesBalances[i]) {
                    toAdd[i] = desiredBalance - _strategiesBalances[i];
                } else if (desiredBalance < _strategiesBalances[i]) {
                    toSell[i] = _strategiesBalances[i] - desiredBalance;
                }
                console.log(toAdd[i], toSell[i]);
                i++;
            }
        }

        for (uint256 i; i < len; i++) {
            for (uint256 j; j < len; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    uint256 curSell = toSell[i] > toAdd[j]
                        ? toAdd[j]
                        : toSell[i];
                    console.log("sell add", toSell[i], toAdd[j]);
                    address sellToken = IStrategy(strategies[i].strategyAddress)
                        .depositToken();
                    address buyToken = IStrategy(strategies[j].strategyAddress)
                        .depositToken();
                    uint256 received = _trySwap(curSell, sellToken, buyToken);

                    totalInBatch =
                        totalInBatch -
                        toUniform(curSell, sellToken) +
                        toUniform(received, buyToken);

                    _strategiesBalances[i] -= curSell;
                    _strategiesBalances[j] += received;
                    unchecked {
                        toSell[i] -= curSell;
                        toAdd[j] -= curSell;
                    }
                }
            }
        }
        return (totalInBatch, _strategiesBalances);
    }

    // function withdrawFromStrategy(uint256 _strategyId) external onlyOwner {}

    /// @dev Keeps stablecoins array updated with unique ones.
    /// @dev Keeps stablecoins map updated.
    function updateStablecoinMap(address stablecoinAddress, bool isAddStrategy)
        private
    {
        if (isAddStrategy && !stablecoinsMap[stablecoinAddress]) {
            stablecoinsMap[stablecoinAddress] = true;
            stablecoins.push(stablecoinAddress);
        } else if (!isAddStrategy) {
            // if stablecoin still used by unremoved strategies just exit
            uint256 len = strategies.length;
            for (uint256 i = 0; i < len; i++) {
                address strategyToken = IStrategy(strategies[i].strategyAddress)
                    .depositToken();
                if (strategyToken == stablecoinAddress) {
                    return;
                }
            }

            // if stablecoin unused by strategies anymore, then delete it
            stablecoinsMap[stablecoinAddress] = false;
            uint256 lenS = stablecoins.length;
            for (uint256 i = 0; i < lenS; i++) {
                if (stablecoins[i] == stablecoinAddress) {
                    stablecoins[i] = stablecoins[stablecoins.length - 1];
                    stablecoins.pop();
                    break;
                }
            }
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

    /// @notice Returns whether provided stablecoin is supported.
    /// @param stablecoinAddress Address to lookup.
    function supportsCoin(address stablecoinAddress)
        private
        view
        returns (bool isSupported)
    {
        return stablecoinsMap[stablecoinAddress];
    }
}
