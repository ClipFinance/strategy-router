//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../lib/FullMath.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "../interfaces/IExchangePlugin.sol";
import "../interfaces/IUniswapV3Router.sol";

contract UniswapV3Plugin is IExchangePlugin, Ownable {
    using SafeERC20 for IERC20;

    struct PairData {
        // the fee tier for a pair
        uint24 feeTier;
        // the full fee percent for a swap with a pair when 1e18 is 100%
        uint256 feePercent;
        // the ERC20-like token to be used as a mediator for a pair whether swap should be done through it
        address mediatorToken;
        // the path of a token0/token1 pair for swap
        bytes path01;
        // the path of a token1/token0 pair for swap
        bytes path10;
    }

    uint256 private constant FEE_TIER_DENOMINATOR = 1e6;
    uint256 private constant FEE_PERCENT_DENOMINATOR = 1e18;

    IUniswapV3Router immutable uniswapRouter;

    mapping(address => mapping(address => PairData)) public pairsData;

    constructor(address _uniswapRouter) {
        // set uniswap-v3-like router.
        uniswapRouter = IUniswapV3Router(_uniswapRouter);

        if (tx.origin != msg.sender) {
            // set proxi owner to address that deployed this contract from Create2Deployer
            transferOwnership(tx.origin);
        }
    }

    function setSingleHopPairData(uint24 _feeTier, address[2] calldata pair) public onlyOwner {
        (address token0, address token1) = _sortTokens(pair[0], pair[1]);

        uint256 _feePercent;
        bytes memory _path01;
        bytes memory _path10;

        // calculate fee percent and path if fee tier is not zero, otherwise set initial zero values
        if (_feeTier != 0) {
            _feePercent = (_feeTier * FEE_PERCENT_DENOMINATOR) / FEE_TIER_DENOMINATOR;

            _path01 = abi.encodePacked(token0, _feeTier, token1);
            _path10 = abi.encodePacked(token1, _feeTier, token0);
        }

        pairsData[token0][token1] = PairData({
            feeTier: _feeTier,
            feePercent: _feePercent,
            mediatorToken: address(0), // set mediatorToken as zero address for a single-hop pair
            path01: _path01,
            path10: _path10
        });
    }

    function setSingleHopPairsData(uint24[] calldata feeTiers, address[2][] calldata pairs) external onlyOwner {
        for (uint256 i = 0; i < pairs.length; i++) {
            setSingleHopPairData(feeTiers[i], pairs[i]);
        }
    }

    /// @dev The mediator token can be set only for already set single-hop pairs.
    function setMultiHopPairData(address _mediatorToken, address[2] calldata pair) public onlyOwner {
        (address token0, address token1) = _sortTokens(pair[0], pair[1]);
        if (_mediatorToken == token0 || _mediatorToken == token1) revert CanNotSetIdenticalMediatorToken();

        uint256 _feePercent;
        bytes memory _path01;
        bytes memory _path10;

        // calculate fee percent and path if _mediatorToken is not zero address, otherwise set initial zero values
        if (_mediatorToken != address(0)) {
            (uint24 feeTier0M, uint256 feePercent0M, address mediatorToken0M,,) = getPairData(token0, _mediatorToken);
            (uint24 feeTier1M, uint256 feePercent1M, address mediatorToken1M,,) = getPairData(token1, _mediatorToken);
            if (mediatorToken0M != address(0) || mediatorToken1M != address(0)) {
                revert MediatorPairHasItsOwnMediatorToken();
            }

            _feePercent = calculateFeePercentWithMediatorToken(feePercent0M, feePercent1M);

            _path01 = abi.encodePacked(token0, feeTier0M, _mediatorToken, feeTier1M, token1);
            _path10 = abi.encodePacked(token1, feeTier1M, _mediatorToken, feeTier0M, token0);
        }

        pairsData[token0][token1] = PairData({
            feeTier: 0, // set zero fee tier for a multi-hop pair
            feePercent: _feePercent,
            mediatorToken: _mediatorToken,
            path01: _path01,
            path10: _path10
        });
    }

    function setMultiHopPairsData(address[] calldata mediatorTokens, address[2][] calldata pairs) external onlyOwner {
        for (uint256 i = 0; i < pairs.length; i++) {
            setMultiHopPairData(mediatorTokens[i], pairs[i]);
        }
    }

    function getPairData(address tokenA, address tokenB)
        public
        view
        returns (uint24 feeTier, uint256 feePercent, address mediatorToken, bytes memory pathAB, bytes memory pathBA)
    {
        (address token0, address token1) = _sortTokens(tokenA, tokenB);

        PairData memory pairData = pairsData[token0][token1];

        // revert if pair data is not set
        if (pairData.path01.length == 0) revert PairDataNotSet();

        return (
            pairData.feeTier,
            pairData.feePercent,
            pairData.mediatorToken,
            (tokenA == token0) ? pairData.path01 : pairData.path10,
            (tokenA == token0) ? pairData.path10 : pairData.path01
        );
    }

    function swap(uint256 amountA, address tokenA, address tokenB, address to, uint256 minAmountOut)
        external
        override
        returns (uint256 amountReceivedTokenB)
    {
        if (amountA == 0) return 0;

        (,,, bytes memory pathAB,) = getPairData(tokenA, tokenB);

        IERC20(tokenA).safeApprove(address(uniswapRouter), amountA);

        amountReceivedTokenB = uniswapRouter.exactInput(
            ISwapRouter.ExactInputParams({
                path: pathAB,
                recipient: to,
                deadline: block.timestamp,
                amountIn: amountA,
                amountOutMinimum: minAmountOut
            })
        );
    }

    /// @dev returns the fee percent for the pair when 1e18 is 100%
    function getExchangeProtocolFee(address tokenA, address tokenB)
        external
        view
        override
        returns (uint256 feePercent)
    {
        (, feePercent,,,) = getPairData(tokenA, tokenB);
    }

    // Internal functions

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    /// @dev calculate fee percents 100% - (100% - feePercentAM) * (100% - feePercentMB) / 100%
    function calculateFeePercentWithMediatorToken(uint256 feePercentAM, uint256 feePercentMB)
        internal
        pure
        returns (uint256 feePercent)
    {
        feePercent = FEE_PERCENT_DENOMINATOR
            - ((FEE_PERCENT_DENOMINATOR - feePercentAM) * (FEE_PERCENT_DENOMINATOR - feePercentMB))
                / FEE_PERCENT_DENOMINATOR;
    }

    function getRoutePrice(address tokenA, address tokenB) external view returns (uint256 price) {
        (uint24 feeTierAB,, address mediatorToken,,) = getPairData(tokenA, tokenB);

        uint256 precisionA = 10 ** IERC20Metadata(tokenA).decimals();
        uint256 precisionB = 10 ** IERC20Metadata(tokenB).decimals();

        if (mediatorToken != address(0)) {
            uint256 precisionM = 10 ** IERC20Metadata(mediatorToken).decimals();
            (uint24 feeTierAM,,,,) = getPairData(tokenA, mediatorToken);
            (uint24 feeTierMB,,,,) = getPairData(mediatorToken, tokenB);

            uint256 priceAM = _getRoutePrice(tokenA, precisionA, mediatorToken, precisionM, feeTierAM);
            uint256 priceMB = _getRoutePrice(mediatorToken, precisionM, tokenB, precisionB, feeTierMB);

            return FullMath.mulDiv(priceAM, priceMB, precisionB);
        } else {
            return _getRoutePrice(tokenA, precisionA, tokenB, precisionB, feeTierAB);
        }
    }

    /// @notice Returns price of tokenA in tokenB with decimalsB.
    function _getRoutePrice(address tokenA, uint256 precisionA, address tokenB, uint256 precisionB, uint24 feeTier)
        internal
        view
        returns (uint256 price)
    {
        uint160 sqrtPriceX96 = _getSqrtPriceX96(tokenA, tokenB, feeTier);

        // return 0 if sqrtPriceX96 is zero
        if (sqrtPriceX96 == 0) return 0;

        bool isToken0A = tokenA < tokenB;

        uint256 routePrice = FullMath.mulDiv(uint256(sqrtPriceX96) * uint256(sqrtPriceX96), precisionA, 2 ** (96 * 2));

        return isToken0A ? routePrice : (precisionB * precisionA) / routePrice;
    }

    function _getSqrtPriceX96(address tokenA, address tokenB, uint24 feeTier)
        public
        view
        returns (uint160 sqrtPriceX96)
    {
        IUniswapV3Factory factory = IUniswapV3Factory(uniswapRouter.factory());

        address poolAddress = factory.getPool(tokenA, tokenB, feeTier);
        bytes4 slot0Selector = bytes4(keccak256("slot0()"));

        (, bytes memory result) = poolAddress.staticcall(abi.encodeWithSelector(slot0Selector));

        // slice the first bytes for the sqrtPriceX96 value
        sqrtPriceX96 = abi.decode(result, (uint160));
    }

    /* ERRORS */

    error CanNotSetIdenticalMediatorToken();
    error MediatorPairHasItsOwnMediatorToken();
    error PairDataNotSet();
}
