pragma solidity ^0.8.0;

import "./DistortedWithdrawalMockStrategy.sol";

// this strategy mocks situation when an external protocol withdraws amount less than the amount requested
// for withdrawal
// e.g. is is requested to withdraw 100 BUSD from Dodo, but the actual withdrawn amount is 80 BUSD due to other
// 20 BUSD locked by Dodo (not by Clip)
contract UnderFulfilledWithdrawalMockStrategy is DistortedWithdrawalMockStrategy {
    constructor(
        uint16 _distortedWithdrawalInBps,
        address _depositToken,
        uint256 _rewardPerCompoundPeriodInBps,
        bool _isRewardPositive,
        uint256 _hardcapTargetInToken,
        uint16 _hardcapDeviationInBps,
        address[] memory depositors
    ) DistortedWithdrawalMockStrategy(
        true,
        _distortedWithdrawalInBps,
        _depositToken,
        _rewardPerCompoundPeriodInBps,
        _isRewardPositive,
        _hardcapTargetInToken,
        _hardcapDeviationInBps,
        depositors
    ) {}
}