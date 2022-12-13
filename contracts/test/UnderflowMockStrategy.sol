pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract UnderflowMockStrategy is Ownable, IStrategy {
    uint16 private underflowBps;
    address private strategyDepositToken;
    uint256 private balance;
    uint256 private mockProfitPercent;

    constructor(uint16 _underflowBps, address _depositToken, uint256 _mockProfitPercent) {
        underflowBps = _underflowBps;
        strategyDepositToken = _depositToken;
        mockProfitPercent = _mockProfitPercent;
    }

    function depositToken() external view override returns (address) {
        return strategyDepositToken;
    }

    function deposit(uint256 amount) external override {
        balance += amount;
    }

    function withdraw(uint256 amount)
        external
        override
        returns (uint256 amountWithdrawn)
    {
        amountWithdrawn = amount * (10000 - underflowBps) / 10000;
        ERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
        balance -= amountWithdrawn;
    }

    function compound() external override {
        balance = (balance * mockProfitPercent) / 10000;
    }

    function totalTokens() external view override returns (uint256) {
        return balance;
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn) {
        if (balance > 0) {
            amountWithdrawn = balance * (10000 - underflowBps) / 10000;
            ERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
        }
    }
}