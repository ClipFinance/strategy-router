//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IStrategy.sol";

contract StrategyRouter is Ownable {

    error AlreadySupportedStablecoin();
    error InvalidStablecoin();

    struct Strategy {
        address strategyAddress;
        address depositAssetAddress;
        uint256 weight;
    }
    
    mapping(address => bool) public stablecoins;

    Strategy[] public strategies;

    uint256 public currentDepositCycle;
    uint256 public debtToUsers;
    uint256 public totalWeight;

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

        for (uint256 i; i < strategies.length; i++) {
            uint256 depositAmount;
            if(strategies[i].depositAssetAddress == _depositTokenAddress){
                depositAmount = _amount * strategyPercentWeight(i) / 10000;
               IStrategy(strategies[i].strategyAddress).deposit(depositAmount); 
            } else {
                // TODO: NEED TO CONVERT FIRST!!
                depositAmount = _amount;
                IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
            }
        }
        // Check current strategy tokens and weight.
        // Convert token in according to the weight of each strategy


        // Give out NFT
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
            (((strategies[_strategyID].weight * 10**9) / totalStrategyWeight) *
                10000) /
            10**9;
        return strategyPercentAllocation;
    }


   function addSupportedStablecoin(address _address) external onlyOwner {
       if(stablecoins[_address]) revert AlreadySupportedStablecoin();
        stablecoins[_address] = true;
    }

    /*
     * @title Whether provided stablecoin is supported.
     * @param Address to lookup.
     */

    function supportsCoin(address _address) internal view returns (bool) {
        return stablecoins[_address];
    }
}
