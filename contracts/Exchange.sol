//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IMainRegistry.sol";
import "./interfaces/IExchangeRegistry.sol";
import "./StrategyRouter.sol";

import "hardhat/console.sol";

contract Exchange is Ownable {

    uint256 public constant EXCHANGE_REGISTRY_ID = 2;

    IMainRegistry public curveMainRegistry = IMainRegistry(
        0x0000000022D53366457F9d5E68Ec105046FC4383
    );
    IExchangeRegistry public curveExchangeRegistry;

    constructor () {
        curveExchangeRegistry = IExchangeRegistry(
            curveMainRegistry.get_address(EXCHANGE_REGISTRY_ID)
        );
    }

    /// @notice Swap exact tokensA for tokensB.
    /// @param amountA Amount of tokenA to spend.
    /// @param tokenA Address of tokenA to spend.
    /// @param tokenB Address of token to receive.
    /// @return amountReceivedTokenB Amount of tokenB received.
    function swapExactTokensForTokens(
        uint256 amountA, 
        IERC20 tokenA, 
        IERC20 tokenB
    ) public returns (uint256 amountReceivedTokenB) {

        tokenA.approve(address(curveExchangeRegistry), amountA);

        (address pool, uint256 toReceive) = curveExchangeRegistry.get_best_rate(
            address(tokenA),
            address(tokenB),
            amountA
        );

        uint256 received = curveExchangeRegistry.exchange(
            pool, 
            address(tokenA), 
            address(tokenB), 
            amountA, 
            toReceive,
            msg.sender
        );

        return received;
    }

    // function test(
    //     uint256 swapAmount,
    //     IERC20 tokenToSwap,
    //     IERC20 depositToken2
    // ) public view returns (address pool) {

    //       (pool, ) = curveExchangeRegistry.get_best_rate(
    //         address(tokenToSwap),
    //         address(depositToken2),
    //        swapAmount 
    //     );
    // }
}
