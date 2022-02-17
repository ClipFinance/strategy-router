//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./ReceiptNFT.sol";

import "hardhat/console.sol";

contract StrategyRouter is Ownable {
    
    event NewCycle(uint256 newCycleId);

    error AlreadyAddedStablecoin();
    error InvalidStablecoin();

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

    uint256 public constant SECONDS_IN_DAY = 1 days;

    uint256 public currentCycleId;

    // TODO: what these two for?
    uint256 public debtToUsers;
    uint256 public totalWeight;

    uint256 public minTokenPerCycle;

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
    }

    function compoundAll() external {}

    function balanceAll() external {}

    function withdrawDebtToUsers() external {}

    // User Functions

    function DepositToBatch(address _depositTokenAddress, uint256 _amount) external {
        if(!supportsCoin(_depositTokenAddress)) revert InvalidStablecoin();

        updateCycle();

        uint256 totalDeposited;

        IERC20(_depositTokenAddress).transferFrom(
            msg.sender, 
            address(this), 
            _amount
        );

        for (uint256 i; i < strategies.length; i++) {

            uint256 depositAmount = _amount * strategyPercentWeight(i) / 10000;
            IStrategy _strategyAddress = IStrategy(strategies[i].strategyAddress);

            if(strategies[i].depositAssetAddress == _depositTokenAddress){

                IERC20(_depositTokenAddress).approve(
                    address(_strategyAddress), 
                    depositAmount
                );
                // TODO: deposit should be moved to separate function,
                //       because here we only accumulating batch deposits
                _strategyAddress.deposit(depositAmount); 
                totalDeposited += depositAmount;

            } else {
                address[] memory path = new address[](3);

                path[0] = _depositTokenAddress;
                path[1] = dex.WETH();
                path[2] = strategies[i].depositAssetAddress;
                
                uint256[] memory amountOutMin = 
                    dex.getAmountsOut(depositAmount, path);

                IERC20(_depositTokenAddress).approve(
                    address(dex), 
                    depositAmount
                );

                uint256[] memory received = dex.swapExactTokensForTokens(
                    depositAmount, 
                    amountOutMin[2], 
                    path, 
                    address(this), 
                    block.timestamp + 1200
                );

                IERC20(strategies[i].depositAssetAddress).approve(
                    address(dex), 
                    received[2]
                );
                _strategyAddress.deposit(received[2]);

                // get value of tokens deposited
                (path[0], path[2]) = (path[2], path[0]);
                uint256[] memory value = 
                    dex.getAmountsOut(received[2], path);
                totalDeposited += value[2];
            }
        }

        cycles[currentCycleId].totalDeposited = totalDeposited;

        // TODO: add cycles instead of 0
        receiptContract.mint(0, totalDeposited, _depositTokenAddress, msg.sender);
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
                weight: _weight
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

                emit NewCycle(counter.current());
            }
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
