//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/ICurvePool.sol";
import "./interfaces/IExchangePlugin.sol";
import "./StrategyRouter.sol";

// import "hardhat/console.sol";

contract Exchange is Ownable {
    error RoutedSwapFailed();
    error RouteNotFound();

    // which plugin to use for swap for this pair
    // tokenA -> tokenB -> plugin
    mapping(address => mapping(address => address)) private plugins;

    constructor() {}

    /// @notice Choose plugin where pair of tokens should be swapped.
    function setPlugin(
        address[] calldata tokensA,
        address[] calldata tokensB,
        address[] calldata plugin
    ) external onlyOwner {
        for (uint256 i = 0; i < tokensA.length; i++) {
            (address token0, address token1) = sortTokens(
                tokensA[i],
                tokensB[i]
            );
            plugins[token0][token1] = plugin[i];
        }
    }

    function getPlugin(address tokenA, address tokenB)
        public 
        view
        returns (address)
    {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return plugins[token0][token1];
    }

    function getFee(address tokenA, address tokenB) public view returns (uint256 feePercent) {
        address plugin = getPlugin(address(tokenA), address(tokenB));
        return IExchangePlugin(plugin).getFee(tokenA, tokenB);
    }

    function swapRouted(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public returns (uint256 amountReceived) {
        address plugin = getPlugin(address(tokenA), address(tokenB));
        if(plugin == address(0)) revert RouteNotFound();
        ERC20(tokenA).transfer(plugin, amountA);
        amountReceived = IExchangePlugin(plugin).swap(amountA, tokenA, tokenB, to);
        if (amountReceived == 0) revert RoutedSwapFailed();
    }


    function sortTokens(address tokenA, address tokenB)
        internal
        pure
        returns (address token0, address token1)
    {
        (token0, token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
    }
}
