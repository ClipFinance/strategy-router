//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IUsdOracle {
    function isTokenSupported(address base)
        external
        view
        returns (bool isTokenSupported);

    /// @notice Get usd value of token `base`.
    function getTokenUsdPrice(address base)
        external
        view
        returns (uint256 price, uint8 decimals);
}
