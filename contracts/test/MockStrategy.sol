pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "hardhat/console.sol";
import "../strategies/AbstractBaseStrategyWithHardcap.sol";

contract MockStrategy is IStrategy, AbstractBaseStrategyWithHardcap {
    address private _depositToken;
    uint256 private balance;
    uint256 private mockProfitPercent;

    constructor(
        address depositToken_,
        uint256 _mockProfitPercent,
        uint256 _hardcapTargetInToken,
        uint16 _hardcapDeviationInBps
    ) {
        _transferOwnership(_msgSender());
        _depositToken = depositToken_;
        mockProfitPercent = _mockProfitPercent;
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;
    }

    function depositToken() external view override returns (address) {
        return _depositToken;
    }

    function _deposit(uint256 amount) internal override {
        // console.log("MockStrategy.deposit", amount, ERC20(_depositToken).balanceOf(address(this)));
        balance += amount;
    }

    function withdraw(uint256 amount)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        ERC20(_depositToken).transfer(msg.sender, amount);
        balance -= amount;
        return amount;
    }

    function setMockProfitPercent(uint256 _mockProfitPercent) external {
        mockProfitPercent = _mockProfitPercent;
    }

    function compound() external override onlyOwner {
        balance = balance * (1000000 + mockProfitPercent) / 1000000;
    }

    function totalTokens() public view override returns (uint256) {
        return _totalTokens();
    }

    function _totalTokens() internal view override returns (uint256) {
        return balance;
    }

    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        if (balance > 0) {
            amountWithdrawn = balance;
            ERC20(_depositToken).transfer(msg.sender, amountWithdrawn);
        }
    }
}
