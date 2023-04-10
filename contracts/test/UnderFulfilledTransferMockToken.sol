pragma solidity ^0.8.0;

import "./MockToken.sol";

contract UnderFulfilledTransferMockToken is MockToken {
    uint256 underFulfilledTransferInBps;

    constructor(
        uint16 _underFulfilledTransferInBps,
        uint256 _totalSupply,
        uint8 decimals_
    ) MockToken(_totalSupply, decimals_) {
        underFulfilledTransferInBps = _underFulfilledTransferInBps;
    }

    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        amount = amount - (amount * underFulfilledTransferInBps) / 10000;

        return super.transfer(to, amount);
    }
}