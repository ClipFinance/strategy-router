//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "../interfaces/IStrategyRouter.sol";
import "./BiswapBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract BiswapHayUsdt is BiswapBase {
    constructor(
        IStrategyRouter _strategyRouter,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    )
        BiswapBase(
            _strategyRouter,
            135, // poolId in BiswapFarm (0xdbc1a13490deef9c3c12b44fe77b503c1b061739)
            IERC20Metadata(0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5), // tokenA - hay mainnet on bsc
            IERC20Metadata(0x55d398326f99059fF775485246999027B3197955), // tokenB - usdt mainnet on bsc
            IUniswapV2Pair(0xE0Aa23541960BdAF33Ac9601a28123b385554E59), // lpToken - hay-usdt liquidity pair on biswap (bsc)
            _oracle,
            _priceManipulationPercentThresholdInBps
        )
    {}
}
