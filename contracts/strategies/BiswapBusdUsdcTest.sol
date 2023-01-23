//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../StrategyRouter.sol";
import "./BiswapBase.sol";

// import "hardhat/console.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract BiswapBusdUsdcTest is BiswapBase {
    constructor(StrategyRouter _strategyRouter)
        BiswapBase(
            _strategyRouter,
            4, // poolId in BiswapFarm (0xdbc1a13490deef9c3c12b44fe77b503c1b061739)
            ERC20(0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd), // tokenA - busd testnet on bsc
            ERC20(0xFa60D973F7642B748046464e165A65B7323b0DEE), // tokenB - usdc testnet on bsc
            ERC20(0xa96818CA65B57bEc2155Ba5c81a70151f63300CD) // lpToken - busd-usdc liquidity pair on pancake (bsc)
        )
    {}
}
