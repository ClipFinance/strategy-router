//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../StrategyRouter.sol";
import "./BiswapBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract BiswapBusdUsdt is BiswapBase {
    constructor(StrategyRouter _strategyRouter)
        BiswapBase(
            _strategyRouter,
            1, // poolId
            ERC20(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56), // tokenA
            ERC20(0x55d398326f99059fF775485246999027B3197955), // tokenB
            ERC20(0xDA8ceb724A06819c0A5cDb4304ea0cB27F8304cF) // lpToken
        )
    {}
}
