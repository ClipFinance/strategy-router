//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IStrategyRouter.sol";
import "./DodoBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract DodoBusd is DodoBase {
    constructor(
        IStrategyRouter _strategyRouter
    )
        DodoBase(
            _strategyRouter,
            IERC20Metadata(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56), // token - busd mainnet on bsc
            IERC20Metadata(0xBEb34A9d23E0fe41d7b08AE3A4cbAD9A63ce0aea), // busd lp token
            IERC20Metadata(0x67ee3Cb086F8a16f34beE3ca72FAD36F7Db929e2), // dodo token
            IDodoSingleAssetPool(0xBe60d4c4250438344bEC816Ec2deC99925dEb4c7), // BUSD - USDT dodo pool
            IDodoMine(0x01f9BfAC04E6184e90bD7eaFD51999CE430Cc750) // dodo mine
        )
    {}
}
