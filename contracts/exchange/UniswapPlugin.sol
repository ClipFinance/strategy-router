//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "../interfaces/ICurvePool.sol";
import "../interfaces/IExchangePlugin.sol";
import {SphereXProtected} from "@spherex-xyz/contracts/src/SphereXProtected.sol";

contract UniswapPlugin is IExchangePlugin, Ownable {
    // whether swap for the pair should be done through some ERC20-like token as intermediary
    mapping(address => mapping(address => address)) public mediatorTokens;

    IUniswapV2Router02 immutable uniswapRouter;

    constructor(address _uniswapRouter) {
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);

        if (tx.origin != msg.sender) {
            // set proxi owner to address that deployed this contract from Create2Deployer
            transferOwnership(tx.origin);
        }
    }

    function setMediatorTokenForPair(
        address _mediatorToken, // set zero address to disable mediatorToken for a pair
        address[2] calldata pair
    ) public onlyOwner sphereXGuardPublic(38, 0x4ad79155) {
        (address token0, address token1) = sortTokens(pair[0], pair[1]);
        if (token0 == _mediatorToken || token1 == _mediatorToken) revert CanNotSetIdenticalMediatorToken();
        mediatorTokens[token0][token1] = _mediatorToken;
    }

    function setMediatorTokensForPairs(address[] calldata mediatorTokens_, address[2][] calldata pairs)
        external
        onlyOwner
        sphereXGuardExternal(39)
    {
        for (uint256 i = 0; i < pairs.length; i++) {
            setMediatorTokenForPair(mediatorTokens_[i], pairs[i]);
        }
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

    function swap(uint256 amountA, address tokenA, address tokenB, address to, uint256 minAmountOut)
        public
        override
        sphereXGuardPublic(40, 0x10e2df9b)
        returns (uint256 amountReceivedTokenB)
    {
        if (amountA == 0) return 0;
        address[] memory path = getPathForTokenPair(tokenA, tokenB);

        IERC20(path[0]).approve(address(uniswapRouter), amountA);

        // Perform the swap on router and get the amount of tokenB received
        amountReceivedTokenB =
            uniswapRouter.swapExactTokensForTokens(amountA, minAmountOut, path, to, block.timestamp)[path.length - 1];
    }

    function getExchangeProtocolFee(address tokenA, address tokenB) public view override returns (uint256 feePercent) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        // 0.25% or 0.0025 with 18 decimals
        if (mediatorToken != address(0)) return 1e18 - ((1e18 - 25e14) ** 2 / 1e18);
        else return 25e14;
    }

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function getRoutePrice(address tokenA, address tokenB) external view override returns (uint256 price) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        uint256 precisionB = 10 ** IERC20Metadata(tokenB).decimals();

        if (mediatorToken != address(0)) {
            uint256 precisionM = 10 ** IERC20Metadata(mediatorToken).decimals();
            uint256 priceAM = _getRoutePrice(tokenA, mediatorToken, precisionM);
            uint256 priceMB = _getRoutePrice(mediatorToken, tokenB, precisionB);

            return (priceAM * priceMB) / precisionB;
        } else {
            return _getRoutePrice(tokenA, tokenB, precisionB);
        }
    }

    /// @notice Returns price of tokenA in tokenB with decimalsB.
    function _getRoutePrice(address tokenA, address tokenB, uint256 precisionB) internal view returns (uint256 price) {
        IUniswapV2Factory factory = IUniswapV2Factory(uniswapRouter.factory());
        IUniswapV2Pair pair = IUniswapV2Pair(factory.getPair(tokenA, tokenB));

        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();

        bool isToken0A = tokenA < tokenB;

        return isToken0A ? (reserve1 * precisionB) / reserve0 : (reserve0 * precisionB) / reserve1;
    }

    /* ERRORS */

    error CanNotSetIdenticalMediatorToken();
}
