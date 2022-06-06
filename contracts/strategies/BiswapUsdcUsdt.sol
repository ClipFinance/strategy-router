//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../interfaces/IZapDepositer.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IBiswapFarm.sol";
import "../StrategyRouter.sol";
import "./BiswapBase.sol";
// import "hardhat/console.sol";


contract BiswapUsdcUsdt is BiswapBase {

    constructor(StrategyRouter _strategyRouter) 
        BiswapBase(
            _strategyRouter, 
            4, 
            ERC20(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d), 
            ERC20(0x55d398326f99059fF775485246999027B3197955),
            ERC20(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1),
            ERC20(0x1483767E665B3591677Fd49F724bf7430C18Bf83)
        ) 
    {
    }

}
