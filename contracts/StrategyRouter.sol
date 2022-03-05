//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./ReceiptNFT.sol";
import "./Exchange.sol";
import "./ChainlinkOracle.sol";

import "hardhat/console.sol";

contract StrategyRouter is Ownable {

    error AlreadyAddedStablecoin();
    error UnsupportedStablecoin();
    error NotReceiptOwner();

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
    // amount of decimals for price and net asset value
    uint8 public constant UNIFORM_DECIMALS = 18;
    uint256 public constant SHARES = 1e6;

    uint256 public shares;
    uint256 public currentCycleId;
    uint256 public minUsdPerCycle;

    // uint256 public netAssetValue;

    ReceiptNFT public receiptContract;
    Exchange public exchange;

    Strategy[] public strategies;
    address[] public stablecoins;
    mapping(uint256 => Cycle) public cycles; 

    constructor (
    ) {
        exchange = new Exchange();
        receiptContract = new ReceiptNFT();

        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    // Takes money that is collected in the batching and deposits it into all strategies.
    function depositToStrategies() external {

        // TODO: this is for simplicity, but later should improve cycle's logic
        require(cycles[currentCycleId].startAt + CYCLE_DURATION < block.timestamp);
        // TODO: might remove depositedAmount and instead get this value by looking at token balances on this contract
        require(cycles[currentCycleId].depositedAmount >= minUsdPerCycle);

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy 
            IStrategy(strategies[i].strategyAddress).compound();
        }
        
        // get nav after compound
        (uint256 navAfterCompound, ) = netAssetValueAll();

        if(shares == 0) shares = SHARES;
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

    /// @dev Returns value of all strategies assets on this contract, in USD.
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

    function withdrawDebtToUsers(uint256 receiptId) external {
        if(receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
        receiptContract.burn(receiptId);

        uint256 len = strategies.length;
        uint256 amountWithdrawTokens;
        if(receipt.cycleId == currentCycleId) {
            (uint256 batchNAV, uint256[] memory balanceNAVs) = batchNetAssetValue();
            console.log("batchNav", batchNAV);
            for (uint256 i; i < len; i++) {

                address strategyAssetAddress = strategies[i].depositAssetAddress;
                // calculate proportions using usd values
                uint256 amountWithdraw = receipt.amount * balanceNAVs[i] / batchNAV;
                // convert usd value to token amount
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
            cycles[currentCycleId].depositedAmount -= receipt.amount;
        } else {

            uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
            (uint256 strategiesNAV, uint256[] memory balanceNAVs) = netAssetValueAll();
            uint256 currentPricePerShare = strategiesNAV / shares;
            uint256 userAmount = userShares * currentPricePerShare;

            console.log("withdraw", userShares, currentPricePerShare, userAmount);
            console.log("withdraw more info, total shares: %s", shares);

            for (uint256 i; i < len; i++) {

                address strategyAssetAddress = strategies[i].depositAssetAddress;
                uint256 amountWithdraw = userAmount * balanceNAVs[i] / strategiesNAV;
        
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
            shares -= userShares;
            if(shares == 0) cycles[currentCycleId].pricePerShare = 0;
            else cycles[currentCycleId].pricePerShare = strategiesNAV / shares;
        }

        console.log("total withdraw", IERC20(stablecoins[0]).balanceOf(address(this)), amountWithdrawTokens);
        IERC20(stablecoins[0]).transfer(
            msg.sender, 
           amountWithdrawTokens 
        );
    }

    // User Functions

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
            uint8 strategyAssetDecimals = ERC20(strategyAssetAddress).decimals();

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
                strategyAssetDecimals, 
                UNIFORM_DECIMALS
            );

            console.log("deposit price: %s, value: %s, token: %s", totalDepositAmount, depositAmount, ERC20(strategyAssetAddress).name());
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
    
    function setMinUsdPerCycle(uint256 usdValue) external onlyOwner {
        minUsdPerCycle = usdValue;
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

    function changeDecimals(uint256 value, uint8 valueDecimals, uint8 newDecimals)
        private
        pure
        returns (uint256)
    {
        if (valueDecimals < newDecimals) {
            return value * (10 ** (newDecimals - valueDecimals));
        } else if (valueDecimals > newDecimals) {
            return value / (10 ** (valueDecimals - newDecimals));
        }
        return value;
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
