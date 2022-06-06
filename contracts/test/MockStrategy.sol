pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "hardhat/console.sol";

contract MockStrategy is Ownable, IStrategy {
    address private _depositToken;
    uint256 private balance;
    uint256 private mockProfitPercent;

    constructor(address depositToken_, uint256 _mockProfitPercent) {
        _depositToken = depositToken_;
        mockProfitPercent = _mockProfitPercent;
    }

    function depositToken() external view override returns (address) {
        return _depositToken;
    }

    function deposit(uint256 amount) external override {
        // console.log("MockStrategy.deposit", amount, ERC20(_depositToken).balanceOf(address(this)));
        balance += amount;
    }

    function withdraw(uint256 amount)
        external
        override
        returns (uint256 amountWithdrawn)
    {
        ERC20(_depositToken).transfer(msg.sender, amount);
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
            ERC20(_depositToken).transfer(msg.sender, amountWithdrawn);
        }
    }
}
