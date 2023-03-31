//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IUsdOracle.sol";
import "../StrategyRouter.sol";
import "./StargateBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract StargateUsdt is StargateBase {
    constructor(StrategyRouter _strategyRouter)
        StargateBase(
            _strategyRouter,
            IERC20(0x55d398326f99059fF775485246999027B3197955), // token - usdt mainnet on bsc
            IStargatePool(0x9aA83081AA06AF7208Dcc7A4cB72C94d057D2cda), // stargate usdt pool
            IERC20(0xB0D502E938ed5f4df2E681fE6E419ff29631d62b), // stg token
            IStargateRouter(0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8), // stargate router
            IStargateFarm(0x3052A0F6ab15b4AE1df39962d5DdEFacA86DaB47), // stargate farm
            2, // usdt poolId
            0 // usdtLp farmId
        )
    {}
}
