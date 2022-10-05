//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/ICurvePool.sol";
import "../interfaces/IExchangePlugin.sol";
import "../StrategyRouter.sol";
import "../interfaces/IUsdOracle.sol";

import "hardhat/console.sol";

contract UniswapPlugin is IExchangePlugin, Ownable {
    error RoutedSwapFailed();
    error RouteNotFound();

    // whether swap for the pair should be done through WETH as intermediary
    mapping(address => mapping(address => bool)) public useWeth;

    IUniswapV2Router02 public uniswapRouter;

    // 10000 -> 100%, 30 -> 0.3%
    uint256 private constant PERCENT_DENOMINATOR = 10000;
    uint256 slippageTolerance = 30;

    constructor() {}

    IUsdOracle public oracle;

    /// @notice Set uniswap02-like router.
    function setUniswapRouter(address _uniswapRouter) external onlyOwner {
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
    }

    function setOracleAddress(IUsdOracle _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function setUseWeth(
        address tokenA,
        address tokenB,
        bool _useWeth
    ) external onlyOwner {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        useWeth[token0][token1] = _useWeth;
    }

    function canUseWeth(address tokenA, address tokenB) public view returns (bool) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return useWeth[token0][token1];
    }

    // TODO this method is not callable from anywhere. If it's admin method, implementation to call it should be given
    // also it's not part if IExchangePlugin interface
    function setSlippageTolerance(uint256 slippagePercent) public onlyOwner {
        require(slippagePercent <= 50, "Max 50");
        slippageTolerance = slippagePercent;
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public override returns (uint256 amountReceivedTokenB) {
        if (canUseWeth(tokenA, tokenB)) {
            address[] memory path = new address[](3);
            path[0] = address(tokenA);
            path[1] = uniswapRouter.WETH();
            path[2] = address(tokenB);

            return _swap(amountA, path, to);
        } else {
            address[] memory path = new address[](2);
            path[0] = address(tokenA);
            path[1] = address(tokenB);

            return _swap(amountA, path, to);
        }
    }

    function getExchangeProtocolFee(address, address) public pure override returns (uint256 feePercent) {
        return 25e14; // 0.25% or 0.0025 with 18 decimals
    }

    function getAmountOut(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) external view override returns (uint256 amountOut) {
        if (canUseWeth(tokenA, tokenB)) {
            address[] memory path = new address[](3);
            path[0] = address(tokenA);
            path[1] = uniswapRouter.WETH();
            path[2] = address(tokenB);
            return uniswapRouter.getAmountsOut(amountA, path)[2];
        } else {
            address[] memory path = new address[](3);
            path[0] = address(tokenA);
            path[1] = address(tokenB);
            return uniswapRouter.getAmountsOut(amountA, path)[1];
        }
    }

    function getMinAmountOut(uint256 amountA, address tokenB) public view returns (uint256 minAmountOut) {
        // get amount for slippage
        (uint256 tokenUsdPrice, uint8 oraclePriceDecimals) = oracle.getTokenUsdPrice(tokenB);
        // convert usd to token amount
        minAmountOut = ((amountA * 10**oraclePriceDecimals) / tokenUsdPrice);
        // amount with slippage
        return minAmountOut - ((minAmountOut * slippageTolerance) / PERCENT_DENOMINATOR);
    }

    function _swap(
        uint256 amountA,
        address[] memory path,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        IERC20(path[0]).approve(address(uniswapRouter), amountA);
        uint256 received;
        if (address(oracle) != address(0)) {
            received = uniswapRouter.swapExactTokensForTokens(
                amountA,
                getMinAmountOut(amountA, path[path.length - 1]),
                path,
                address(this),
                block.timestamp
            )[path.length - 1];
        } else {
            received = uniswapRouter.swapExactTokensForTokens(amountA, 0, path, address(this), block.timestamp)[
                path.length - 1
            ];
        }
        IERC20(path[path.length - 1]).transfer(to, received);
        return received;
    }

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
