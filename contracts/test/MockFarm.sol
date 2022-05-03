// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "hardhat/console.sol";

contract MockFarm is Ownable, IStrategy {
    address private asset;
    uint256 private balance;
    uint256 private mockProfitPercent;

    constructor(address _asset, uint256 _mockProfitPercent) {
        asset = _asset;
        mockProfitPercent = _mockProfitPercent;
    }

    function depositToken() external view override returns (address) {
        return asset;
    }

    function deposit(uint256 amount) external override {
        // console.log("MockFarm.deposit", amount, ERC20(asset).balanceOf(address(this)));
        balance += amount;
    }

    function withdraw(uint256 amount)
        external
        override
        returns (uint256 amountWithdrawn)
    {
        ERC20(asset).transfer(msg.sender, amount);
        balance -= amount;
        return amount;
    }

    function compound() external override {

        balance = (balance * mockProfitPercent) / 10000;
    }

    function totalTokens() external view override returns (uint256) {
        return balance;
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn) {
        if (balance > 0) {
            amountWithdrawn = balance;
            ERC20(asset).transfer(msg.sender, amountWithdrawn);
        }
    }
}
