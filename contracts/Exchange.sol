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

    IUniswapV2Router02 public router = IUniswapV2Router02(
        0x10ED43C718714eb63d5aA57B78B54704E256024E
    );

    constructor () { }

    /// @notice Swap tokens through WETH in middle.
    function swapExactTokensForTokens(
        uint256 amountA, 
        IERC20 tokenA, 
        IERC20 tokenB
    ) public returns (uint256 amountReceivedTokenB) {

        tokenA.approve(address(router), amountA);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = router.WETH();
        path[2] = address(tokenB);

        uint256 received = router.swapExactTokensForTokens(
            amountA, 
            0, 
            path, 
            address(msg.sender), 
            block.timestamp
        )[path.length - 1];

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
