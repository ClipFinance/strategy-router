//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/ICurvePool.sol";
import "../interfaces/IExchangePlugin.sol";
import "../StrategyRouter.sol";

contract UniswapPlugin is IExchangePlugin, Ownable {
    error RoutedSwapFailed();
    error RouteNotFound();

    // whether swap for the pair should be done through some ERC20-like token as intermediary
    mapping(address => mapping(address => address)) public mediatorTokens;

    IUniswapV2Router02 public uniswapRouter;

    constructor() {}

    /// @notice Set uniswap02-like router.
    function setUniswapRouter(address _uniswapRouter) external onlyOwner {
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
    }

    function setMediatorTokenForPair(
        address _mediatorToken, // set zero address to disable mediatorToken for a pair
        address[2] calldata pair
    ) external onlyOwner {
        (address token0, address token1) = sortTokens(pair[0], pair[1]);
        mediatorTokens[token0][token1] = _mediatorToken;
    }

    function getPathForTokenPair(address tokenA, address tokenB) public view returns (address[] memory path) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        if (mediatorToken != address(0)) {
            path = new address[](3);
            path[0] = tokenA;
            path[1] = mediatorToken;
            path[2] = tokenB;
        } else {
            path = new address[](2);
            path[0] = tokenA;
            path[1] = tokenB;
        }
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public override returns (uint256 amountReceivedTokenB) {
        address[] memory path = getPathForTokenPair(tokenA, tokenB);

        return _swap(amountA, path, to);
    }

    function getExchangeProtocolFee(address, address) public pure override returns (uint256 feePercent) {
        return 25e14; // 0.25% or 0.0025 with 18 decimals
    }

    function getAmountOut(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) external view override returns (uint256 amountOut) {
        address[] memory path = getPathForTokenPair(tokenA, tokenB);

        return uniswapRouter.getAmountsOut(amountA, path)[path.length - 1];
    }

    function _swap(
        uint256 amountA,
        address[] memory path,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        IERC20(path[0]).approve(address(uniswapRouter), amountA);

        // Perform the swap on router and get the amount of tokenB received
        amountReceivedTokenB = uniswapRouter.swapExactTokensForTokens(
            amountA,
            0,
            path,
            address(this),
            block.timestamp
        )[path.length - 1];

        // Transfer the received tokens to the recipient
        IERC20(path[path.length - 1]).transfer(to, amountReceivedTokenB);
    }

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "UniswapPlugin: identical addresses");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}