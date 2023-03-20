//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "../interfaces/IStrategy.sol";
import "../deps/OwnableUpgradeable.sol";
import "../deps/Initializable.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
abstract contract AbstractBaseStrategyWithHardcap is Initializable, OwnableUpgradeable, IStrategy {
    uint256 public hardcapTargetInToken;
    uint16 public hardcapDeviationInBps;

    error HardcapLimitExceeded();

    // !!!IMPORTANT Need to be overridden to change onlyInitializing modifier to initializer
    function initialize(uint256 _hardcapTargetInToken, uint16 _hardcapDeviationInBps) public virtual onlyInitializing {
        __Ownable_init();
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;
    }

    function deposit(uint256 amount) external override onlyOwner
    {
        (bool limitReached, uint256 underflow, ) = getCapacityData();
        // We do not want to get deposit into a strategy out of capacity
        // If a deposit is big there could be significant risks
        // Revert if the deposit exceeds capacity
        // External code should check that but this check adds additional level of safety
        // TODO Consider different handling to override depositAmount to capacity if depositAmount > capacity
        // TODO and return excessive funds back to StrategyRouter
        // TODO though it would require much bigger changes also in StrategyRouter to take into account returned funds
        if (limitReached || amount > underflow) {
            revert HardcapLimitExceeded();
        }

        return _deposit(amount);
    }

    function _deposit(uint256 amount) internal virtual;

    function _totalTokens() internal virtual view returns (uint256);

    /// @notice Get hardcap target value
    function getHardcardTargetInToken() view external override returns (uint256) {
        return _getHardcardTargetInToken();
    }

    function _getHardcardTargetInToken() view internal returns (uint256) {
        return hardcapTargetInToken;
    }

    /// @notice Set allowed deviation from target value
    function getHardcardDeviationInBps() view external override returns (uint16) {
        return _getHardcardDeviationInBps();
    }

    function _getHardcardDeviationInBps() view internal returns (uint16) {
        return hardcapDeviationInBps;
    }

    function getCapacityData() view public override returns (bool limitReached, uint256 underflow, uint256 overflow) {
        uint256 strategyAllocatedTokens = _totalTokens();
        uint256 hardcapTarget = _getHardcardTargetInToken();
        uint256 hardcapDeviationBp = _getHardcardDeviationInBps();

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