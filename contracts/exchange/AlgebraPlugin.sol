//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../lib/FullMath.sol";
import "../interfaces/IAlgebraRouter.sol";
import "../interfaces/IAlgebraFactory.sol";
import "../interfaces/IAlgebraPool.sol";
import "../interfaces/IExchangePlugin.sol";
import {SphereXProtected} from "@spherex-xyz/contracts/src/SphereXProtected.sol";

// import "hardhat/console.sol";

contract AlgebraPlugin is IExchangePlugin, Ownable {
    // whether swap for the pair should be done through some ERC20-like token as intermediary
    mapping(address => mapping(address => address)) public mediatorTokens;

    IAlgebraRouter immutable algebraRouter;
    IAlgebraFactory immutable algebraFactory;

    uint256 private constant FEE_PERCENT_DENOMINATOR = 1e18;
    uint256 private constant POOL_FEE_DENOMINATOR = 1e6;

    constructor(IAlgebraRouter _algebraRouter, IAlgebraFactory _algebraFactory) {
        algebraRouter = IAlgebraRouter(_algebraRouter);
        algebraFactory = IAlgebraFactory(_algebraFactory);

        if (tx.origin != msg.sender) {
            // set proxi owner to address that deployed this contract from Create2Deployer
            transferOwnership(tx.origin);
        }
    }

    function setMediatorTokenForPair(
        address _mediatorToken, // set zero address to disable mediatorToken for a pair
        address[2] calldata pair
    ) public onlyOwner sphereXGuardPublic(8, 0x4ad79155) {
        (address token0, address token1) = sortTokens(pair[0], pair[1]);
        if (token0 == _mediatorToken || token1 == _mediatorToken) revert CanNotSetIdenticalMediatorToken();
        mediatorTokens[token0][token1] = _mediatorToken;
    }

    function setMediatorTokensForPairs(address[] calldata mediatorTokens_, address[2][] calldata pairs)
        external
        onlyOwner
        sphereXGuardExternal(9)
    {
        for (uint256 i = 0; i < pairs.length; i++) {
            setMediatorTokenForPair(mediatorTokens_[i], pairs[i]);
        }
    }

    function getPathForTokenPair(address tokenA, address tokenB) public view returns (bytes memory pairPath) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        if (mediatorToken != address(0)) return abi.encodePacked(tokenA, mediatorToken, tokenB);
        else return abi.encodePacked(tokenA, tokenB);
    }

    function swap(uint256 amountA, address tokenA, address tokenB, address to, uint256 minAmountOut)
        public
        override
        sphereXGuardPublic(10, 0x10e2df9b)
        returns (uint256 amountReceivedTokenB)
    {
        if (amountA == 0) return 0;
        bytes memory pairPath = getPathForTokenPair(tokenA, tokenB);

        IERC20(tokenA).approve(address(algebraRouter), amountA);

        // Perform the swap on router and get the amount of tokenB received
        amountReceivedTokenB = algebraRouter.exactInput(
            IAlgebraRouter.ExactInputParams({
                path: pairPath,
                recipient: to,
                deadline: block.timestamp,
                amountIn: amountA,
                amountOutMinimum: minAmountOut
            })
        );
    }

    function getExchangeProtocolFee(address tokenA, address tokenB) public view override returns (uint256 feePercent) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        if (mediatorToken != address(0)) {
            IAlgebraPool poolAM = IAlgebraPool(algebraFactory.poolByPair(tokenA, mediatorToken));
            (,, uint16 feeAM,,,,) = poolAM.globalState();
            IAlgebraPool poolMB = IAlgebraPool(algebraFactory.poolByPair(mediatorToken, tokenB));
            (,, uint16 feeMB,,,,) = poolMB.globalState();

            return calculateFeePercentWithMediatorToken(feeAM, feeMB);
        } else {
            IAlgebraPool pool = IAlgebraPool(algebraFactory.poolByPair(tokenA, tokenB));
            (,, uint16 fee,,,,) = pool.globalState();

            return (fee * FEE_PERCENT_DENOMINATOR) / POOL_FEE_DENOMINATOR;
        }
    }

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    /// @dev calculate fee percents 100% - (100% - feePercentAM) * (100% - feePercentMB) / 100%
    function calculateFeePercentWithMediatorToken(uint16 feeAM, uint16 feeMB)
        internal
        pure
        returns (uint256 feePercent)
    {
        uint256 feePercentAM = (feeAM * FEE_PERCENT_DENOMINATOR) / POOL_FEE_DENOMINATOR;
        uint256 feePercentMB = (feeMB * FEE_PERCENT_DENOMINATOR) / POOL_FEE_DENOMINATOR;

        feePercent = FEE_PERCENT_DENOMINATOR
            - ((FEE_PERCENT_DENOMINATOR - feePercentAM) * (FEE_PERCENT_DENOMINATOR - feePercentMB))
                / FEE_PERCENT_DENOMINATOR;
    }

    function getRoutePrice(address tokenA, address tokenB) external view override returns (uint256 price) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        uint256 precisionA = 10 ** IERC20Metadata(tokenA).decimals();
        uint256 precisionB = 10 ** IERC20Metadata(tokenB).decimals();

        if (mediatorToken != address(0)) {
            uint256 precisionM = 10 ** IERC20Metadata(mediatorToken).decimals();
            uint256 priceAM = _getRoutePrice(tokenA, precisionA, mediatorToken, precisionM);
            uint256 priceMB = _getRoutePrice(mediatorToken, precisionM, tokenB, precisionB);

            return FullMath.mulDiv(priceAM, priceMB, precisionB);
        } else {
            return _getRoutePrice(tokenA, precisionA, tokenB, precisionB);
        }
    }

    /// @notice Returns price of tokenA in tokenB with decimalsB.
    function _getRoutePrice(address tokenA, uint256 precisionA, address tokenB, uint256 precisionB)
        internal
        view
        returns (uint256 price)
    {
        IAlgebraPool pool = IAlgebraPool(algebraFactory.poolByPair(tokenA, tokenB));
        (uint160 sqrtPriceX96,,,,,,) = pool.globalState();

        bool isToken0A = tokenA < tokenB;
        (uint256 precision0, uint256 precision1) = isToken0A ? (precisionA, precisionB) : (precisionB, precisionA);

        uint256 routePrice = FullMath.mulDiv(uint256(sqrtPriceX96) * uint256(sqrtPriceX96), precision0, 2 ** (96 * 2));

        return isToken0A ? routePrice : (precision1 * precision0) / routePrice;
    }

    /* ERRORS */

    error CanNotSetIdenticalMediatorToken();
}
