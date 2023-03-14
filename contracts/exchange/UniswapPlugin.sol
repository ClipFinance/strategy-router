//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/ICurvePool.sol";
import "../interfaces/IExchangePlugin.sol";
import "../StrategyRouter.sol";

// import "hardhat/console.sol";

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
        address _mediatorToken, // set zero address to disable mediatorToken for the pair of tokenA and tokenB
        address tokenA,
        address tokenB
    ) external onlyOwner {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        mediatorTokens[token0][token1] = _mediatorToken;
    }

    function getMediatorTokenOfPair(address tokenA, address tokenB) public view returns (address) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return mediatorTokens[token0][token1];
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public override returns (uint256 amountReceivedTokenB) {
        address mediatorToken = getMediatorTokenOfPair(tokenA, tokenB);

        if (mediatorToken != address(0x0)) {
            address[] memory path = new address[](3);
            path[0] = address(tokenA);
            path[1] = mediatorToken;
            path[2] = address(tokenB);

            return _swap(amountA, path, to);
        }

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

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
        address mediatorToken = getMediatorTokenOfPair(tokenA, tokenB);

        if (mediatorToken != address(0x0)) {
            address[] memory path = new address[](3);
            path[0] = address(tokenA);
            path[1] = mediatorToken;
            path[2] = address(tokenB);
            return uniswapRouter.getAmountsOut(amountA, path)[2];
        }

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        return uniswapRouter.getAmountsOut(amountA, path)[1];
    }

    function _swap(
        uint256 amountA,
        address[] memory path,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        IERC20(path[0]).approve(address(uniswapRouter), amountA);

        uint256 received = uniswapRouter.swapExactTokensForTokens(amountA, 0, path, address(this), block.timestamp)[
            path.length - 1
        ];

        IERC20(path[path.length - 1]).transfer(to, received);

        return received;
    }

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
