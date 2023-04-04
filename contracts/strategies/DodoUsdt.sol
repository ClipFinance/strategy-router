//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../StrategyRouter.sol";
import "./DodoBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract DodoUsdt is DodoBase {
    constructor(StrategyRouter _strategyRouter)
        DodoBase(
            _strategyRouter,
            IERC20(0x55d398326f99059fF775485246999027B3197955), // token - usdt mainnet on bsc
            IERC20(0x56ce908EeBafea026ab047CEe99a3afF039B4a33), // usdt lp token
            IERC20(0x67ee3Cb086F8a16f34beE3ca72FAD36F7Db929e2), // dodo token
            IDodoSingleAssetPool(0xBe60d4c4250438344bEC816Ec2deC99925dEb4c7), // BUSD - USDT dodo pool
            IDodoMine(0x01f9BfAC04E6184e90bD7eaFD51999CE430Cc750) // dodo mine
        )
    {}
}
