pragma solidity ^0.8.0;


library Math {
    error DivByZero();

    function divCeil(uint256 _a, uint256 _b) internal pure returns (uint256 c) {
        if(_b == 0) revert DivByZero();
        c = _a / _b;
        if (_a % _b != 0) {
            c = c + 1;
        }
    }
}
