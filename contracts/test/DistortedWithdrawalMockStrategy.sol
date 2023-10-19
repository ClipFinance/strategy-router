pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../strategies/AbstractBaseStrategyWithHardcap.sol";

contract DistortedWithdrawalMockStrategy is IStrategy, AbstractBaseStrategyWithHardcap {
    bool private isUnderFulfilled;
    // Defines how much less amount is withdrawn in bps than requested
    // E.g. 2000 means that withdraw will give amount less by 20% than requested
    uint16 private distortedWithdrawalInBps;
    address private strategyDepositToken;
    uint256 private balanceInToken;
    uint256 private rewardPerCompoundPeriodInBps;
    bool private isRewardPositive;

    uint256 public depositCount;
    uint256 public withdrawCount;

    constructor(
        bool _isUnderFulfilled,
        uint16 _distortedWithdrawalInBps,
        address _depositToken,
        uint256 _rewardPerCompoundPeriodInBps,
        bool _isRewardPositive,
        uint256 _hardcapTargetInToken,
        uint16 _hardcapDeviationInBps,
        address[] memory depositors
    ) {
        _transferOwnership(_msgSender());
        isUnderFulfilled = _isUnderFulfilled;
        distortedWithdrawalInBps = _distortedWithdrawalInBps;
        strategyDepositToken = _depositToken;
        rewardPerCompoundPeriodInBps = _rewardPerCompoundPeriodInBps;
        isRewardPositive = _isRewardPositive;
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;
        for (uint256 i; i < depositors.length; i++) {
            _setupRole(DEPOSITOR_ROLE, depositors[i]);
        }
    }

    function depositToken() external view override returns (address) {
        return strategyDepositToken;
    }

    function rewardToken() external view override returns (address) {
        return strategyDepositToken;
    }

    function getPendingReward() external pure override returns (uint256) {
        return 0;
    }

    function _deposit(uint256 amount) internal override {
        depositCount += 1;

        balanceInToken += amount;
    }

    function withdraw(uint256 amount)
    external
    override
    onlyOwner
    returns (uint256 amountWithdrawn)
    {
        withdrawCount += 1;

        amountWithdrawn = isUnderFulfilled
            ? amount * (10000 - distortedWithdrawalInBps) / 10000
            : amount * (10000 + distortedWithdrawalInBps) / 10000;
        if (amountWithdrawn > balanceInToken) {
            balanceInToken = 0;
        } else {
            balanceInToken -= amountWithdrawn;
        }
        ERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
    }

    function compound() external override onlyOwner {
        if (isRewardPositive) {
            balanceInToken = (balanceInToken * (10000 + rewardPerCompoundPeriodInBps )) / 10000;
        }
        else {
            balanceInToken = (balanceInToken * (10000 - rewardPerCompoundPeriodInBps )) / 10000;
        }
    }

    function totalTokens() public view override returns (uint256) {
        return _totalTokens();
    }

    function _totalTokens() internal view override returns (uint256) {
        return balanceInToken;
    }

    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        if (balanceInToken > 0) {
            amountWithdrawn = isUnderFulfilled
                ? balanceInToken * (10000 - distortedWithdrawalInBps) / 10000
                : balanceInToken * (10000 + distortedWithdrawalInBps) / 10000;
            if (amountWithdrawn > balanceInToken) {
                balanceInToken = 0;
            } else {
                balanceInToken -= amountWithdrawn;
            }
            ERC20(strategyDepositToken).transfer(msg.sender, amountWithdrawn);
        }
    }
}
