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

// import "hardhat/console.sol";

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
    event UnlockShares(
        address indexed user,
        uint256 receiptId,
        uint256 shares
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
        uint256 totalInBatch;
        uint256 receivedByStrats;
        uint256 totalDepositUniform;
        // cross withdrawn amount from batching by strategy receipt
        uint256 totalWithdrawnUniform;
    }

    uint8 public constant UNIFORM_DECIMALS = 18;
    // used in rebalance function
    uint256 public constant REBALANCE_SWAP_THRESHOLD = 1e17; // UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 public constant INITIAL_SHARES = 1e12;
    address private constant DEAD_ADDRESS =
        0x000000000000000000000000000000000000dEaD;

    uint256 public cycleDuration = 1 days;
    uint256 public currentCycleId;
    uint256 public minUsdPerCycle;
    uint256 public minDeposit;
    uint256 public feePercent;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    SharesToken public sharesToken;
    address public feeAddress;

    StrategyInfo[] public strategies;
    address[] private stablecoins;
    mapping(address => bool) public stablecoinsMap;
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
        ) = _rebalanceBatching();

        for (uint256 i; i < len; i++) {
            // deposit to strategy
            IERC20 strategyAssetAddress = IERC20(strategies[i].depositToken);

            // console.log(
            //     "depositAmounts[i]",
            //     depositAmounts[i],
            //     strategyAssetAddress.balanceOf(address(this))
            // );
            // console.log(
            //     IStrategy(strategies[i].strategyAddress).depositToken(),
            //     address(strategyAssetAddress)
            // );
            if (depositAmounts[i] > 0) {
                // console.log(
                //     "dif",
                //     strategyAssetAddress.balanceOf(
                //         address(strategies[i].strategyAddress)
                //     )
                // );
                strategyAssetAddress.transfer(
                    strategies[i].strategyAddress,
                    depositAmounts[i]
                );
                // console.log(
                //     "dif",
                //     strategyAssetAddress.balanceOf(
                //         address(strategies[i].strategyAddress)
                //     )
                // );
                IStrategy(strategies[i].strategyAddress).deposit(
                    depositAmounts[i]
                );
            }

            // console.log("depositAmount %s leftoverAmount %s", depositAmount);
        }

        // get total strategies balance after deposit
        (uint256 balanceAfterDeposit, ) = viewStrategiesBalance();
        uint256 receivedByStrats = balanceAfterDeposit - balanceAfterCompound;
        uint256 totalWithdrawnUniform = cycles[currentCycleId]
            .totalWithdrawnUniform;
        // console.log(
        //     "receivedByStrats (raw) %s, withdrawFromBatch %s, receivedByStrats (+withdrawn) %s",
        //     receivedByStrats,
        //     totalWithdrawnUniform,
        //     receivedByStrats + totalWithdrawnUniform
        // );
        receivedByStrats += totalWithdrawnUniform;
        balanceAfterCompound -= totalWithdrawnUniform;

        // console.log(
        //     "balanceAfterDeposit %s, balanceAfterCompound %s, pps before math %s",
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
            // console.log(
            //     "initial pps %s, shares %s",
            //     cycles[currentCycleId].pricePerShare,
            //     sharesToken.totalSupply()
            // );
        } else {
            cycles[currentCycleId].pricePerShare =
                balanceAfterCompound /
                totalShares;

            // console.log(
            //     "cycle %s, pps %s, shares %s",
            //     currentCycleId,
            //     cycles[currentCycleId].pricePerShare,
            //     sharesToken.totalSupply()
            // );

            // console.log(
            //     "totalDepositUniform %s totalDepositUniform/pps %s",
            //     totalDepositUniform,
            //     totalDepositUniform / cycles[currentCycleId].pricePerShare
            // );
            uint256 newShares = receivedByStrats /
                cycles[currentCycleId].pricePerShare;
            // console.log("newShares", newShares);
            sharesToken.mint(address(this), newShares);
        }

        // start new cycle
        cycles[currentCycleId].receivedByStrats = receivedByStrats;
        cycles[currentCycleId].totalDepositUniform =
            totalDepositUniform +
            totalWithdrawnUniform;
        // console.log(
        //     "totalWithdrawnUniform %s, totalDepositUniform %s, receivedByStrats %s",
        //     totalWithdrawnUniform,
        //     totalDepositUniform,
        //     receivedByStrats
        // );
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
            address strategyAssetAddress = strategies[i].depositToken;
            uint256 balance = IStrategy(strategies[i].strategyAddress)
                .totalTokens();
            balance = toUniform(balance, strategyAssetAddress);
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
        private
        view
        returns (uint256 shares)
    {
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
            receiptId
        );
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        // console.log(
        //     "rts",
        //     receipt.amount,
        //     shares,
        //     (receipt.amount * cycles[receipt.cycleId].receivedByStrats) /
        //         cycles[receipt.cycleId].totalInBatch
        // );
        receipt.amount =
            (receipt.amount * cycles[receipt.cycleId].receivedByStrats) /
            cycles[receipt.cycleId].totalInBatch;
        shares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
    }

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

    /// @notice Calculate how much usd shares representing using current price per share.
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
        // console.log(
        //     "currentPricePerShare %s, totalShares %s, strategiesBalance-w %s",
        //     currentPricePerShare,
        //     sharesToken.totalSupply(),
        //     (strategiesBalance - cycles[currentCycleId].totalWithdrawnUniform)
        // );
        amount = shares * currentPricePerShare;
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

    /// @notice Withdraw from strategies while receipts are in strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice When receipts don't have enough shares, user has to approve us missing amount of share tokens.
    /// @notice Receipts are burned.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param shares Amount of shares from receipts to withdraw.
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

        uint256 unlcokedShares = _unlockShares(receiptIds);
        uint256 leftoverShares;
        if (unlcokedShares > shares) {
            leftoverShares = unlcokedShares - shares;
            unlcokedShares = shares;
            sharesToken.transfer(msg.sender, leftoverShares);
        } else if (unlcokedShares < shares) {
            uint256 amountMissing = shares - unlcokedShares;
            unlcokedShares += amountMissing;
            sharesToken.transferFrom(msg.sender, address(this), amountMissing);
        }

        uint256 amountWithdraw = sharesToAmount(unlcokedShares);
        sharesToken.burn(address(this), unlcokedShares);
        _withdrawFromStrategies(amountWithdraw, withdrawToken);
    }

    /// @notice Withdraw from strategies while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Uniform amount from receipt to withdraw, only for current cycle. Put max uint to withdraw all.
    /// @dev Only callable by user wallets.
    function crossWithdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 amount
    ) external OnlyEOW {
        // console.log("~~~~~~~~~~~~~ crossWithdrawFromStrategies ~~~~~~~~~~~~~");
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();
        if (amount == 0) revert AmountNotSpecified();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

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
            if (receipt.cycleId != currentCycleId) revert CycleClosed();
            if (amount >= receipt.amount) {
                toWithdraw += receipt.amount;
                amount -= receipt.amount;
                receiptContract.burn(receiptId);
            } else {
                toWithdraw += amount;
                receiptContract.setAmount(receiptId, receipt.amount - amount);
                amount = 0;
            }
            if (amount == 0) break;
        }

        // console.log(cycles[currentCycleId].totalWithdrawnUniform, toWithdraw);
        if (cycles[currentCycleId].totalWithdrawnUniform < toWithdraw)
            revert PleaseWithdrawFromBatching();
        _withdrawFromStrategies(toWithdraw, withdrawToken);
        cycles[currentCycleId].totalWithdrawnUniform -= toWithdraw;
    }

    /// @notice Withdraw from strategies by shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function withdrawShares(uint256 shares, address withdrawToken)
        external
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

    /// @notice Withdraw from batching by shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function crossWithdrawShares(uint256 shares, address withdrawToken)
        external
        OnlyEOW
    {
        if (sharesToken.balanceOf(msg.sender) < shares)
            revert InsufficientShares();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 amount = sharesToAmount(shares);
        sharesToken.burn(msg.sender, shares);
        _withdrawFromBatching(amount, withdrawToken);
        cycles[currentCycleId].totalWithdrawnUniform += amount;
    }

    function _withdrawFromStrategies(uint256 amount, address withdrawToken)
        private
    {
        (
            uint256 strategiesBalance,
            uint256[] memory balances
        ) = viewStrategiesBalance();

        // convert uniform amount to amount of withdraw token
        uint256 amountToTransfer;
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            address strategyAssetAddress = strategies[i].depositToken;
            uint256 withdrawAmount = (amount * balances[i]) / strategiesBalance;
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

    /// @notice Withdraw from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Uniform amount from receipt to withdraw, only for current cycle. Put max uint to withdraw all.
    /// @dev Only callable by user wallets.
    function withdrawFromBatching(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 amount
    ) external OnlyEOW {
        // console.log("~~~~~~~~~~~~~ withdrawFromBatching ~~~~~~~~~~~~~");

        if (amount == 0) revert AmountNotSpecified();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        uint256 toWithdraw;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != msg.sender)
                revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            // only for receipts in batching
            if (receipt.cycleId != currentCycleId) revert CycleClosed();
            if (amount >= receipt.amount) {
                toWithdraw += receipt.amount;
                amount -= receipt.amount;
                receiptContract.burn(receiptId);
            } else {
                toWithdraw += amount;
                receiptContract.setAmount(receiptId, receipt.amount - amount);
                amount = 0;
            }
            if (amount == 0) break;
        }
        // console.log("toWithdraw", toWithdraw);
        _withdrawFromBatching(toWithdraw, withdrawToken);
    }

    /// @notice Withdraw from batching while receipts are in strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice When receipts don't have enough shares, user has to approve us missing amount of share tokens.
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

        uint256 unlcokedShares = _unlockShares(receiptIds);
        uint256 leftoverShares;
        if (unlcokedShares > shares) {
            leftoverShares = unlcokedShares - shares;
            unlcokedShares = shares;
            sharesToken.transfer(msg.sender, leftoverShares);
        } else if (unlcokedShares < shares) {
            uint256 amountMissing = shares - unlcokedShares;
            unlcokedShares += amountMissing;
            sharesToken.transferFrom(msg.sender, address(this), amountMissing);
        }

        uint256 amountWithdraw = sharesToAmount(unlcokedShares);
        // console.log(
        //     "burn",
        //     unlcokedShares,
        //     sharesToken.balanceOf(address(this))
        // );
        sharesToken.burn(address(this), unlcokedShares);

        _withdrawFromBatching(amountWithdraw, withdrawToken);
        cycles[currentCycleId].totalWithdrawnUniform += amountWithdraw;
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
        uint256 withdrawTokenBalance = ERC20(withdrawToken).balanceOf(
            address(this)
        );
        if (withdrawTokenBalance >= amount) {
            amountToTransfer = amount;
        } else {
            // uint256 len = strategies.length;
            for (uint256 i; i < balances.length; i++) {
                address token = stablecoins[i];
                // split withdraw amount proportionally between strategies
                uint256 amountWithdraw = (amount * balances[i]) / totalBalance;
                if (amountWithdraw < 10**ERC20(token).decimals()) continue;

                amountWithdraw = fromUniform(amountWithdraw, token);

                // swap strategies tokens to withdraw token
                amountWithdraw = _trySwap(amountWithdraw, token, withdrawToken);
                amountToTransfer += amountWithdraw;
            }

            // console.log(
            //     "withdraw token balance %s, total withdraw %s",
            //     IERC20(withdrawToken).balanceOf(address(this)),
            //     amountToTransfer
            // );
        }
        cycles[currentCycleId].totalInBatch -= amount;
        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromBatching(msg.sender, withdrawToken, amountToTransfer);
    }

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

    /// @notice Set address for collecting fees from rewards.
    /// @dev Admin function.
    function setFeeAddress(address _feeAddress) external onlyOwner {
        if(_feeAddress == address(0)) revert();
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
                // console.log(toAdd[i], toSell[i]);
            }
        }

        for (uint256 i; i < len; i++) {
            for (uint256 j; j < len; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    uint256 curSell = toSell[i] > toAdd[j]
                        ? toAdd[j]
                        : toSell[i];
                    // console.log("sell add", toSell[i], toAdd[j]);

                    address sellToken = _strategiesTokens[i];
                    if (
                        toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD
                    ) {
                        // console.log(
                        //     "swap threshold reached",
                        //     toUniform(curSell, sellToken),
                        //     REBALANCE_SWAP_THRESHOLD
                        // );
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

    /// @notice Rebalance batching, so that token balances will match strategies weight.
    /// @return totalDeposit Total batching balance to be deposited into strategies with uniform decimals.
    /// @return balances Amounts to be deposited in strategies, balanced according to strategies weights.
    function rebalanceBatching()
        external
        onlyOwner
        returns (uint256 totalDeposit, uint256[] memory balances)
    {
        return _rebalanceBatching();
    }

    function _rebalanceBatching()
        private
        returns (uint256 totalDeposit, uint256[] memory balances)
    {
        // console.log("~~~~~~~~~~~~~ rebalance batching ~~~~~~~~~~~~~");

        uint256 totalInBatch;

        uint256 lenStables = stablecoins.length;
        // bool[] memory _isStrategyToken = new bool[](lenStables);
        address[] memory _tokens = new address[](lenStables);
        uint256[] memory _balances = new uint256[](lenStables);

        for (uint256 i; i < lenStables; i++) {
            _tokens[i] = stablecoins[i];
            _balances[i] = ERC20(_tokens[i]).balanceOf(address(this));

            totalInBatch += toUniform(_balances[i], _tokens[i]);
            // console.log(_balances[i]);
        }

        uint256 lenStrats = strategies.length;

        uint256[] memory _strategiesBalances = new uint256[](
            lenStrats + lenStables
        );
        for (uint256 i; i < lenStrats; i++) {
            for (uint256 j; j < lenStables; j++) {
                address depositToken = strategies[i].depositToken;
                if (depositToken == _tokens[j] && _balances[j] > 0) {
                    _strategiesBalances[i] = _balances[j];
                    // _isStrategyToken[j] = true;
                    _balances[j] = 0;
                    break;
                } else if (
                    depositToken == _tokens[j] /* && _balances[j] == 0 */
                ) {
                    break;
                }
            }
        }

        // console.log("totalInBatch %s", totalInBatch);
        for (uint256 i = lenStrats; i < _strategiesBalances.length; i++) {
            _strategiesBalances[i] = _balances[i - lenStrats];
            // console.log("_strategiesBalances[i] %s", _strategiesBalances[i]);
        }

        uint256[] memory toAdd = new uint256[](lenStrats);
        uint256[] memory toSell = new uint256[](_strategiesBalances.length);
        for (uint256 i; i < lenStrats; ) {
            uint256 desiredBalance = (totalInBatch *
                viewStrategyPercentWeight(i)) / 1e18;
            desiredBalance = fromUniform(
                desiredBalance,
                strategies[i].depositToken
            );
            unchecked {
                if (desiredBalance > _strategiesBalances[i]) {
                    toAdd[i] = desiredBalance - _strategiesBalances[i];
                } else if (desiredBalance < _strategiesBalances[i]) {
                    toSell[i] = _strategiesBalances[i] - desiredBalance;
                }
                // console.log(toAdd[i], toSell[i]);
                i++;
            }
        }

        for (uint256 i = lenStrats; i < _strategiesBalances.length; i++) {
            toSell[i] = _strategiesBalances[i];
            // console.log(
            //     "_strategiesBalances toSell[i] %s, toSell[i-lenStrats] %s",
            //     toSell[i],
            //     toSell[i - lenStrats]
            // );
        }

        for (uint256 i; i < _strategiesBalances.length; i++) {
            for (uint256 j; j < lenStrats; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    uint256 curSell = toSell[i] > toAdd[j]
                        ? toAdd[j]
                        : toSell[i];
                    // console.log("i %s j %s _tokens.length %s", i, j, _tokens.length);
                    // console.log("sell add", toSell[i], toAdd[j]);
                    // console.log(i, j, toSell[i], toAdd[j]);

                    address sellToken = i > lenStrats - 1
                        ? _tokens[i - lenStrats]
                        : strategies[i].depositToken;

                    // its not worth to swap too small amounts
                    if (
                        toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD
                    ) {
                        // console.log(
                        //     "aaa",
                        //     toUniform(curSell, sellToken),
                        //     REBALANCE_SWAP_THRESHOLD
                        // );
                        unchecked {
                            toSell[i] = 0;
                            toAdd[j] -= curSell;
                        }
                        break;
                    }
                    address buyToken = strategies[j].depositToken;
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
            totalDeposit += toUniform(_balances[i], strategies[i].depositToken);
            // console.log("_strategiesBalances[i] %s", _strategiesBalances[i]);
        }

        return (totalDeposit, _balances);
    }

    // function withdrawFromStrategy(uint256 _strategyId) external onlyOwner {}

    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function setSupportedStablecoin(address tokenAddress, bool supported)
        external
        onlyOwner
    {
        if (supported && supportsCoin(tokenAddress))
            revert AlreadyAddedStablecoin();

        stablecoinsMap[tokenAddress] = supported;
        if (supported) {
            stablecoins.push(tokenAddress);
        } else {
            uint8 len = uint8(strategies.length);
            // shouldn't disallow tokens that are in use by active strategies
            for (uint256 i = 0; i < len; i++) {
                if (strategies[i].depositToken == tokenAddress) {
                    revert CantRemoveTokenOfActiveStrategy();
                }
            }

            len = uint8(stablecoins.length);
            // disallow token
            for (uint256 i = 0; i < len; i++) {
                if (stablecoins[i] == tokenAddress) {
                    stablecoins[i] = stablecoins[len - 1];
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
