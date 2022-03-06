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
    error InsufficientShares();

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
    // amount of decimals for price and net assetamount 
    uint8 public constant UNIFORM_DECIMALS = 18;
    uint256 public constant INITIAL_SHARES = 1e6;

    uint256 public shares;
    uint256 public currentCycleId;
    uint256 public minUsdPerCycle;

    // uint256 public netAssetValue;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    SharesToken public sharesToken;

    Strategy[] public strategies;
    address[] public stablecoins;
    mapping(uint256 => Cycle) public cycles; 

    constructor (
    ) {
        exchange = new Exchange();
        receiptContract = new ReceiptNFT();
        sharesToken = new SharesToken();

        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    // Takes money that is collected in the batching and deposits it into all strategies.
    function depositToStrategies() external {

        // TODO: this is for simplicity, but later should improve cycle's logic
        require(cycles[currentCycleId].startAt + CYCLE_DURATION < block.timestamp);
        // TODO: might remove depositedAmount and instead get this amount by looking at token balances on this contract
        require(cycles[currentCycleId].depositedAmount >= minUsdPerCycle);

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy 
            IStrategy(strategies[i].strategyAddress).compound();
        }
        
        // get nav after compound
        (uint256 navAfterCompound, ) = netAssetValueAll();

        if(shares == 0) shares = INITIAL_SHARES;
        else if (navAfterCompound > 0) cycles[currentCycleId].pricePerShare = navAfterCompound / shares;

        console.log("navAfterCompound %s, pps %s", navAfterCompound, cycles[currentCycleId].pricePerShare);

        for (uint256 i; i < len; i++) {
            // deposit to strategy
            IERC20 strategyAssetAddress = IERC20(strategies[i].depositAssetAddress);
            uint256 depositAmount = strategyAssetAddress.balanceOf(address(this));
            strategyAssetAddress.approve(
                strategies[i].strategyAddress, 
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
            console.log("deposit to strategies", depositAmount, strategyAssetAddress.balanceOf(strategies[i].strategyAddress));
        }

        // get nav after deposit
        (uint256 nav, ) = netAssetValueAll();

        console.log("nav after deposit", nav);

        if(navAfterCompound == 0) cycles[currentCycleId].pricePerShare = nav / shares;
        else shares = nav / cycles[currentCycleId].pricePerShare;

        console.log("total to strategies", cycles[currentCycleId].pricePerShare, nav);

        // start new cycle
        currentCycleId++;
        cycles[currentCycleId].startAt = block.timestamp;

    }

    // function compoundAll() external {
    //     for (uint256 i; i < strategies.length; i++) {
    //         IStrategy(strategies[i].strategyAddress).compound();
    //     }
    // }

    function netAssetValueAll() 
        public 
        view 
        returns (uint256 totalNetAssetValue, uint256[] memory balanceNAVs) 
    {
        balanceNAVs = new uint256[](strategies.length);
        for (uint256 i; i < balanceNAVs.length; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 balance = IStrategy(strategies[i].strategyAddress).totalTokens();
            balance = toUniform(balance, strategyAssetAddress);
            balanceNAVs[i] = balance;
            totalNetAssetValue += balance;
        }
    }

    /// @dev Returns amount of all strategies assets on this contract, in USD.
    function batchNetAssetValue() 
        public 
        view 
        returns (uint256 totalNetAssetValue, uint256[] memory balanceNAVs) 
    {
        balanceNAVs = new uint256[](strategies.length);
        for (uint256 i; i < balanceNAVs.length; i++) {
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 balance = ERC20(strategyAssetAddress).balanceOf(address(this));
            balance = toUniform(balance, strategyAssetAddress);
            balanceNAVs[i] = balance;
            totalNetAssetValue += balance; 
        }
    }

    function balanceAll() external {}

    // User Functions

    function unlockSharesFromNFT(uint256 receiptId) 
        public 
        returns (uint256 mintedShares)
    {
        if(receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
        if(receipt.cycleId == currentCycleId) revert CycleNotClosed();

        receiptContract.burn(receiptId);

        uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
        sharesToken.mint(msg.sender, userShares);
        return userShares;
    }

    /// @notice Withdraw user's usd, will receive stablecoins[0].
    /// @notice When withdrawing partly and cycle is closed then also receives tokens representing shares.
    /// @notice Receipt is burned when withdrawing whole amount or cycle is closed.
    /// @param receiptId Receipt NFT id.
    /// @param amount Amount to withdraw, put 0 to withdraw all. Must be `UNIFORM_DECIMALS` decimals.
    function withdrawDebtToUsers(uint256 receiptId, uint256 amount) external {
        if(receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
        if(amount == 0 || receipt.amount < amount) 
            amount = receipt.amount;
        if(receipt.cycleId != currentCycleId || amount == receipt.amount)
            receiptContract.burn(receiptId);

        uint256 len = strategies.length;
        uint256 amountWithdrawTokens;
        if(receipt.cycleId == currentCycleId) {
            (uint256 batchNAV, uint256[] memory balanceNAVs) = batchNetAssetValue();
            console.log("batchNav", batchNAV);
            for (uint256 i; i < len; i++) {

                address strategyAssetAddress = strategies[i].depositAssetAddress;
                uint256 amountWithdraw = amount * balanceNAVs[i] / batchNAV;
                amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

                console.log("balance: %s, amountWithdraw: %s", IERC20(strategyAssetAddress).balanceOf(address(this)), amountWithdraw);
                if(strategyAssetAddress != stablecoins[0]){
                    IERC20(strategyAssetAddress).transfer(
                        address(exchange), 
                        amountWithdraw
                    );
                    amountWithdraw = exchange.swapExactTokensForTokens(
                        amountWithdraw,
                        IERC20(strategyAssetAddress), 
                        IERC20(stablecoins[0])
                    );
                }
                amountWithdrawTokens += amountWithdraw;
            }
            cycles[currentCycleId].depositedAmount -= amount;
            if(amount > 0 && amount < receipt.amount)
                receiptContract.setAmount(receiptId, receipt.amount - amount);
        } else {

            uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
            uint256 withdrawShares = userShares * amount / receipt.amount;
            sharesToken.mint(msg.sender, userShares - withdrawShares);

            (uint256 strategiesNAV, uint256[] memory balanceNAVs) = netAssetValueAll();
            uint256 currentPricePerShare = strategiesNAV / shares;
            uint256 withdrawAmount = withdrawShares * currentPricePerShare;

            console.log("withdraw", withdrawShares, currentPricePerShare, withdrawAmount);
            console.log("withdraw more info, total shares: %s", shares);

            for (uint256 i; i < len; i++) {

                address strategyAssetAddress = strategies[i].depositAssetAddress;
                uint256 amountWithdraw = withdrawAmount * balanceNAVs[i] / strategiesNAV;
        
                amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

                uint256 withdrawn = IStrategy(strategies[i].strategyAddress).withdraw(amountWithdraw);
                console.log("strategy", ERC20(strategyAssetAddress).name(), amountWithdraw, withdrawn);
                console.log("strategy", ERC20(strategyAssetAddress).decimals());
                if(strategyAssetAddress != stablecoins[0]){
                    IERC20(strategyAssetAddress).transfer(
                        address(exchange), 
                        withdrawn
                    );
                    withdrawn = exchange.swapExactTokensForTokens(
                        withdrawn,
                        IERC20(strategyAssetAddress), 
                        IERC20(stablecoins[0])
                    );
                }
                amountWithdrawTokens += withdrawn;
            }

            (strategiesNAV, ) = netAssetValueAll();
            shares -= withdrawShares;
            if(shares == 0) cycles[currentCycleId].pricePerShare = 0;
            else cycles[currentCycleId].pricePerShare = strategiesNAV / shares;
        }

        console.log("total withdraw", IERC20(stablecoins[0]).balanceOf(address(this)), amountWithdrawTokens);
        IERC20(stablecoins[0]).transfer(
            msg.sender, 
           amountWithdrawTokens 
        );
    }

    function withdrawShares(uint256 withdrawShares) external {
        if(sharesToken.balanceOf(msg.sender) < withdrawShares) revert InsufficientShares();

        uint256 len = strategies.length;
        uint256 amountWithdrawTokens;

        sharesToken.burn(msg.sender, withdrawShares);

        (uint256 strategiesNAV, uint256[] memory balanceNAVs) = netAssetValueAll();
        uint256 currentPricePerShare = strategiesNAV / shares;
        uint256 withdrawAmount = withdrawShares * currentPricePerShare;

        console.log("withdraw", withdrawShares, currentPricePerShare, withdrawAmount);
        console.log("withdraw more info, total shares: %s", shares);

        for (uint256 i; i < len; i++) {

            address strategyAssetAddress = strategies[i].depositAssetAddress;
            uint256 amountWithdraw = withdrawAmount * balanceNAVs[i] / strategiesNAV;
    
            amountWithdraw = fromUniform(amountWithdraw, strategyAssetAddress);

            uint256 withdrawn = IStrategy(strategies[i].strategyAddress).withdraw(amountWithdraw);
            console.log("strategy", ERC20(strategyAssetAddress).name(), amountWithdraw, withdrawn);
            console.log("strategy", ERC20(strategyAssetAddress).decimals());
            if(strategyAssetAddress != stablecoins[0]){
                IERC20(strategyAssetAddress).transfer(
                    address(exchange), 
                    withdrawn
                );
                withdrawn = exchange.swapExactTokensForTokens(
                    withdrawn,
                    IERC20(strategyAssetAddress), 
                    IERC20(stablecoins[0])
                );
            }
            amountWithdrawTokens += withdrawn;
        }

        (strategiesNAV, ) = netAssetValueAll();
        shares -= withdrawShares;
        if(shares == 0) cycles[currentCycleId].pricePerShare = 0;
        else cycles[currentCycleId].pricePerShare = strategiesNAV / shares;

        console.log("total withdraw", IERC20(stablecoins[0]).balanceOf(address(this)), amountWithdrawTokens);
        IERC20(stablecoins[0]).transfer(
            msg.sender, 
           amountWithdrawTokens 
        );
    }

    function depositToBatch(address _depositTokenAddress, uint256 _amount) external {
        if(!supportsCoin(_depositTokenAddress)) revert UnsupportedStablecoin();

        IERC20(_depositTokenAddress).transferFrom(
            msg.sender, 
            address(this), 
            _amount
        );

        uint256 len = strategies.length;
        uint256 totalDepositAmount;
        for (uint256 i; i < len; i++) {

            uint256 depositAmount = _amount * strategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if(strategyAssetAddress != _depositTokenAddress){

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

            totalDepositAmount += changeDecimals(
                depositAmount, 
                ERC20(strategyAssetAddress).decimals(), 
                UNIFORM_DECIMALS
            );

            console.log("deposit price: %s, amount: %s, token: %s", totalDepositAmount, depositAmount, ERC20(strategyAssetAddress).name());
        }
        // console.log(depositAmount , oracle.scalePrice(price, priceDecimals, 18) , ERC20(strategyAssetAddress).decimals());
        // console.log(depositAmount * oracle.scalePrice(price, priceDecimals, 18) / 10**ERC20(strategyAssetAddress).decimals());
        console.log(totalDepositAmount);
        cycles[currentCycleId].depositedAmount += totalDepositAmount;

        receiptContract.mint(
            currentCycleId, 
            totalDepositAmount, 
            _depositTokenAddress, 
            msg.sender
        );
    }

    // Admin functions


    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
    }
    
    function setMinUsdPerCycle(uint256 amount) external onlyOwner {
        minUsdPerCycle = amount;
    }

    function addStrategy(
        address _strategyAddress,
        address _depositAssetAddress,
        uint256 _weight
    ) external onlyOwner {
        if(!supportsCoin(_depositAssetAddress)) revert UnsupportedStablecoin();
        strategies.push(
            Strategy({
                strategyAddress: _strategyAddress,
                depositAssetAddress: _depositAssetAddress,
                weight: _weight
            })
        );
    }

    // function removeStrategy(uint256 _strategyID) external onlyOwner {}

    function withdrawFromStrategy(uint256 _strategyID) external onlyOwner {}

    function addSupportedStablecoin(address stablecoinAddress) 
        external 
        onlyOwner 
    {
        if(supportsCoin(stablecoinAddress)) revert AlreadyAddedStablecoin();
        stablecoins.push(stablecoinAddress);
    }

    // Internals

    function _withdrawFromCurrentCycle(uint256 sharesAmount)
        internal
        view
        returns (uint256 strategyPercentAllocation)
    {
    }

    function strategyPercentWeight(uint256 _strategyID)
        internal
        view
        returns (uint256 strategyPercentAllocation)
    {
        uint256 totalStrategyWeight;
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            totalStrategyWeight += strategies[i].weight;
        }
        strategyPercentAllocation =
            strategies[_strategyID].weight * 1e4 / totalStrategyWeight;
            
        return strategyPercentAllocation;
    }

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

    // function updateCycle() private {
    //     if (
    //         // cycle should finish if it is 1 day old
    //         cycles[currentCycleId].startAt + CYCLE_DURATION <
    //         block.timestamp ||
    //             // or enough usd deposited
    //             cycles[currentCycleId].depositedAmount >= minUsdPerCycle
    //     ) {
    //         // start new cycle
    //         currentCycleId++;
    //         cycles[currentCycleId].startAt = block.timestamp;

    //     }
    // }

    /*
     * @title Whether provided stablecoin is supported.
     * @param Address to lookup.
     */
     function supportsCoin(address stablecoinAddress) 
        private 
        view 
        returns (bool isSupported) 
    {
        uint256 len = stablecoins.length;
        for (uint256 i = 0; i < len; i++) {
            if(stablecoins[i] == stablecoinAddress) return true;
        }
        return false;
     }
}
