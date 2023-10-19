//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IThenaGaugeV2 {

    ///@notice balance of a user
    function balanceOf(address) external view returns (uint256);

    ///@notice see earned rewards for user
    function earned(address) external view returns (uint256);

    ///@notice deposit all TOKEN of msg.sender
    function depositAll() external;

    ///@notice deposit amount TOKEN
    function deposit(uint256) external;

    ///@notice withdraw all token
    function withdrawAll() external;

    ///@notice withdraw a certain amount of TOKEN
    function withdraw(uint256) external;

    ///@notice withdraw all TOKEN and harvest rewardToken
    function withdrawAllAndHarvest() external;

     ///@notice User harvest function
    function getReward() external;
}