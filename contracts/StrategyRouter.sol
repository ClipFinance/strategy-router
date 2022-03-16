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

    error AlreadyAddedStablecoin();
    error UnsupportedStablecoin();
    error NotReceiptOwner();
    error CycleNotClosed();
    error CycleClosed();
    error InsufficientShares();
    error DuplicateStrategy();

    struct Strategy {
        address strategyAddress;
        address depositAssetAddress;
        uint256 weight;
    }

    struct Cycle {
        uint256 startAt;
        uint256 pricePerShare;
        uint256 depositedAmount;
    }

    uint256 public constant CYCLE_DURATION = 1 days;
    uint8 public constant UNIFORM_DECIMALS = 18;
    uint256 public constant INITIAL_SHARES = 1e6;

    uint256 public currentCycleId;
    uint256 public minUsdPerCycle;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    SharesToken public sharesToken;

    Strategy[] public strategies;
    address[] private stablecoins;
    // address[] private stablecoinsArray;
    // mapping(address => bool) private stablecoins;
    mapping(uint256 => Cycle) public cycles; 

    constructor (
    ) {
        exchange = new Exchange();
        receiptContract = new ReceiptNFT();
        sharesToken = new SharesToken();

        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    /// @notice Deposit money collected in the batching to strategies.
    function depositToStrategies() external {

        require(cycles[currentCycleId].startAt + CYCLE_DURATION < block.timestamp);
        require(cycles[currentCycleId].depositedAmount >= minUsdPerCycle);

        console.log("~~~~~~~~~~~~~ depositToStrategies ~~~~~~~~~~~~~");

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy 
            IStrategy(strategies[i].strategyAddress).compound();
        }
        
        // get total strategies balance after compound
        (uint256 balanceAfterCompound, ) = viewStrategiesBalance();

        for (uint256 i; i < len; i++) {
            // deposit to strategy
            IERC20 strategyAssetAddress = IERC20(strategies[i].depositAssetAddress);
            uint256 depositAmount = strategyAssetAddress.balanceOf(address(this));
            strategyAssetAddress.approve(
                strategies[i].strategyAddress, 
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
        }

        // get total strategies balance after deposit
        (uint256 balanceAfterDeposit, ) = viewStrategiesBalance();

        console.log("balanceAfterDeposit %s, balanceAfterCompound %s, pps before math", balanceAfterDeposit, balanceAfterCompound, cycles[currentCycleId].pricePerShare);

        uint256 totalShares = sharesToken.totalSupply();
        if(totalShares == 0) {
            sharesToken.mint(address(this), INITIAL_SHARES);
            cycles[currentCycleId].pricePerShare = balanceAfterDeposit / sharesToken.totalSupply();
        } else {
            cycles[currentCycleId].pricePerShare = balanceAfterCompound / totalShares;
            uint256 newShares = balanceAfterDeposit / cycles[currentCycleId].pricePerShare - totalShares;
            sharesToken.mint(address(this), newShares);
        }

        console.log("final pps %s, shares %s", cycles[currentCycleId].pricePerShare, sharesToken.totalSupply());

        // start new cycle
        currentCycleId++;
        cycles[currentCycleId].startAt = block.timestamp;

    }

    /// @notice Compound all strategies and update price per share.
    function compoundAll() external {
        if(sharesToken.totalSupply() == 0) revert();

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }
                
        // get balance after compound
        (uint256 balanceAfterCompound, ) = viewStrategiesBalance();

        cycles[currentCycleId].pricePerShare = balanceAfterCompound / sharesToken.totalSupply();
    }

    /// @dev Returns list of supported stablecoins.
    function viewStablecoins()
        public
        view
        returns (address[] memory)
    {
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
            strategies[_strategyId].weight * 1e4 / totalStrategyWeight;
            
        return strategyPercentAllocation;
    }

    /// @notice Returns count of strategies.
    function viewStrategiesCount() 
        public 
        view 
        returns (uint256 count) 
    {
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
            uint256 balance = IStrategy(strategies[i].strategyAddress).totalTokens();
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
            uint256 balance = ERC20(strategyAssetAddress).balanceOf(address(this));
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
        returns (uint256 receivedShares)
    {
        if (receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();

        console.log("~~~~~~~~~~~~~ unlockSharesFromNFT ~~~~~~~~~~~~~");

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        receiptContract.burn(receiptId);

        uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
        console.log("receipt.amount %s, receipt pps %s, userShares %s", receipt.amount, cycles[receipt.cycleId].pricePerShare, userShares);
        sharesToken.transfer(msg.sender, userShares);
        return userShares;
    }

    /// @notice User withdraw usd from strategies via receipt NFT.
    /// @notice On partial withdraw user will receive leftover amount of shares.
    /// @notice Receipt is burned.
    /// @param receiptId Receipt NFT id.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount to withdraw, put 0 to withdraw all. Must be `UNIFORM_DECIMALS` decimals.
    /// @dev Cycle noted in receipt must be closed.
    function withdrawByReceipt(
        uint256 receiptId,
        address withdrawToken, 
        uint256 amount
    ) external {
        if (receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();
        if (supportsCoin(withdrawToken) == false) revert UnsupportedStablecoin();

        console.log("~~~~~~~~~~~~~ withdrawByReceipt ~~~~~~~~~~~~~");
        
        uint256 amountWithdrawShares;
        {
            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
            if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

            if (amount == 0 || receipt.amount < amount) 
                amount = receipt.amount;

            receiptContract.burn(receiptId);

            uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
            amountWithdrawShares = userShares * amount / receipt.amount;
            console.log("amountWithdrawShares %s, total shares: %s, router shares %s", amountWithdrawShares, sharesToken.totalSupply(), sharesToken.balanceOf(address(this)));
            // all shares are minted to this contract, transfer to user his part
            sharesToken.transfer(msg.sender, userShares - amountWithdrawShares);
        }

        (uint256 strategiesBalance, uint256[] memory balances) = viewStrategiesBalance();
        uint256 withdrawAmountTotal;
        {
            uint256 currentPricePerShare = strategiesBalance / sharesToken.totalSupply();
            withdrawAmountTotal = amountWithdrawShares * currentPricePerShare;
        }

        console.log("withdrawAmountTotal %s, strategiesBalance %s", withdrawAmountTotal, strategiesBalance);

        uint256 amountToTransfer = _withdrawByReceipt(withdrawAmountTotal, strategiesBalance, balances, withdrawToken);

        (strategiesBalance, ) = viewStrategiesBalance();
        sharesToken.burn(address(this), amountWithdrawShares);
        if (sharesToken.totalSupply() == 0) cycles[currentCycleId].pricePerShare = 0;
        else cycles[currentCycleId].pricePerShare = strategiesBalance / sharesToken.totalSupply();
    

        console.log("withdraw token balance %s, total withdraw %s", IERC20(withdrawToken).balanceOf(address(this)), amountToTransfer);
        IERC20(withdrawToken).transfer(
            msg.sender, 
           amountToTransfer 
        );
    }

    // this function is needed to avoid 'stack too deep' error
    function _withdrawByReceipt(
        uint256 withdrawAmountTotal, 
        uint256 strategiesBalance,
        uint256[] memory balances,
        address withdrawToken
    ) private returns (uint256 amountToTransfer) {
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {

            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 withdrawAmount = withdrawAmountTotal * balances[i] / strategiesBalance;
            withdrawAmount = fromUniform(withdrawAmount, strategyAssetAddress);
            withdrawAmount = IStrategy(strategies[i].strategyAddress).withdraw(withdrawAmount);

            console.log("iterate strategy", ERC20(strategyAssetAddress).name(), ERC20(strategyAssetAddress).decimals(), withdrawAmount);
            if (strategyAssetAddress != withdrawToken){
                IERC20(strategyAssetAddress).transfer(
                    address(exchange), 
                    withdrawAmount
                );
                withdrawAmount = exchange.swapExactTokensForTokens(
                    withdrawAmount,
                    IERC20(strategyAssetAddress), 
                    IERC20(withdrawToken)
                );
            }
            amountToTransfer += withdrawAmount;
        }
    }

    /// @notice User withdraw usd from batching.
    /// @notice On partial withdraw user amount noted in receipt is updated.
    /// @notice Receipt is burned when withdrawing whole amount.
    /// @param receiptId Receipt NFT id.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    /// @param amount Amount to withdraw, put 0 to withdraw all. Must be `UNIFORM_DECIMALS` decimals.
    /// @dev Cycle noted in receipt must match current cycle.
    function withdrawFromBatching(
        uint256 receiptId, 
        address withdrawToken, 
        uint256 amount
    ) external {
        if (receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();
        if (supportsCoin(withdrawToken) == false) revert UnsupportedStablecoin();

        console.log("~~~~~~~~~~~~~ withdrawFromBatching ~~~~~~~~~~~~~");

        {
            ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
            if (receipt.cycleId != currentCycleId) revert CycleClosed();

            if (amount == 0 || receipt.amount < amount) 
                amount = receipt.amount;

            if (amount == receipt.amount) receiptContract.burn(receiptId);
            else receiptContract.setAmount(receiptId, receipt.amount - amount);
        }

        (uint256 totalBalance, uint256[] memory balances) = viewBatchingBalance();
        console.log("batchingBalance", totalBalance);

        uint256 amountToTransfer;
        // uint256 len = strategies.length;
        for (uint256 i; i < strategies.length; i++) {

            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 amountWithdraw = amount * balances[i] / totalBalance;
            amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

            console.log("strategyAssetAddress balance: %s, amountWithdraw: %s", IERC20(strategyAssetAddress).balanceOf(address(this)), amountWithdraw);
            if (strategyAssetAddress != withdrawToken){
                IERC20(strategyAssetAddress).transfer(
                    address(exchange), 
                    amountWithdraw
                );
                amountWithdraw = exchange.swapExactTokensForTokens(
                    amountWithdraw,
                    IERC20(strategyAssetAddress), 
                    IERC20(withdrawToken)
                );
            }
            amountToTransfer += amountWithdraw;
        }
        cycles[currentCycleId].depositedAmount -= amount;
        

        console.log("withdraw token balance %s, total withdraw %s", IERC20(withdrawToken).balanceOf(address(this)), amountToTransfer);
        IERC20(withdrawToken).transfer(
            msg.sender, 
           amountToTransfer 
        );
    }

    /// @notice User withdraw usd from strategies using his shares.
    /// @notice Use withdrawByReceipt function to withdraw using receipt NFT.
    /// @param amountWithdrawShares Amount of shares to withdraw.
    /// @param withdrawToken Supported stablecoin that user wish to receive.
    function withdrawShares(
        uint256 amountWithdrawShares, 
        address withdrawToken
    ) external {
        if (sharesToken.balanceOf(msg.sender) < amountWithdrawShares) revert InsufficientShares();
        if (supportsCoin(withdrawToken) == false) revert UnsupportedStablecoin();
        
        uint256 withdrawAmountTotal;
        (uint256 strategiesBalance, uint256[] memory balances) = viewStrategiesBalance();
        {
            uint256 currentPricePerShare = strategiesBalance / sharesToken.totalSupply();
            withdrawAmountTotal = amountWithdrawShares * currentPricePerShare;
        }

        console.log("~~~~~~~~~~~~~ withdrawShares ~~~~~~~~~~~~~");

        // console.log("amountWithdrawShares %s, currentPricePerShare %s, withdrawAmountTotal %s", amountWithdrawShares, currentPricePerShare, withdrawAmountTotal);
        console.log("total shares: %s, router shares %s", sharesToken.totalSupply(), sharesToken.balanceOf(address(this)));

        uint256 len = strategies.length;
        uint256 amountToTransfer;
        for (uint256 i; i < len; i++) {

            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 amountWithdraw = withdrawAmountTotal * balances[i] / strategiesBalance;
    
            amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

            amountWithdraw = IStrategy(strategies[i].strategyAddress).withdraw(amountWithdraw);
            console.log("iterate strategy %s, amountWithdraw %s, withdrawn %s", ERC20(strategyAssetAddress).name(), amountWithdraw);
            if (strategyAssetAddress != withdrawToken){
                IERC20(strategyAssetAddress).transfer(
                    address(exchange), 
                    amountWithdraw
                );
                amountWithdraw = exchange.swapExactTokensForTokens(
                    amountWithdraw,
                    IERC20(strategyAssetAddress), 
                    IERC20(withdrawToken)
                );
            }
            amountToTransfer += amountWithdraw;
        }

        (strategiesBalance, ) = viewStrategiesBalance();
        sharesToken.burn(msg.sender, amountWithdrawShares);
        if (sharesToken.totalSupply() == 0) cycles[currentCycleId].pricePerShare = 0;
        else cycles[currentCycleId].pricePerShare = strategiesBalance / sharesToken.totalSupply();

        console.log("withdraw token balance %s, total withdraw %s", IERC20(withdrawToken).balanceOf(address(this)), amountToTransfer);
        IERC20(withdrawToken).transfer(
            msg.sender, 
           amountToTransfer 
        );
    }

    /// @notice Deposit stablecoin into batching.
    /// @notice Tokens not sended to strategies immediately,
    ///         but swapped to strategies stables according to weights.
    /// @param _depositTokenAddress Supported stablecoin to deposit.
    /// @param _amount Amount to deposit.
    function depositToBatch(
        address _depositTokenAddress, 
        uint256 _amount
    ) external {
        if (!supportsCoin(_depositTokenAddress)) revert UnsupportedStablecoin();

        console.log("~~~~~~~~~~~~~ depositToBatch ~~~~~~~~~~~~~");
        IERC20(_depositTokenAddress).transferFrom(
            msg.sender, 
            address(this), 
            _amount
        );

        uint256 len = strategies.length;
        uint256 totalDepositAmount;
        for (uint256 i; i < len; i++) {

            uint256 depositAmount = _amount * viewStrategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if (strategyAssetAddress != _depositTokenAddress){

                IERC20(_depositTokenAddress).transfer(
                    address(exchange), 
                    depositAmount
                );

                console.log("depositAmount: %s, token: %s", depositAmount, ERC20(strategyAssetAddress).name());
                depositAmount = exchange.swapExactTokensForTokens(
                    depositAmount,
                    IERC20(_depositTokenAddress),
                    IERC20(strategyAssetAddress) 
                );
            }


            totalDepositAmount += changeDecimals(
                depositAmount, 
                ERC20(strategyAssetAddress).decimals(), 
                UNIFORM_DECIMALS
            );

            console.log("totalDepositAmount: %s, depositAmount: %s, token: %s", totalDepositAmount, depositAmount, ERC20(strategyAssetAddress).name());
        }
        // console.log(depositAmount , oracle.scalePrice(price, priceDecimals, 18) , ERC20(strategyAssetAddress).decimals());
        // console.log(depositAmount * oracle.scalePrice(price, priceDecimals, 18) / 10**ERC20(strategyAssetAddress).decimals());
        console.log("totalDepositAmount: %s", totalDepositAmount);
        cycles[currentCycleId].depositedAmount += totalDepositAmount;

        receiptContract.mint(
            currentCycleId, 
            totalDepositAmount, 
            msg.sender
        );
    }

    // Admin functions


    /// @notice Set address of exchange for any stablecoin swaps.
    /// @dev Exchange contract must be custom, we don't use uniswap or curver directly.
    /// @dev Admin function.
    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
    }

    /// @notice Minimum usd needed to be able to close the cycle.
    /// @param amount Amount of usd must have `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinUsdPerCycle(uint256 amount) external onlyOwner {
        minUsdPerCycle = amount;
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
            if(strategies[i].strategyAddress == _strategyAddress) revert DuplicateStrategy();
        }
        strategies.push(
            Strategy({
                strategyAddress: _strategyAddress,
                depositAssetAddress: _depositAssetAddress,
                weight: _weight
            })
        );
    }

    /// @notice Update strategy weight.
    /// @param _strategyId Id of the strategy.
    /// @param _weight Weight of the strategy.
    /// @dev Admin function.
    function updateStrategy(
        uint256 _strategyId,
        uint256 _weight
    ) external onlyOwner {
        strategies[_strategyId].weight = _weight;
    }

    /// @notice Remove strategy.
    /// @param _strategyId Id of the strategy.
    /// @dev Admin function.
    function removeStrategy(
        uint256 _strategyId
    ) external onlyOwner {
        console.log("~~~~~~~~~~~~~ removeStrategy ~~~~~~~~~~~~~");
        uint256 len = strategies.length;
        Strategy memory removedStrategy = strategies[_strategyId];
        address _depositTokenAddress = removedStrategy.depositAssetAddress;
        strategies[_strategyId] = strategies[len-1];
        strategies.pop();

        // compound removed strategy
        IStrategy(removedStrategy.strategyAddress).compound();
        console.log("totalTokens %s, balance %s", IStrategy(removedStrategy.strategyAddress).totalTokens(), IERC20(_depositTokenAddress).balanceOf(removedStrategy.strategyAddress));
        // withdraw all from removed strategy
        uint256 withdrawnAmount = IStrategy(removedStrategy.strategyAddress).withdraw(
            IStrategy(removedStrategy.strategyAddress).totalTokens()
        );

        // deposit withdrawn funds into other strategies

        len = strategies.length;
        // compound all strategies
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }
        
        // get total strategies balance after compound
        // (uint256 balanceAfterCompound, ) = viewStrategiesBalance();

        for (uint256 i; i < len; i++) {

            uint256 depositAmount = withdrawnAmount * viewStrategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if (strategyAssetAddress != _depositTokenAddress){

                IERC20(_depositTokenAddress).transfer(
                    address(exchange), 
                    depositAmount
                );

                depositAmount = exchange.swapExactTokensForTokens(
                    depositAmount,
                    IERC20(_depositTokenAddress),
                    IERC20(strategyAssetAddress) 
                );
            }

            IERC20(strategyAssetAddress).approve(
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
    function rebalance(address tempAsset) external onlyOwner {
        console.log("~~~~~~~~~~~~~ rebalance ~~~~~~~~~~~~~");
        uint256 len = strategies.length;

        uint256 totalWithdrawn;
        for (uint256 i; i < len; i++) {
            // compound strategy
            IStrategy(strategies[i].strategyAddress).compound();
            // withdraw all tokens
            uint256 withdrawn = IStrategy(strategies[i].strategyAddress).withdraw(
                IStrategy(strategies[i].strategyAddress).totalTokens()
            );
            // swap strategy asset into tempAsset if they are different
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            if(strategyAssetAddress != tempAsset) {
                IERC20(strategyAssetAddress).transfer(
                    address(exchange), 
                    withdrawn
                );
                withdrawn = exchange.swapExactTokensForTokens(
                    withdrawn,
                    IERC20(strategyAssetAddress),
                    IERC20(tempAsset) 
                );
            }
            console.log("withdrawn: %s,", withdrawn);
            totalWithdrawn += withdrawn;
        }

        for (uint256 i; i < len; i++) {

            uint256 depositAmount = totalWithdrawn * viewStrategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if (strategyAssetAddress != tempAsset){

                IERC20(tempAsset).transfer(
                    address(exchange), 
                    depositAmount
                );

                console.log("before swap: %s,", depositAmount);
                depositAmount = exchange.swapExactTokensForTokens(
                    depositAmount,
                    IERC20(tempAsset),
                    IERC20(strategyAssetAddress) 
                );
                console.log("after swap: %s,", depositAmount);
            }

            IERC20(strategyAssetAddress).approve(
                strategies[i].strategyAddress, 
                depositAmount
            );
            console.log("depositAmount: %s, totalWithdrawn %s, token: %s", depositAmount, totalWithdrawn, ERC20(strategyAssetAddress).name());
            console.log("balance: %s, weight %s", ERC20(strategyAssetAddress).balanceOf(address(this)), viewStrategyPercentWeight(i));
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
        }
        // console.log("balanceAfterDeposit %s, balanceAfterCompound %s, pps before math", balanceAfterDeposit, balanceAfterCompound, cycles[currentCycleId].pricePerShare);
        // console.log("final pps %s, shares %s", cycles[currentCycleId].pricePerShare, sharesToken.totalSupply());
    }

    // function withdrawFromStrategy(uint256 _strategyId) external onlyOwner {}

    /// @notice Add supported stablecoind for deposits.
    /// @dev Admin function.
    function setSupportedStablecoin(address stablecoinAddress, bool supported) 
        external 
        onlyOwner 
    {
        if(supported && supportsCoin(stablecoinAddress)) revert AlreadyAddedStablecoin();

        if(supported) {
            stablecoins.push(stablecoinAddress);
        } else {
            int256 found = -1;
            for (uint256 i = 0; i < stablecoins.length; i++) {
                if(stablecoins[i] == stablecoinAddress) found = int256(i);
            }
            if(found > -1) {
                stablecoins[uint256(found)] = stablecoins[stablecoins.length-1];
                stablecoins.pop();
            }
        }
    }

    // Internals

    /// @dev Change decimal places from `oldDecimals` to `newDecimals`.
    function changeDecimals(uint256 amount, uint8 oldDecimals, uint8 newDecimals)
        private
        pure
        returns (uint256)
    {
        if (oldDecimals < newDecimals) {
            return amount * (10 ** (newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10 ** (oldDecimals - newDecimals));
        }
        return amount;
    }

    /// @dev Change decimal places to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address token)
        private
        view
        returns (uint256)
    {
        return changeDecimals(
            amount, 
            ERC20(token).decimals(),
            UNIFORM_DECIMALS
        );
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address token)
        private
        view
        returns (uint256)
    {
        return changeDecimals(
            amount, 
            UNIFORM_DECIMALS,
            ERC20(token).decimals()
        );
    }

    /// @notice Returns whether provided stablecoin is supported.
    /// @param stablecoinAddress Address to lookup.
    function supportsCoin(address stablecoinAddress) 
        private 
        view 
        returns (bool isSupported) 
    {
        uint256 len = stablecoins.length;
        for (uint256 i = 0; i < len; i++) {
            if(stablecoins[i] == stablecoinAddress) return true;
        }
    }
}
