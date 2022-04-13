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
    event WithdrawFromBatching(address indexed user, address token, uint256 amount);
    /// @notice Fires when user withdraw from strategies.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromStrategies(address indexed user, address token, uint256 amount);
    /// @notice Fires when user converts his receipt into shares token.
    /// @param receiptId Index of the receipt to burn.
    /// @param shares Amount of shares received by user.
    event UnlockSharesFromNFT(address indexed user, uint256 receiptId, uint256 shares);

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
    // error InitialSharesAreUnwithdrawable();

    modifier OnlyEOW() {
        if (msg.sender != tx.origin) revert NotCallableByContracts();
        _;
    }

    struct StrategyInfo {
        address strategyAddress;
        address depositAssetAddress;
        uint256 batchingBalance;
        uint256 weight;
    }

    struct Cycle {
        uint256 startAt;
        uint256 pricePerShare;
        uint256 totalInBatch;
        uint256 receivedByStrats;
        uint256 totalDepositUniform;
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
    // address[] private stablecoinsArray;
    mapping(address => bool) private stablecoinsMap;
    mapping(uint256 => Cycle) public cycles;

    constructor() {
        receiptContract = new ReceiptNFT();
        sharesToken = new SharesToken();
        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    /// @notice Deposit money collected in the batching into strategies.
    /// @notice Callable by anyone when `cycleDuration` seconds has been passed or 
    ///         batch has reached `minUsdPerCycle` amount of coins.
    /// @dev Only callable by user wallets.
    function depositToStrategies() external OnlyEOW {
        if (cycles[currentCycleId].startAt + cycleDuration > block.timestamp
            && cycles[currentCycleId].totalInBatch < minUsdPerCycle)
            revert CycleNotClosableYet();

        // console.log("~~~~~~~~~~~~~ depositToStrategies ~~~~~~~~~~~~~");

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // get total strategies balance after compound
        (uint256 balanceAfterCompound, ) = viewStrategiesBalance();
        uint256 totalDepositUniform;
        for (uint256 i; i < len; i++) {
            // deposit to strategy
            IERC20 strategyAssetAddress = IERC20(
                strategies[i].depositAssetAddress
            );

            uint256 depositAmount = strategies[i].batchingBalance;
            strategyAssetAddress.transfer(
                strategies[i].strategyAddress,
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
            totalDepositUniform += toUniform(
                depositAmount,
                address(strategyAssetAddress)
            );
            // console.log("depositAmount %s leftoverAmount %s", depositAmount);
            strategies[i].batchingBalance = 0;
        }

        // get total strategies balance after deposit
        (uint256 balanceAfterDeposit, ) = viewStrategiesBalance();
        uint256 receivedByStrats = balanceAfterDeposit - balanceAfterCompound;

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
            sharesToken.mint(address(this), newShares);
        }

        // start new cycle
        cycles[currentCycleId].receivedByStrats = receivedByStrats;
        cycles[currentCycleId].totalDepositUniform = totalDepositUniform;
        emit DepositToStrategies(currentCycleId, receivedByStrats);
        currentCycleId++;
        cycles[currentCycleId].startAt = block.timestamp;
    }

    /// @notice Compound all strategies and update price per share.
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

    /// @dev Returns strategy weight as percent of weight of all strategies.
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

    /// @notice Returns amount of usd in strategies.
    /// @notice All returned numbers have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total amount of usd in strategies.
    /// @return balances Array of usd amount in each strategy.
    function viewStrategiesBalance()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](strategies.length);
        for (uint256 i; i < balances.length; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 balance = IStrategy(strategies[i].strategyAddress)
                .totalTokens();
            balance = toUniform(balance, strategyAssetAddress);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    /// @notice Returns amount of usd to be deposited into strategies.
    /// @notice All returned numbers have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total amount of usd to be deposited into strategies.
    /// @return balances Array of usd amount to be deposited into each strategy.
    function viewBatchingBalance()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](strategies.length);
        for (uint256 i; i < balances.length; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            // uint256 balance = ERC20(strategyAssetAddress).balanceOf(
            //     address(this)
            // );
            // batchingBalance is in token decimals
            uint256 balance = strategies[i].batchingBalance;
            balance = toUniform(balance, strategyAssetAddress);
            balances[i] = balance;
            totalBalance += balance;
        }
    }

    // User Functions

    /// @notice Convert receipt NFT into share tokens.
    ///         Cycle noted in receipt should be closed.
    function unlockSharesFromNFT(uint256 receiptId)
        public
        OnlyEOW
        returns (uint256 receivedShares)
    {
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();
        if (receiptContract.ownerOf(receiptId) != msg.sender)
            revert NotReceiptOwner();

        // console.log("~~~~~~~~~~~~~ unlockSharesFromNFT ~~~~~~~~~~~~~");

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
            receiptId
        );
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        receiptContract.burn(receiptId);

        receipt.amount = 
            receipt.amount * 
            cycles[receipt.cycleId].receivedByStrats /
            cycles[receipt.cycleId].totalDepositUniform;
        uint256 userShares = receipt.amount /
            cycles[receipt.cycleId].pricePerShare;
        // console.log(
        //     "receipt.amount %s, receipt pps %s, userShares %s",
        //     receipt.amount,
        //     cycles[receipt.cycleId].pricePerShare,
        //     userShares
        // );
        sharesToken.transfer(msg.sender, userShares);
        emit UnlockSharesFromNFT(msg.sender, receiptId, userShares);
        return userShares;
    }

    /// @notice User withdraw usd from strategies via receipt NFT.
    /// @notice On partial withdraw leftover shares transfered to user.
    /// @notice Receipt is burned.
    /// @param receiptId Receipt NFT id.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param percent Percent of shares from receipt to withdraw.
    /// @dev Cycle noted in receipt must be closed.
    /// @dev Only callable by user wallets.  
    // TODO: percent param maybe need to be changed, for example to token amount or shares amount
    function withdrawByReceipt(
        uint256 receiptId,
        address withdrawToken,
        uint256 percent
    ) external OnlyEOW {
        // if (receiptId == 0) revert InitialSharesAreUnwithdrawable();
        if (receiptContract.ownerOf(receiptId) != msg.sender)
            revert NotReceiptOwner();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();
        if (percent > 1e4 || percent == 0) revert BadPercent();

        // console.log("~~~~~~~~~~~~~ withdrawByReceipt ~~~~~~~~~~~~~");

        uint256 amountWithdrawShares;
        {
            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            if (receipt.cycleId == currentCycleId) revert CycleNotClosed();
            receiptContract.burn(receiptId);

            receipt.amount = 
                receipt.amount * 
                cycles[receipt.cycleId].receivedByStrats /
                cycles[receipt.cycleId].totalDepositUniform;
            // console.log(
            //     "receipt.amount %s, receivedByStrats %s, totalDepositUniform %s",
            //     receipt.amount,
            //     cycles[receipt.cycleId].receivedByStrats,
            //     cycles[receipt.cycleId].totalDepositUniform
            // );
            uint256 userShares = receipt.amount /
                cycles[receipt.cycleId].pricePerShare;
            amountWithdrawShares = (userShares * percent) / 1e4;
            // console.log(
            //     "receipt.cycleId %s, userShares %s, receipt.pps %s",
            //     receipt.cycleId,
            //     userShares,
            //     cycles[receipt.cycleId].pricePerShare
            // );
            // console.log(
            //     "amountWithdrawShares %s, total shares: %s, router shares %s",
            //     amountWithdrawShares,
            //     sharesToken.totalSupply(),
            //     sharesToken.balanceOf(address(this))
            // );
            // all shares are minted to this contract, transfer to user his part
            // because he had only NFT, not shares token
            uint256 unlocked = userShares - amountWithdrawShares;
            if(unlocked > 0) {
                sharesToken.transfer(msg.sender, unlocked);
                emit UnlockSharesFromNFT(msg.sender, receiptId, unlocked);
            }
        }

        (
            uint256 strategiesBalance,
            uint256[] memory balances
        ) = viewStrategiesBalance();
        uint256 withdrawAmountTotal;
        {
            uint256 currentPricePerShare = strategiesBalance /
                sharesToken.totalSupply();
            withdrawAmountTotal = amountWithdrawShares * currentPricePerShare;
        }

        // console.log(
        //     "withdrawAmountTotal %s, strategiesBalance %s",
        //     withdrawAmountTotal,
        //     strategiesBalance
        // );

        uint256 amountToTransfer = _withdrawByReceipt(
            withdrawAmountTotal,
            strategiesBalance,
            balances,
            withdrawToken
        );

        (strategiesBalance, ) = viewStrategiesBalance();
        sharesToken.burn(address(this), amountWithdrawShares);
        // if (sharesToken.totalSupply() == 0)
        //     cycles[currentCycleId].pricePerShare = 0;
        // else
        //     cycles[currentCycleId].pricePerShare =
        //         strategiesBalance /
        //         sharesToken.totalSupply();

        // console.log(
        //     "withdraw token balance %s, total withdraw %s",
        //     IERC20(withdrawToken).balanceOf(address(this)),
        //     amountToTransfer
        // );
        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromStrategies(msg.sender, withdrawToken, amountToTransfer);
    }

    // this function is needed to avoid 'stack too deep' error
    function _withdrawByReceipt(
        uint256 withdrawAmountTotal,
        uint256 strategiesBalance,
        uint256[] memory balances,
        address withdrawToken
    ) private returns (uint256 amountToTransfer) {
        // console.log("~~~~~~~~~~~~~ _withdrawByReceipt ~~~~~~~~~~~~~");
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 withdrawAmount = (withdrawAmountTotal * balances[i]) /
                strategiesBalance;
            // console.log("withdrawAmount", withdrawAmount);
            withdrawAmount = fromUniform(withdrawAmount, strategyAssetAddress);
            // console.log("withdrawAmount", withdrawAmount);
            withdrawAmount = IStrategy(strategies[i].strategyAddress).withdraw(
                withdrawAmount
            );
            // console.log("withdrawAmount", withdrawAmount);

            // console.log(
            //     "iterate strategy",
            //     ERC20(strategyAssetAddress).name(),
            //     ERC20(strategyAssetAddress).decimals()
            // );
            // console.log(
            //     "balances[i] %s strategiesBalance %s",
            //     balances[i],
            //     strategiesBalance
            // );
            if (strategyAssetAddress != withdrawToken) {
                IERC20(strategyAssetAddress).transfer(
                    address(exchange),
                    withdrawAmount
                );
                withdrawAmount = exchange.swapRouted(
                    withdrawAmount,
                    IERC20(strategyAssetAddress),
                    IERC20(withdrawToken),
                    address(this)
                );
            }
            amountToTransfer += withdrawAmount;
        }
    }

    /// @notice User withdraw usd from batching.
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
        uint256 amount
    ) external OnlyEOW {
        if (receiptContract.ownerOf(receiptId) != msg.sender)
            revert NotReceiptOwner();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        // console.log("~~~~~~~~~~~~~ withdrawFromBatching ~~~~~~~~~~~~~");

        {
            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(
                receiptId
            );
            if (receipt.cycleId != currentCycleId) revert CycleClosed();

            if (amount == 0 || receipt.amount < amount) amount = receipt.amount;

            if (amount == receipt.amount) receiptContract.burn(receiptId);
            else receiptContract.setAmount(receiptId, receipt.amount - amount);
        }

        (
            uint256 totalBalance,
            uint256[] memory balances
        ) = viewBatchingBalance();
        // console.log("batchingBalance %s, amount %s", totalBalance, amount);

        uint256 amountToTransfer;
        // uint256 len = strategies.length;
        for (uint256 i; i < strategies.length; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            // split withdraw amount proportionally between strategies
            uint256 amountWithdraw = (amount * balances[i]) / totalBalance;
            amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

            // console.log(
            //     "strategyAssetAddress balance: %s, amountWithdraw: %s, balances[i] %s",
            //     IERC20(strategyAssetAddress).balanceOf(address(this)),
            //     amountWithdraw,
            //     balances[i]
            // );
            strategies[i].batchingBalance -= amountWithdraw;
            // swap strategies tokens to withdraw token
            if (strategyAssetAddress != withdrawToken) {
                IERC20(strategyAssetAddress).transfer(
                    address(exchange),
                    amountWithdraw
                );
                amountWithdraw = exchange.swapRouted(
                    amountWithdraw,
                    IERC20(strategyAssetAddress),
                    IERC20(withdrawToken),
                    address(this)
                );
            }
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

    /// @notice User withdraw usd from strategies using his shares.
    /// @notice Use withdrawByReceipt function to withdraw using receipt NFT.
    /// @param amountWithdrawShares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function withdrawShares(uint256 amountWithdrawShares, address withdrawToken)
        external
        OnlyEOW
    {
        if (sharesToken.balanceOf(msg.sender) < amountWithdrawShares)
            revert InsufficientShares();
        if (supportsCoin(withdrawToken) == false)
            revert UnsupportedStablecoin();

        (
            uint256 strategiesBalance,
            uint256[] memory balances
        ) = viewStrategiesBalance();

        uint256 withdrawAmountTotal;
        {
            // calculate current pps (based on totalTokens function)
            uint256 currentPricePerShare = strategiesBalance /
                sharesToken.totalSupply();
            // withdraw amount based on pps
            withdrawAmountTotal = amountWithdrawShares * currentPricePerShare;
            // console.log("PPS %s", currentPricePerShare);
        }

        // console.log("~~~~~~~~~~~~~ withdrawShares ~~~~~~~~~~~~~");

        // console.log("amountWithdrawShares %s, currentPricePerShare %s, withdrawAmountTotal %s", amountWithdrawShares, currentPricePerShare, withdrawAmountTotal);
        // console.log(
        //     "total shares: %s, router shares %s",
        //     sharesToken.totalSupply(),
        //     sharesToken.balanceOf(address(this))
        // );

        uint256 len = strategies.length;
        uint256 amountToTransfer;
        for (uint256 i; i < len; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 amountWithdraw = (withdrawAmountTotal * balances[i]) /
                strategiesBalance;

            amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

            amountWithdraw = IStrategy(strategies[i].strategyAddress).withdraw(
                amountWithdraw
            );
            // console.log(
            //     "iterate strategy %s, amountWithdraw %s, withdrawn %s",
            //     ERC20(strategyAssetAddress).name(),
            //     amountWithdraw
            // );
            if (strategyAssetAddress != withdrawToken) {
                IERC20(strategyAssetAddress).transfer(
                    address(exchange),
                    amountWithdraw
                );
                amountWithdraw = exchange.swapRouted(
                    amountWithdraw,
                    IERC20(strategyAssetAddress),
                    IERC20(withdrawToken),
                    address(this)
                );
            }
            amountToTransfer += amountWithdraw;
        }

        (strategiesBalance, ) = viewStrategiesBalance();
        sharesToken.burn(msg.sender, amountWithdrawShares);
        // if (sharesToken.totalSupply() == 0)
        //     cycles[currentCycleId].pricePerShare = 0;
        // else
        //     cycles[currentCycleId].pricePerShare =
        //         strategiesBalance /
        //         sharesToken.totalSupply();

        // console.log(
        //     "withdraw token balance %s, total withdraw %s",
        //     IERC20(withdrawToken).balanceOf(address(this)),
        //     amountToTransfer
        // );
        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromStrategies(msg.sender, withdrawToken, amountToTransfer);
    }

    /// @notice Deposit stablecoin into batching.
    /// @notice Tokens immediately swapped to stablecoins required by strategies
    ///         according to their weights, but not deposited into strategies.
    /// @param _depositTokenAddress Supported stablecoin to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `_depositTokenAddress` to this contract.
    /// @dev Only callable by user wallets.
    function depositToBatch(address _depositTokenAddress, uint256 _amount)
        external
        OnlyEOW
    {
        if (!supportsCoin(_depositTokenAddress)) revert UnsupportedStablecoin();
        if (fromUniform(minDeposit, _depositTokenAddress) > _amount) revert DepositUnderMinimum();

        // console.log("~~~~~~~~~~~~~ depositToBatch ~~~~~~~~~~~~~");
        IERC20(_depositTokenAddress).transferFrom(
            msg.sender,
            address(this),
            _amount
        );

        uint256 len = strategies.length;
        uint256 totalDepositAmount;
        for (uint256 i; i < len; i++) {
            // split deposited amount between strats proportionally
            uint256 depositAmount = (_amount * viewStrategyPercentWeight(i)) /
                10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            // swap deposited token to strategy token
            if (strategyAssetAddress != _depositTokenAddress) {
                IERC20(_depositTokenAddress).transfer(
                    address(exchange),
                    depositAmount
                );

                // console.log(
                //     "depositAmount: %s, token: %s",
                //     depositAmount,
                //     ERC20(strategyAssetAddress).name()
                // );
                depositAmount = exchange.swapRouted(
                    depositAmount,
                    IERC20(_depositTokenAddress),
                    IERC20(strategyAssetAddress),
                    address(this)
                );
            }

            strategies[i].batchingBalance += depositAmount;
            totalDepositAmount += changeDecimals(
                depositAmount,
                ERC20(strategyAssetAddress).decimals(),
                UNIFORM_DECIMALS
            );

            // console.log(
            //     "totalDepositAmount: %s, depositAmount: %s, token: %s",
            //     totalDepositAmount,
            //     depositAmount,
            //     ERC20(strategyAssetAddress).name()
            // );
        }
        // console.log(depositAmount , oracle.scalePrice(price, priceDecimals, 18) , ERC20(strategyAssetAddress).decimals());
        // console.log(depositAmount * oracle.scalePrice(price, priceDecimals, 18) / 10**ERC20(strategyAssetAddress).decimals());
        // console.log("totalDepositAmount: %s", totalDepositAmount);
        cycles[currentCycleId].totalInBatch += totalDepositAmount;

        emit Deposit(msg.sender, _depositTokenAddress, _amount);
        receiptContract.mint(currentCycleId, totalDepositAmount, msg.sender);
    }

    // Admin functions

    /// @notice Set address of exchange contract.
    /// @dev Admin function.
    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
    }

    /// @notice Minimum usd needed to be able to close the cycle.
    /// @param amount Amount of usd must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinUsdPerCycle(uint256 amount) external onlyOwner {
        minUsdPerCycle = amount;
    }

    /// @notice Minimum usd allowed to be deposited in the batching.
    /// @param amount Amount of usd must be `UNIFORM_DECIMALS` decimals.
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
                depositAssetAddress: _depositAssetAddress,
                weight: _weight,
                batchingBalance: 0
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

    /// @notice Remove strategy.
    /// @param _strategyId Id of the strategy.
    /// @dev Admin function.
    function removeStrategy(uint256 _strategyId) external onlyOwner {
        // console.log("~~~~~~~~~~~~~ removeStrategy ~~~~~~~~~~~~~");

        StrategyInfo memory removedStrategyInfo = strategies[_strategyId];
        IStrategy removedStrategy = IStrategy(
            removedStrategyInfo.strategyAddress
        );
        address _depositTokenAddress = removedStrategyInfo.depositAssetAddress;

        uint256 len = strategies.length - 1;
        strategies[_strategyId] = strategies[len];
        strategies.pop();

        // compound removed strategy
        removedStrategy.compound();
        // console.log(
        //     "totalTokens %s, balance %s",
        //     removedStrategy.totalTokens(),
        //     IERC20(_depositTokenAddress).balanceOf(
        //         removedStrategyInfo.strategyAddress
        //     )
        // );

        // withdraw all from removed strategy
        uint256 withdrawnAmount = removedStrategy.withdrawAll();

        // compound all strategies
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // get total strategies balance after compound
        // (uint256 balanceAfterCompound, ) = viewStrategiesBalance();

        // deposit withdrawn funds into other strategies
        for (uint256 i; i < len; i++) {
            uint256 depositAmount = (withdrawnAmount *
                viewStrategyPercentWeight(i)) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if (strategyAssetAddress != _depositTokenAddress) {
                IERC20(_depositTokenAddress).transfer(
                    address(exchange),
                    depositAmount
                );

                depositAmount = exchange.swapRouted(
                    depositAmount,
                    IERC20(_depositTokenAddress),
                    IERC20(strategyAssetAddress),
                    address(this)
                );
            }

            IERC20(strategyAssetAddress).transfer(
                strategies[i].strategyAddress,
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
            // console.log("deposit price: %s, amount: %s, token: %s", totalDepositAmount, depositAmount, ERC20(strategyAssetAddress).name());
        }
        // console.log("balanceAfterDeposit %s, balanceAfterCompound %s, pps before math", balanceAfterDeposit, balanceAfterCompound, cycles[currentCycleId].pricePerShare);
        // console.log("final pps %s, shares %s", cycles[currentCycleId].pricePerShare, sharesToken.totalSupply());
    }

    /// @notice Rebalance strategies.
    /// @param tempAsset Strategies assets will be swapped to this intermediary asset
    ///                  which then will be swapped back into strategies assets according to their weights.
    /// @dev Admin function.
    // TODO: need to rebalance batching also
    function rebalance(address tempAsset) external onlyOwner {
        // console.log("~~~~~~~~~~~~~ rebalance ~~~~~~~~~~~~~");
        uint256 len = strategies.length;

        (
            uint256 totalBalance,
            uint256[] memory balances
        ) = viewStrategiesBalance();
        uint256[] memory toAdd = new uint256[](len);
        uint256 totalSold;
        uint256 totalToAdd;

        for (uint256 i; i < len; i++) {
            uint256 desiredBalance = (totalBalance *
                viewStrategyPercentWeight(i)) / 10000;
            if (desiredBalance > balances[i]) {
                toAdd[i] = desiredBalance - balances[i];
                totalToAdd += toAdd[i];
            } else if (desiredBalance < balances[i]) {
                address strategyAssetAddress = strategies[i]
                    .depositAssetAddress;
                uint256 amountSell = balances[i] - desiredBalance;
                amountSell = fromUniform(amountSell, strategyAssetAddress);
                amountSell = IStrategy(strategies[i].strategyAddress).withdraw(
                    amountSell
                );
                if (strategyAssetAddress != tempAsset) {
                    IERC20(strategyAssetAddress).transfer(
                        address(exchange),
                        amountSell
                    );
                    amountSell = exchange.swapRouted(
                        amountSell,
                        IERC20(strategyAssetAddress),
                        IERC20(tempAsset),
                        address(this)
                    );
                }
                totalSold += amountSell;
            }
        }

        for (uint256 i; i < len; i++) {
            // TODO: probably need check that toAdd is greater than some value (such as 1 ust)
            // similar should be in first loop, because swaps may fail due to too low amounts
            if(toAdd[i] == 0) continue;
            uint256 curAdd = (totalSold * toAdd[i]) / totalToAdd;
            // console.log(
            //     "curAdd: %s totalSold: %s toAdd[i]: %s",
            //     totalToAdd,
            //     totalSold,
            //     toAdd[i]
            // );
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if (strategyAssetAddress != tempAsset) {
                IERC20(tempAsset).transfer(address(exchange), curAdd);

                // console.log("before swap: %s,", curAdd);
                curAdd = exchange.swapRouted(
                    curAdd,
                    IERC20(tempAsset),
                    IERC20(strategyAssetAddress),
                    address(this)
                );
                // console.log("after swap: %s,", curAdd);
            }

            IERC20(strategyAssetAddress).transfer(
                strategies[i].strategyAddress,
                curAdd
            );
            // console.log("token: %s", ERC20(strategyAssetAddress).name());
            // console.log(
            //     "balance: %s, weight %s",
            //     ERC20(strategyAssetAddress).balanceOf(address(this)),
            //     viewStrategyPercentWeight(i)
            // );
            IStrategy(strategies[i].strategyAddress).deposit(curAdd);
        }
        // console.log("balanceAfterDeposit %s, balanceAfterCompound %s, pps before math", balanceAfterDeposit, balanceAfterCompound, cycles[currentCycleId].pricePerShare);
        // console.log(
        //     "temp token at the end %s",
        //     ERC20(tempAsset).balanceOf(address(this))
        // );
    }

    // function withdrawFromStrategy(uint256 _strategyId) external onlyOwner {}

    /// @notice Add supported stablecoind for deposits.
    /// @dev Admin function.
    function setSupportedStablecoin(address stablecoinAddress, bool supported)
        external
        onlyOwner
    {
        if (supported && supportsCoin(stablecoinAddress))
            revert AlreadyAddedStablecoin();

        stablecoinsMap[stablecoinAddress] = supported;
        if (supported) {
            stablecoins.push(stablecoinAddress);
        } else {
            for (uint256 i = 0; i < stablecoins.length; i++) {
                if (stablecoins[i] == stablecoinAddress) {
                    stablecoins[i] = stablecoins[stablecoins.length - 1];
                    stablecoins.pop();
                    break;
                }
            }
        }
    }

    // Internals

    /// @dev Change decimal places from `oldDecimals` to `newDecimals`.
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
