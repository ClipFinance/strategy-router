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
        uint256 totalDeposited;
    }

    uint256 public constant CYCLE_DURATION = 1 days;
    // amount of decimals for price and net asset value
    uint8 public constant UNIFORM_DECIMALS = 18;
    // min withdrawable amount is `1e18 - SHARES` due to constant total shares
    // if you deposit less, say goodbye to your dust
    uint256 public constant SHARES = 1e8;

    uint256 public currentCycleId;
    uint256 public minTokenPerCycle;

    // TODO: what these two for?
    uint256 public debtToUsers;
    uint256 public totalWeight;

    // uint256 public netAssetValue;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    ChainlinkOracle public oracle;

    Strategy[] public strategies;
    address[] public stablecoins;
    mapping(uint256 => Cycle) public cycles; 

    constructor (
        // Exchange _exchange
    ) {
        exchange = new Exchange();
        receiptContract = new ReceiptNFT();
        oracle = new ChainlinkOracle(0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf);

        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    // Takes money that is collected in the batching and deposits it into all strategies.
    function depositToStrategies() external {
        // Has to trigger compound at all strategies.
        // Has to set price her share for the deposited NFT. In this deposit iteration.
        // Sends money to the strategy contract.

        // TODO: this is for simplicity, but later should improve cycle's logic
        require(cycles[currentCycleId].startAt + CYCLE_DURATION < block.timestamp);
        require(cycles[currentCycleId].totalDeposited >= minTokenPerCycle);

        for (uint256 i; i < strategies.length; i++) {
            // trigger compound on strategy 
            IStrategy(strategies[i].strategyAddress).compound();
            // deposit to strategy
            IERC20 strategyAssetAddress = IERC20(strategies[i].depositAssetAddress);
            uint256 depositAmount = strategyAssetAddress.balanceOf(address(this));
            strategyAssetAddress.approve(
                strategies[i].strategyAddress, 
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
        }

        cycles[currentCycleId].pricePerShare = netAssetValueAll() / SHARES;

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
        returns (uint256 totalNetAssetValue) 
    {

        for (uint256 i; i < strategies.length; i++) {
            // now has strategy asset's decimals
            uint256 _nav = IStrategy(strategies[i].strategyAddress).netAssetValue();
            // price has its own decimals
            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(
                strategies[i].depositAssetAddress
            );
            // get value in USD, decimals will be adjusted down below
            uint256 usdValue = _nav * price;

            uint8 strategyAssetDecimals = ERC20(strategies[i].depositAssetAddress).decimals();
            // use usd value for nav and unify decimals
            totalNetAssetValue += changeDecimals(
                usdValue, 
                strategyAssetDecimals + priceDecimals, 
                UNIFORM_DECIMALS
            );
        }
        return totalNetAssetValue;
    }

    function balanceAll() external {}

    function withdrawDebtToUsers(uint256 receiptId) external {
        if(receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);
        receiptContract.burn(receiptId);

        uint256 totalWithdraw;
        if(receipt.cycleId == currentCycleId) {
            for (uint256 i; i < strategies.length; i++) {

                address strategyAssetAddress = strategies[i].depositAssetAddress;
                uint256 amountWithdraw = receipt.amount * strategyPercentWeight(i) / 10000;
                (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(strategyAssetAddress);

                amountWithdraw = amountWithdraw / price;
                amountWithdraw = changeDecimals(
                    amountWithdraw,
                    UNIFORM_DECIMALS-priceDecimals,
                    ERC20(strategyAssetAddress).decimals()
                );

                console.log("balance: %s, amountWithdraw: %s", IERC20(strategyAssetAddress).balanceOf(address(this)), amountWithdraw, price);
                if(strategyAssetAddress == stablecoins[0]){
                        totalWithdraw += amountWithdraw;
                } else {

                    IERC20(strategyAssetAddress).transfer(
                        address(exchange), 
                        amountWithdraw
                    );

                    uint256 received = exchange.swapExactTokensForTokens(
                        amountWithdraw,
                        IERC20(strategyAssetAddress), 
                        IERC20(stablecoins[0])
                    );

                    totalWithdraw += received;
                }
            }
            cycles[currentCycleId].totalDeposited -= totalWithdraw;
        } else {

            uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
            uint256 currentPricePerShare = netAssetValueAll() / SHARES;
            uint256 userAmount = userShares * currentPricePerShare;

            for (uint256 i; i < strategies.length; i++) {

                address strategyAssetAddress = strategies[i].depositAssetAddress;
                uint256 amountWithdraw = userAmount * strategyPercentWeight(i) / 10000;

                // TODO: should have price calculations similar to what is above
                // userAmount has unified decimals, need to convert to asset decimals
                amountWithdraw = changeDecimals(
                    amountWithdraw,
                    UNIFORM_DECIMALS,
                    ERC20(strategyAssetAddress).decimals()
                );

                if(strategyAssetAddress == stablecoins[0]){
                    totalWithdraw += IStrategy(strategies[i].strategyAddress).withdraw(
                        amountWithdraw
                    );
                } else {
                    uint256 withdrawn = IStrategy(strategies[i].strategyAddress).withdraw(amountWithdraw);
                    IERC20(strategyAssetAddress).transfer(
                        address(exchange), 
                        withdrawn
                    );
                    uint256 received = exchange.swapExactTokensForTokens(
                        withdrawn,
                        IERC20(strategyAssetAddress), 
                        IERC20(stablecoins[0])
                    );
                    totalWithdraw += received;
                }
            }
        }

        // TODO: for some reason withdraw amount is higher than balance
        console.log(IERC20(stablecoins[0]).balanceOf(address(this)), totalWithdraw);
        IERC20(stablecoins[0]).transfer(
            msg.sender, 
            totalWithdraw
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

        uint256 totalDepositedValue;
        for (uint256 i; i < strategies.length; i++) {

            uint256 depositAmount = _amount * strategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;
            (uint256 price, uint8 priceDecimals) = oracle.getAssetUsdPrice(strategyAssetAddress);

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

            uint8 assetDecimals = ERC20(strategyAssetAddress).decimals();
            totalDepositedValue += changeDecimals(
                depositAmount * price, 
                assetDecimals + priceDecimals, 
                UNIFORM_DECIMALS
            );

            console.log("deposit price: %s, value: %s, token: %s", price, changeDecimals(
                depositAmount * price, 
                assetDecimals + priceDecimals, 
                UNIFORM_DECIMALS
            ), ERC20(strategyAssetAddress).name());
        }
        // console.log(depositAmount , oracle.scalePrice(price, priceDecimals, 18) , ERC20(strategyAssetAddress).decimals());
        // console.log(depositAmount * oracle.scalePrice(price, priceDecimals, 18) / 10**ERC20(strategyAssetAddress).decimals());
        console.log(totalDepositedValue);
        cycles[currentCycleId].totalDeposited += totalDepositedValue;

        receiptContract.mint(
            currentCycleId, 
            totalDepositedValue, 
            _depositTokenAddress, 
            msg.sender
        );
    }

    // Admin functions


    function setExchange(Exchange newExchange) external onlyOwner {
        exchange = newExchange;
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

        for (uint256 i; i < strategies.length; i++) {
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

    // function updateCycle() private {
    //     if (
    //         // cycle should finish if it is 1 day old
    //         cycles[currentCycleId].startAt + CYCLE_DURATION <
    //         block.timestamp ||
    //             // or enough usd deposited
    //             cycles[currentCycleId].totalDeposited >= minTokenPerCycle
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
