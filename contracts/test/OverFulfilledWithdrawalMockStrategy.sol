pragma solidity ^0.8.0;

import "./DistortedWithdrawalMockStrategy.sol";

// this strategy mocks situation when an external protocol withdraws amount more than the amount requested
// for withdrawal
// e.g. is is requested to withdraw 100 BUSD from Dodo, but the actual withdrawn amount is 120 BUSD swap profits
// NOTE! has to get extra funds allocated to it to be able to serve overfulfillment
contract OverFulfilledWithdrawalMockStrategy is DistortedWithdrawalMockStrategy {
    constructor(
        uint16 _distortedWithdrawalInBps,
        address _depositToken,
        uint256 _rewardPerCompoundPeriodInBps,
        bool _isRewardPositive,
        uint256 _hardcapTargetInToken,
        uint16 _hardcapDeviationInBps,
        address[] memory depositors
    ) DistortedWithdrawalMockStrategy(
        false,
        _distortedWithdrawalInBps,
        _depositToken,
        _rewardPerCompoundPeriodInBps,
        _isRewardPositive,
        _hardcapTargetInToken,
        _hardcapDeviationInBps,
        depositors
    ) {}
}