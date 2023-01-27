pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// this strategy mocks situation when an external protocol withdraws amount less than the amount requested
// for withdrawal
// e.g. is is requested to withdraw 100 BUSD from Dodo, but the actual withdrawn amount is 80 BUSD due to other
// 20 BUSD locked by Dodo (not by Clip)
contract UnderFulfilledWithdrawalMockStrategy is Ownable, IStrategy {
    // Defines how much less amount is withdrawn in bps than requested
    // E.g. 2000 means that withdraw will give amount less by 20% than requested
    uint16 private underFulfilledWithdrawalInBps;
    address private strategyDepositToken;
    uint256 private balanceInToken;
    uint256 private rewardPerCompoundPeriodInBps;
    bool private tvlGrow;

    constructor(uint16 _underFulfilledWithdrawalInBps, address _depositToken, uint256 _rewardPerCompoundPeriodInBps, bool _tvlGrow) {
        underFulfilledWithdrawalInBps = _underFulfilledWithdrawalInBps;
        strategyDepositToken = _depositToken;
        rewardPerCompoundPeriodInBps = _rewardPerCompoundPeriodInBps;
        tvlGrow = _tvlGrow;
    }

    function depositToken() external view override returns (address) {
        return strategyDepositToken;
    }

    function deposit(uint256 amount) external override {
        balanceInToken += amount;
    }

    function withdraw(uint256 amount)
        external
        override
        returns (uint256 amountWithdrawn)
    {
        amountWithdrawn = amount * (10000 - underFulfilledWithdrawalInBps) / 10000;
        balanceInToken -= amountWithdrawn;
        ERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
    }

    function compound() external override {
        if (tvlGrow) balanceInToken = (balanceInToken * (10000 + rewardPerCompoundPeriodInBps )) / 10000;
        else balanceInToken = (balanceInToken * (10000 - rewardPerCompoundPeriodInBps )) / 10000;
    }

    function totalTokens() external view override returns (uint256) {
        return balanceInToken;
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn) {
        if (balanceInToken > 0) {
            amountWithdrawn = balanceInToken * (10000 - underFulfilledWithdrawalInBps) / 10000;
            ERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
        }
    }
}