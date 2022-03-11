// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";

/// profitable farm gives x2 on each compound
contract MockFarm {

  address private asset;
  uint256 private balance;
  uint256 private mockProfitPercent;

  constructor(address _asset, uint256 _mockProfitPercent) {
    asset = _asset;
    mockProfitPercent = _mockProfitPercent;
  }

  function deposit(uint256 amount) external {
    ERC20(asset).transferFrom(msg.sender, address(this), amount);
    balance += amount;
  }

  function withdraw(uint256 amount) 
    external 
    returns (uint256 amountWithdrawn) 
  {
    ERC20(asset).transfer(msg.sender, amount);
    balance -= amount;
    return amount;
  }

  function compound() external {
      balance = balance * mockProfitPercent / 10000;
  }

  // function netAssetValue() external view returns (uint256) { }
  
  function totalTokens() external view returns (uint256) {
    return balance;
  }

}