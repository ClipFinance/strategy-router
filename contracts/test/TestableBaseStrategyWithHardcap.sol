pragma solidity ^0.8.0;

import "../strategies/AbstractBaseStrategyWithHardcap.sol";
import "../deps/UUPSUpgradeable.sol";
import "hardhat/console.sol";

contract TestableBaseStrategyWithHardcap is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    IStrategy,
    AbstractBaseStrategyWithHardcap
{
    uint256 private totalTokensPrivate;

    constructor(
        uint256 _totalTokens,
        uint256 _hardcapTargetInToken,
        uint16 _hardcapDeviationInBps,
        address[] memory depositors
    ) {
        _transferOwnership(_msgSender());
        totalTokensPrivate = _totalTokens;
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;
        for (uint256 i; i < depositors.length; i++) {
            _setupRole(DEPOSITOR_ROLE, depositors[i]);
        }
    }

    modifier onlyOwnerOrOwnerIsOrigin() {
        require(owner() == tx.origin || owner() == _msgSender(), "Only owner or owner is origin");
        _;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwnerOrOwnerIsOrigin {}

    function initialize(bytes memory initializeData) external initializer {
        (uint256 _hardcapTargetInToken, uint16 _hardcapDeviationInBps, address[] memory depositors) = abi.decode(
            initializeData,
            (uint256, uint16, address[])
        );

        super.initialize(_hardcapTargetInToken, _hardcapDeviationInBps, depositors);
    }

    function _deposit(uint256 amount) internal override {}

    function totalTokens() public view override returns (uint256) {
        return _totalTokens();
    }

    function _totalTokens() internal view override returns (uint256) {
        return totalTokensPrivate;
    }

    function depositToken() external view override returns (address) {
        return address(0);
    }

    function rewardToken() external view override returns (address) {
        return address(0);
    }

    function getPendingReward() external view override returns (uint256) {
        return 0;
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn) {}

    function withdraw(uint256 amount) external override returns (uint256 amountWithdrawn) {}

    function compound() external override {}
}
