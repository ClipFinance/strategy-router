pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IIdleStrategy.sol";

contract UnderFulfilledWithdrawalMockIdleStrategy is IIdleStrategy {
    uint16 private underFulfilledWithdrawalInBps;
    address private strategyDepositToken;

    uint256 public depositCount;
    uint256 public withdrawCount;

    constructor(
        uint16 _underFulfilledWithdrawalInBps,
        address _depositToken
    ) {
        underFulfilledWithdrawalInBps = _underFulfilledWithdrawalInBps;
        strategyDepositToken = _depositToken;
    }

    function depositToken() external view override returns (address) {
        return strategyDepositToken;
    }

    function deposit(uint256 amount) external override {
        depositCount += 1;
    }

    function withdraw(uint256 amount)
        external
        override
        returns (uint256 amountWithdrawn)
    {
        withdrawCount += 1;

        amountWithdrawn = amount * (10000 - underFulfilledWithdrawalInBps) / 10000;

        IERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
    }

    function totalTokens() public view override returns (uint256) {
        return IERC20(strategyDepositToken).balanceOf(address(this));
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn) {
        uint256 balanceInToken = this.totalTokens();
        if (balanceInToken > 0) {
            amountWithdrawn = balanceInToken * (10000 - underFulfilledWithdrawalInBps) / 10000;
            IERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
        }
    }
}
