pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "hardhat/console.sol";
import "../strategies/AbstractBaseStrategyWithHardcap.sol";

contract MockStrategy is Ownable, IStrategy, AbstractBaseStrategyWithHardcap {
    address private _depositToken;
    uint256 private balance;
    uint256 private mockProfitPercent;
    uint256 private hardcapTarget;
    uint8 private hardcapDeviationBp;

    constructor(
        address depositToken_,
        uint256 _mockProfitPercent,
        uint256 _hardcapTargetInToken,
        uint8 _hardcapDeviationInBps
    ) {
        _depositToken = depositToken_;
        mockProfitPercent = _mockProfitPercent;
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;
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

    function setMockProfitPercent(uint256 _mockProfitPercent) external {
        mockProfitPercent = _mockProfitPercent;
    }

    function compound() external override {
        balance = balance * (1000000 + mockProfitPercent) / 1000000;
    }

    function totalTokens() public view override returns (uint256) {
        return balance;
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn) {
        if (balance > 0) {
            amountWithdrawn = balance;
            ERC20(_depositToken).transfer(msg.sender, amountWithdrawn);
        }
    }

    /// @notice Get hardcap target value
    function getHardcardTarget() view public override {
        return hardcapTarget;
    }

    /// @notice Set allowed deviation from target value
    function getHardcardDeviationBp() view public override {
        return hardcapDeviationBp;
    }

    function getCapacityData() view public override returns (bool limitReached, int256 underflow, int256 overflow) {
        uint256 strategyAllocatedTokens = totalTokens();
        uint256 hardcapTarget = getHardcardTarget();
        uint256 hardcapDeviationBp = getHardcardDeviationBp();

        uint256 lowerBound = hardcapTarget - (hardcapTarget * hardcapDeviationBp / 10000);
        uint256 upperBound = hardcapTarget + (hardcapTarget * hardcapDeviationBp / 10000);

        if (strategyAllocatedTokens < lowerBound) {
            return (false, hardcapTarget - strategyAllocatedTokens, 0);
        }

        if (strategyAllocatedTokens > upperBound) {
            return (true, 0, strategyAllocatedTokens - hardcapTarget);
        }

        return (true, 0, 0);
    }
}
