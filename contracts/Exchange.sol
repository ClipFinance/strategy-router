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

    struct RouteParams {
        // default exchange to use, could have low slippage but also lower liquidity
        address defaultRoute;
        // whenever input amount is over limit, then should use secondRoute
        uint256 limit;
        // second exchange, could have higher slippage but also higher liquidity
        address secondRoute;
    }

    // which plugin to use for swap for this pair
    // tokenA -> tokenB -> RouteParams
    mapping(address => mapping(address => RouteParams)) public routes;

    constructor() {}

    /// @notice Choose plugin where pair of tokens should be swapped.
    function setRoute(
        address[] calldata tokensA,
        address[] calldata tokensB,
        address[] calldata plugin
    ) external onlyOwner {
        for (uint256 i = 0; i < tokensA.length; i++) {
            (address token0, address token1) = sortTokens(
                tokensA[i],
                tokensB[i]
            );
            routes[token0][token1].defaultRoute = plugin[i];
        }
    }

    function setRouteEx(
        address[] calldata tokensA,
        address[] calldata tokensB,
        RouteParams[] calldata _routes
    ) external onlyOwner {
        for (uint256 i = 0; i < tokensA.length; i++) {
            (address token0, address token1) = sortTokens(
                tokensA[i],
                tokensB[i]
            );
            routes[token0][token1] = _routes[i];
        }
    }

    function getPlugin(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) public view returns (address) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        uint256 limit = routes[token0][token1].limit;
        address plugin;
        if (amountA < limit || limit == 0)
            plugin = routes[token0][token1].defaultRoute;
        else plugin = routes[token0][token1].secondRoute;
        if (plugin == address(0)) revert RouteNotFound();
        return plugin;
    }

    function getFee(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) public view returns (uint256 feePercent) {
        address plugin = getPlugin(amountA, address(tokenA), address(tokenB));
        return IExchangePlugin(plugin).getFee(tokenA, tokenB);
    }

    function getAmountOut(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) external view returns (uint256 amountOut) {
        address plugin = getPlugin(amountA, address(tokenA), address(tokenB));
        return IExchangePlugin(plugin).getAmountOut(amountA, tokenA, tokenB);
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public returns (uint256 amountReceived) {
        address plugin = getPlugin(amountA, address(tokenA), address(tokenB));
        ERC20(tokenA).transfer(plugin, amountA);
        amountReceived = IExchangePlugin(plugin).swap(
            amountA,
            tokenA,
            tokenB,
            to
        );
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
