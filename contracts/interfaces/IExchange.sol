//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import {TokenPrice} from "../lib/Structs.sol";

interface IExchange {
    function stablecoinSwap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) external returns (uint256 amountReceived);

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) external returns (uint256 amountReceived);

    function getExchangeProtocolFee(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) external view returns (uint256 feePercent);

    function protectedSwap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) external returns (uint256 amountReceived);

    function getRoutePrice(address tokenA, address tokenB) external view returns (uint256 price);
}
