pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

uint8 constant UNIFORM_DECIMALS = 18;
uint256 constant MAX_BPS = 10000;

library ClipMath {
    error DivByZero();

    function divCeil(uint256 _a, uint256 _b) internal pure returns (uint256 c) {
        if (_b == 0) revert DivByZero();
        c = _a / _b;
        if (_a % _b != 0) {
            c = c + 1;
        }
    }
}

/// @dev Change decimal places to `UNIFORM_DECIMALS`.
function toUniform(uint256 amount, address token) view returns (uint256) {
    return changeDecimals(amount, ERC20(token).decimals(), UNIFORM_DECIMALS);
}

/// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
function fromUniform(uint256 amount, address token) view returns (uint256) {
    return changeDecimals(amount, UNIFORM_DECIMALS, ERC20(token).decimals());
}

/// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
function changeDecimals(uint256 amount, uint8 oldDecimals, uint8 newDecimals) pure returns (uint256) {
    if (oldDecimals < newDecimals) {
        return amount * (10 ** (newDecimals - oldDecimals));
    } else if (oldDecimals > newDecimals) {
        return amount / (10 ** (oldDecimals - newDecimals));
    }
    return amount;
}
