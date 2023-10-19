//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

interface IUniswapV3Router is ISwapRouter {
    function factory() external pure returns (address);
}
