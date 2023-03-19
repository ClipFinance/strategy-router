pragma solidity ^0.8.0;

import "../strategies/AbstractBaseStrategyWithHardcap.sol";
import "hardhat/console.sol";

contract TestableBaseStrategyWithHardcap is AbstractBaseStrategyWithHardcap {
    uint256 private totalTokensPrivate;

    constructor(uint256 _totalTokens, uint256 _hardcapTargetInToken, uint16 _hardcapDeviationInBps)
    {
        _transferOwnership(_msgSender());
        totalTokensPrivate = _totalTokens;
        hardcapTargetInToken = _hardcapTargetInToken;
        hardcapDeviationInBps = _hardcapDeviationInBps;
    }

    function initialize(uint256 _hardcapTargetInToken, uint16 _hardcapDeviationInBps) public override initializer
    {
        super.initialize(_hardcapTargetInToken, _hardcapDeviationInBps);
    }

    function _deposit(uint256 amount) internal override
    {}

    function totalTokens() public override view returns (uint256) {
        return _totalTokens();
    }

    function _totalTokens() internal override view returns (uint256) {
        return totalTokensPrivate;
    }

    function depositToken() external override view returns (address)
    {
        return address(0);
    }

    function withdrawAll() external override returns (uint256 amountWithdrawn)
    {}


    function withdraw(uint256 amount) external override returns (uint256 amountWithdrawn)
    {}

    function compound() external override
    {}
}