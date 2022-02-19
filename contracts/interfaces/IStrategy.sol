//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IStrategy {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external returns (uint256 amountWithdrawn);
    function compound() external returns (uint256 accruedInterest);
    
    // function netAssetValue() external view returns (uint256);
}