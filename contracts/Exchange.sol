//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IMainRegistry.sol";
import "./interfaces/IExchangeRegistry.sol";
import "./interfaces/IAcryptoSPool.sol";
import "./StrategyRouter.sol";

// import "hardhat/console.sol";

enum DexType {
    // pancakeswap with WETH as intermediary, default option
    pancakeSwapThroughWETH,
    // tokenA to tokenB direct swap on pancake
    pancakeDirectSwap,
    // ACS4UST metapool
    acryptosACS4UST
}

contract Exchange is Ownable {
    error RoutedSwapFailed();
    
    // acryptos ACS meta pool token ids
    int128 public constant UST_ID = 0;
    int128 public constant BUSD_ID = 1;
    int128 public constant BUSDT_ID = 2;
    int128 public constant DAI_ID = 3;
    int128 public constant USDC_ID = 4;

    address public constant UST = 0x23396cF899Ca06c4472205fC903bDB4de249D6fC;
    address public constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant BUSDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant DAI = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
    address public constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;

    // in dexTypes tokens addresses should be sorted in ascending order
    // tokenA -> tokenB -> DexType
    mapping(address => mapping(address => DexType)) dexTypes;
    // poolACS4UST -> token -> coin id from pool
    mapping(address => mapping(address => int128)) coinIds;

    IUniswapV2Router02 public pancakeRouter =
        IUniswapV2Router02(0x10ED43C718714eb63d5aA57B78B54704E256024E);
    // for now we only support one metapool: UST-BUSD-USDT-DAI-USDC
    IAcryptoSPool public poolACS4UST =
        IAcryptoSPool(0x99c92765EfC472a9709Ced86310D64C4573c4b77);

    constructor() {
        _setDexType(UST, BUSD, DexType.acryptosACS4UST);
        _setCoinId(address(poolACS4UST), UST, UST_ID);
        _setCoinId(address(poolACS4UST), BUSD, BUSD_ID);
        // coinIds[address(poolACS4UST)][BUSDT] = BUSDT_ID;
        // coinIds[address(poolACS4UST)][DAI] = DAI_ID;
        // coinIds[address(poolACS4UST)][USDC] = USDC_ID;
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

    /// @notice Choose how pair of tokens should be swapped.
    /// @notice Order of tokens doesn't matter.
    function setDexType(
        address tokenA,
        address tokenB,
        DexType _type
    ) external onlyOwner {
        _setDexType(tokenA, tokenB, _type);
    }

    function _setDexType(
        address tokenA,
        address tokenB,
        DexType _type
    ) private {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        dexTypes[token0][token1] = _type;
    }

    /// @notice Save coin ids of tokens from acryptos pool.
    function setCoinId(
        address _poolACS4UST,
        address token,
        int128 coinId
    ) external onlyOwner {
        _setCoinId(_poolACS4UST, token, coinId);
    }

    function _setCoinId(
        address _poolACS4UST,
        address token,
        int128 coinId
    ) private {
        coinIds[address(_poolACS4UST)][token] = coinId;
    }

    function getDexType(address tokenA, address tokenB)
        internal
        view
        returns (DexType)
    {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return dexTypes[token0][token1];
    }

    function swapRouted(
        uint256 amountA,
        IERC20 tokenA,
        IERC20 tokenB,
        address to
    ) public returns (uint256 amountReceived) {
        DexType _dexType = getDexType(address(tokenA), address(tokenB));
        amountReceived = swap(amountA, tokenA, tokenB, _dexType, to);
        if(amountReceived == 0) revert RoutedSwapFailed();
    }

    function swap(
        uint256 amountA,
        IERC20 tokenA,
        IERC20 tokenB,
        DexType _dexType,
        address to
    ) public returns (uint256 amountReceivedTokenB) {
        if (_dexType == DexType.pancakeSwapThroughWETH) {
            return _swapOnPancakeWithWETH(amountA, tokenA, tokenB, to);
        } else if (_dexType == DexType.pancakeDirectSwap) {
            return _swapDirect(amountA, tokenA, tokenB, to);
        } else if (_dexType == DexType.acryptosACS4UST) {
            return _swapOnAcryptosUST(amountA, tokenA, tokenB, to);
        }

        revert("No swap route");
    }

    function _swapOnPancakeWithWETH(
        uint256 amountA,
        IERC20 tokenA,
        IERC20 tokenB,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        tokenA.approve(address(pancakeRouter), amountA);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = pancakeRouter.WETH();
        path[2] = address(tokenB);

        uint256 received = pancakeRouter.swapExactTokensForTokens(
            amountA,
            0,
            path,
            address(this),
            block.timestamp
        )[path.length - 1];

        tokenB.transfer(to, received);

        return received;
    }    
    
    function _swapDirect(
        uint256 amountA,
        IERC20 tokenA,
        IERC20 tokenB,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        tokenA.approve(address(pancakeRouter), amountA);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 received = pancakeRouter.swapExactTokensForTokens(
            amountA,
            0,
            path,
            address(this),
            block.timestamp
        )[path.length - 1];

        tokenB.transfer(to, received);

        return received;
    }

    function _swapOnAcryptosUST(
        uint256 amountA,
        IERC20 tokenA,
        IERC20 tokenB,
        address to
    ) private returns (uint256 amountReceivedTokenB) {
        tokenA.approve(address(poolACS4UST), amountA);

        int128 _tokenAIndex = coinIds[address(poolACS4UST)][address(tokenA)];
        int128 _tokenBIndex = coinIds[address(poolACS4UST)][address(tokenB)];

        // console.log("_tokenAIndex %s _tokenBIndex %s amountA %s", uint128(_tokenAIndex), uint128(_tokenBIndex), amountA);
        uint256 received = poolACS4UST.exchange_underlying(
            _tokenAIndex,
            _tokenBIndex,
            amountA,
            0
        );

        tokenB.transfer(to, received);

        return received;
    }
}
