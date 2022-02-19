//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./ReceiptNFT.sol";

import "hardhat/console.sol";

contract StrategyRouter is Ownable {

    error AlreadyAddedStablecoin();
    error InvalidStablecoin();
    error NotReceiptOwner();

    struct Strategy {
        address strategyAddress;
        address depositAssetAddress;
        uint256 weight;

        uint256 balance;
    }

    struct Cycle {
        uint256 startAt;
        uint256 pricePerShare;
        uint256 totalDeposited;
    }

    uint256 public constant SECONDS_IN_DAY = 1 days;
    uint256 public constant INITIAL_SHARES = 100;

    uint256 public currentCycleId;
    uint256 public minTokenPerCycle;

    // TODO: what these two for?
    uint256 public debtToUsers;
    uint256 public totalWeight;

    uint256 public netAssetValue;
    uint256 public shares;

    ReceiptNFT public receiptContract;
    IUniswapV2Router02 public dex;

    Strategy[] public strategies;
    mapping(address => bool) public stablecoins;
    mapping(uint256 => Cycle) public cycles; 

    constructor (
        // IUniswapV2Router02 _dex
    ) {
        // dex = _dex;
        receiptContract = new ReceiptNFT();

        cycles[currentCycleId].startAt = block.timestamp;
    }

    // Universal Functions

    // Takes money that is collected in the batching contract and deposits it into all strategies.
    function depositToStrategies() external {
        // Has to trigger compound at all strategies.
        // Has to set price her share for the deposited NFT. In this deposit iteration.
        // Sends money to the strategy contract.

        // TODO: this is for simplicity, but later should improve cycle's logic
        require(cycles[currentCycleId].startAt + SECONDS_IN_DAY < block.timestamp);
        require(cycles[currentCycleId].totalDeposited >= minTokenPerCycle);

        uint256 accruedInterest;
        for (uint256 i; i < strategies.length; i++) {
            // trigger compound on strategy and calculate total accrued interest
            accruedInterest += IStrategy(strategies[i].strategyAddress).compound();
            // deposit to strategy
            IERC20(strategies[i].depositAssetAddress).approve(
                strategies[i].strategyAddress, 
                strategies[i].balance
            );
            IStrategy(strategies[i].strategyAddress).deposit(
                strategies[i].balance
            );
            strategies[i].balance = 0;
        }
        
        // TODO: maybe need different approach for NAV calculation
        //       example: sum all strategies NAV and assign it as NAV here
        netAssetValue += accruedInterest;
        cycles[currentCycleId].pricePerShare = netAssetValue / shares;

        // start new cycle
        currentCycleId++;
        cycles[currentCycleId].startAt = block.timestamp;

    }

    // function compoundAll() external {
    //     for (uint256 i; i < strategies.length; i++) {
    //         IStrategy(strategies[i].strategyAddress).compound();
    //     }
    // }

    // function netAssetValueAll() 
    //     public 
    //     view 
    //     returns (uint256 totalNetAssetValue) 
    // {
    //     for (uint256 i; i < strategies.length; i++) {
    //         totalNetAssetValue += IStrategy(strategies[i].strategyAddress).netAssetValue();
    //     }
    //     return totalNetAssetValue;
    // }

    function balanceAll() external {}

    function withdrawDebtToUsers(uint256 receiptId) external {
        if(receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();

        ReceiptNFT.ReceiptData memory receipt = receiptContract.viewReceipt(receiptId);

        uint256 userShares = receipt.amount / cycles[receipt.cycleId].pricePerShare;
        shares -= userShares;

        uint256 userAmount = userShares * cycles[currentCycleId].pricePerShare;

        uint256 totalWithdraw;
        for (uint256 i; i < strategies.length; i++) {
            uint256 amountWithdraw = userAmount * strategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if(strategyAssetAddress == receipt.token){
                // withdraw from batching if user's cycle is current cycle
                if(receipt.cycleId == currentCycleId) {
                    strategies[i].balance -= amountWithdraw;
                    totalWithdraw += amountWithdraw;
                } else {
                    totalWithdraw += IStrategy(strategies[i].strategyAddress).withdraw(
                        amountWithdraw
                    );
                }
            } else {

                if(receipt.cycleId == currentCycleId) {
                    strategies[i].balance -= amountWithdraw;
                    totalWithdraw += amountWithdraw;
                } else {

                    uint256 withdrawn = IStrategy(strategies[i].strategyAddress).withdraw(amountWithdraw);

                    IERC20(strategyAssetAddress).approve(
                        address(dex), 
                        withdrawn
                    );

                    address[] memory path = new address[](3);
                    path[0] = strategyAssetAddress;
                    path[1] = dex.WETH();
                    path[2] = receipt.token;

                    uint256[] memory received = dex.swapExactTokensForTokens(
                        withdrawn,
                        withdrawn * 9995 / 10000,
                        path, 
                        address(this), 
                        block.timestamp + 1200
                    );
                    totalWithdraw += received[2];
                }
            }
        }

        netAssetValue -= totalWithdraw;
        cycles[currentCycleId].totalDeposited -= totalWithdraw;
        IERC20(receipt.token).transferFrom(
            address(this), 
            msg.sender, 
            totalWithdraw
        );
    }

    // User Functions

    function DepositToBatch(address _depositTokenAddress, uint256 _amount) external {
        if(!supportsCoin(_depositTokenAddress)) revert InvalidStablecoin();

        IERC20(_depositTokenAddress).transferFrom(
            msg.sender, 
            address(this), 
            _amount
        );

        uint256 totalDeposited;
        for (uint256 i; i < strategies.length; i++) {

            uint256 depositAmount = _amount * strategyPercentWeight(i) / 10000;
            address strategyAssetAddress = strategies[i].depositAssetAddress;

            if(strategyAssetAddress == _depositTokenAddress){
                strategies[i].balance += depositAmount;
                netAssetValue += depositAmount;
                totalDeposited += depositAmount;
            } else {
                address[] memory path = new address[](3);

                path[0] = _depositTokenAddress;
                path[1] = dex.WETH();
                path[2] = strategyAssetAddress;
                
                IERC20(_depositTokenAddress).approve(
                    address(dex), 
                    depositAmount
                );

                uint256[] memory received = dex.swapExactTokensForTokens(
                    depositAmount, 
                    depositAmount * 9995 / 10000, 
                    path, 
                    address(this), 
                    block.timestamp + 1200
                );

                strategies[i].balance += received[2];
                netAssetValue += received[2];
                totalDeposited += received[2];
            }

        }

        if(shares == 0) shares = INITIAL_SHARES;
        else shares += totalDeposited / cycles[currentCycleId].pricePerShare;

        cycles[currentCycleId].totalDeposited += totalDeposited;
        cycles[currentCycleId].pricePerShare = netAssetValue / shares;

        receiptContract.mint(currentCycleId, totalDeposited, _depositTokenAddress, msg.sender);
    }

    // Admin functions

    function addStrategy(
        address _strategyAddress,
        address _depositAssetAddress,
        uint256 _weight
    ) external onlyOwner {
        strategies.push(
            Strategy({
                strategyAddress: _strategyAddress,
                depositAssetAddress: _depositAssetAddress,
                weight: _weight,
                balance: 0
            })
        );
    }

    function removeStrategy(uint256 _strategyID) external onlyOwner {}

    function withdrawFromStrategy(uint256 _strategyID) external onlyOwner {}

    function addSupportedStablecoin(address _address) external onlyOwner {
        if(stablecoins[_address]) revert AlreadyAddedStablecoin();
        stablecoins[_address] = true;
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

    function updateCycle() private {
        if (
            // cycle should finish if it is 1 day old
            cycles[currentCycleId].startAt + SECONDS_IN_DAY <
            block.timestamp ||
                // or enough usd deposited
                cycles[currentCycleId].totalDeposited >= minTokenPerCycle
        ) {
            // start new cycle
            currentCycleId++;
            cycles[currentCycleId].startAt = block.timestamp;

        }
    }

    /*
     * @title Whether provided stablecoin is supported.
     * @param Address to lookup.
     */

    function supportsCoin(address _address) internal view returns (bool) {
        return stablecoins[_address];
    }
}
