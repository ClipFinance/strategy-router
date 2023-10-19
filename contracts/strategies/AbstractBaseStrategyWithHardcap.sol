//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "../interfaces/IStrategy.sol";
import "../deps/OwnableUpgradeable.sol";
import "../deps/AccessControlUpgradeable.sol";
import "../deps/Initializable.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
abstract contract AbstractBaseStrategyWithHardcap is
    Initializable,
    OwnableUpgradeable,
    AccessControlUpgradeable,
    IStrategy
{
    uint256 public hardcapTargetInToken;
    uint16 public hardcapDeviationInBps;

    // Create a new role identifier for the depositor role
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    // !!!IMPORTANT Need to be overridden to change onlyInitializing modifier to initializer
    function initialize(
        uint256 _hardcapTargetInToken,
        uint16 _hardcapDeviationInBps,
        address[] memory depositors
    ) public virtual onlyInitializing {
        __Ownable_init();
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;

        // transer ownership to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);

        _setupRole(DEFAULT_ADMIN_ROLE, owner());
        for (uint256 i; i < depositors.length; i++) {
            _setupRole(DEPOSITOR_ROLE, depositors[i]);
        }
    }

    function deposit(uint256 amount) external override {
        if (!hasRole(DEPOSITOR_ROLE, _msgSender())) {
            revert OnlyDepositorsAllowedToDeposit();
        }
        (bool limitReached, uint256 underflow, ) = getCapacityData();
        if (limitReached || amount > underflow) {
            revert HardcapLimitExceeded();
        }

        return _deposit(amount);
    }

    function _deposit(uint256 amount) internal virtual;

    function _totalTokens() internal view virtual returns (uint256);

    /// @notice Get hardcap target value
    function getHardcardTargetInToken() external view override returns (uint256) {
        return _getHardcardTargetInToken();
    }

    function _getHardcardTargetInToken() internal view returns (uint256) {
        return hardcapTargetInToken;
    }

    /// @notice Set allowed deviation from target value
    function getHardcardDeviationInBps() external view override returns (uint16) {
        return _getHardcardDeviationInBps();
    }

    function _getHardcardDeviationInBps() internal view returns (uint16) {
        return hardcapDeviationInBps;
    }

    function getCapacityData() public view override returns (bool limitReached, uint256 underflow, uint256 overflow) {
        uint256 strategyAllocatedTokens = _totalTokens();
        uint256 hardcapTarget = _getHardcardTargetInToken();
        uint256 hardcapDeviationBp = _getHardcardDeviationInBps();

        uint256 lowerBound = hardcapTarget - ((hardcapTarget * hardcapDeviationBp) / 10000);
        uint256 upperBound = hardcapTarget + ((hardcapTarget * hardcapDeviationBp) / 10000);

        if (strategyAllocatedTokens < lowerBound) {
            return (false, hardcapTarget - strategyAllocatedTokens, 0);
        }

        if (strategyAllocatedTokens > upperBound) {
            return (true, 0, strategyAllocatedTokens - hardcapTarget);
        }

        return (true, 0, 0);
    }

    /* ERRORS */

    error HardcapLimitExceeded();
    error OnlyDepositorsAllowedToDeposit();
}
