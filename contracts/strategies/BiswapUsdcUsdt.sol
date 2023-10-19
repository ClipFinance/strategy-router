//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IStrategyRouter.sol";
import "./BiswapBase.sol";

// import "hardhat/console.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract BiswapUsdcUsdt is BiswapBase {
    constructor(
        IStrategyRouter _strategyRouter,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    )
        BiswapBase(
            _strategyRouter,
            4, // poolId in BiswapFarm (0xdbc1a13490deef9c3c12b44fe77b503c1b061739)
            IERC20Metadata(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d), // tokenA - usdc mainnet on bsc
            IERC20Metadata(0x55d398326f99059fF775485246999027B3197955), // tokenB - usdt mainnet on bsc
            IUniswapV2Pair(0x1483767E665B3591677Fd49F724bf7430C18Bf83), // lpToken - usdc-usdt liquidity pair on biswap (bsc)
            _oracle,
            _priceManipulationPercentThresholdInBps
        )
    {}
}
