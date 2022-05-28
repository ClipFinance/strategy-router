//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/ICurvePool.sol";
import "./StrategyRouter.sol";

// import "hardhat/console.sol";

contract Exchange is Ownable {
    error RoutedSwapFailed();
    error RouteNotFound();

    enum DexType {
        // pancakeswap with WETH as intermediary, default option
        pancakeSwapThroughWETH,
        // tokenA to tokenB direct swap on pancake
        pancakeDirectSwap,
        // ACS4UST metapool
        acryptosACS4UST
    }

    // in dexTypes tokens addresses should be sorted in ascending order
    // tokenA -> tokenB -> DexType
    mapping(address => mapping(address => DexType)) public dexTypes;

    // tokenA -> tokenB -> pool to use as exchange
    mapping(address => mapping(address => address)) public pools;
    // curve-like pool -> token -> id of the token in the pool
    mapping(address => mapping(address => int128)) public coinIds;

    IUniswapV2Router02 public uniswapRouter;

    constructor() {}

    /// @notice Choose DEX where pair of tokens should be swapped.
    /// @notice Order of tokens doesn't matter.
    function setDexType(
        address[] calldata tokensA,
        address[] calldata tokensB,
        DexType[] calldata _types
    ) external onlyOwner {
        for (uint256 i = 0; i < tokensA.length; i++) {
            (address token0, address token1) = sortTokens(
                tokensA[i],
                tokensB[i]
            );
            dexTypes[token0][token1] = _types[i];
        }
    }

    /// @notice Set uniswap02-like router.
    function setUniswapRouter(address _uniswapRouter) external onlyOwner {
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
    }

    /// @notice Set curve-like pool to user to swap pair.
    function setCurvePool(
        address tokenA,
        address tokenB,
        address pool
    ) external onlyOwner {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pools[token0][token1] = pool;
    }

    /// @notice Cache pool's token ids.
    function setCoinIds(
        address _curvePool,
        address[] calldata tokens,
        int128[] calldata _coinIds
    ) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            coinIds[address(_curvePool)][tokens[i]] = _coinIds[i];
        }
    }

    function getDexType(address tokenA, address tokenB)
        internal
        view
        returns (DexType)
    {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return dexTypes[token0][token1];
    }

    function getAcryptosPool(address tokenA, address tokenB)
        internal
        view
        returns (address)
    {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return pools[token0][token1];
    }

    function swapRouted(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public returns (uint256 amountReceived) {
        DexType _dexType = getDexType(address(tokenA), address(tokenB));
        amountReceived = swap(amountA, tokenA, tokenB, _dexType, to);
        if (amountReceived == 0) revert RoutedSwapFailed();
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        DexType _dexType,
        address to
    ) public returns (uint256 amountReceivedTokenB) {
        if (_dexType == DexType.pancakeSwapThroughWETH) {
            return _swapOnPancakeWithWETH(amountA, tokenA, tokenB, to);
        } else if (_dexType == DexType.pancakeDirectSwap) {
            return _swapOnPancakeDirect(amountA, tokenA, tokenB, to);
        } else if (_dexType == DexType.acryptosACS4UST) {
            return _swapOnAcryptosUST(amountA, tokenA, tokenB, to);
        }

        revert RouteNotFound();
    }

    function _swapOnPancakeWithWETH(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        IERC20(tokenA).approve(address(uniswapRouter), amountA);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = uniswapRouter.WETH();
        path[2] = address(tokenB);

        uint256 received = uniswapRouter.swapExactTokensForTokens(
            amountA,
            0,
            path,
            address(this),
            block.timestamp
        )[path.length - 1];

        IERC20(tokenB).transfer(to, received);

        return received;
    }

    function _swapOnPancakeDirect(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        IERC20(tokenA).approve(address(uniswapRouter), amountA);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 received = uniswapRouter.swapExactTokensForTokens(
            amountA,
            0,
            path,
            address(this),
            block.timestamp
        )[path.length - 1];

        IERC20(tokenB).transfer(to, received);

        return received;
    }

    function _swapOnAcryptosUST(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        address pool = getAcryptosPool(tokenA, tokenB);
        IERC20(tokenA).approve(address(pool), amountA);

        int128 _tokenAIndex = coinIds[address(pool)][tokenA];
        int128 _tokenBIndex = coinIds[address(pool)][tokenB];

        // console.log("_tokenAIndex %s _tokenBIndex %s amountA %s", uint128(_tokenAIndex), uint128(_tokenBIndex), amountA);
        uint256 received = ICurvePool(pool).exchange_underlying(
            _tokenAIndex,
            _tokenBIndex,
            amountA,
            0
        );

        IERC20(tokenB).transfer(to, received);

        return received;
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
