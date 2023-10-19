//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IWombatRouter.sol";
import "../interfaces/IWombatPool.sol";
import "../interfaces/IExchangePlugin.sol";
import {SphereXProtected} from "@spherex-xyz/contracts/src/SphereXProtected.sol";

contract WombatPlugin is IExchangePlugin, Ownable {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => address)) public pools;
    mapping(address => mapping(address => address)) public mediatorTokens;

    IWombatRouter immutable wombatRouter;

    uint256 private constant FEE_PERCENT_DENOMINATOR = 1e18;

    constructor(address _wombatRouter) {
        wombatRouter = IWombatRouter(_wombatRouter);

        if (tx.origin != msg.sender) {
            // set proxi owner to address that deployed this contract from Create2Deployer
            transferOwnership(tx.origin);
        }
    }

    function swap(uint256 amountA, address tokenA, address tokenB, address to, uint256 minAmountOut)
        public
        override
        sphereXGuardPublic(50, 0x10e2df9b)
        returns (uint256 amountReceivedTokenB)
    {
        if (amountA == 0) return 0;
        (address[] memory tokenPath, address[] memory poolPath) = getPathsForTokenPair(tokenA, tokenB);

        IERC20 tokenAContract = IERC20(tokenPath[0]);
        tokenAContract.safeApprove(address(wombatRouter), 0);
        tokenAContract.safeApprove(address(wombatRouter), amountA);

        // Perform the swap on router and get the amount of tokenB received
        amountReceivedTokenB =
            wombatRouter.swapExactTokensForTokens(tokenPath, poolPath, amountA, minAmountOut, to, block.timestamp);
    }

    // Setters

    function setPoolForPair(
        address _pool, // set zero address to disable pool for a pair
        address[2] calldata pair
    ) public onlyOwner sphereXGuardPublic(48, 0xe4a38249) {
        (address token0, address token1) = sortTokens(pair[0], pair[1]);
        pools[token0][token1] = _pool;
    }

    function setPoolsForPairs(address[] calldata pools_, address[2][] calldata pairs)
        external
        onlyOwner
        sphereXGuardExternal(49)
    {
        for (uint256 i = 0; i < pairs.length; i++) {
            setPoolForPair(pools_[i], pairs[i]);
        }
    }

    function setMediatorTokenForPair(
        address _mediatorToken, // set zero address to disable mediatorToken for a pair
        address[2] calldata pair
    ) public onlyOwner sphereXGuardPublic(46, 0x4ad79155) {
        (address token0, address token1) = sortTokens(pair[0], pair[1]);
        if (token0 == _mediatorToken || token1 == _mediatorToken) revert CanNotSetIdenticalMediatorToken();
        mediatorTokens[token0][token1] = _mediatorToken;
    }

    function setMediatorTokensForPairs(address[] calldata mediatorTokens_, address[2][] calldata pairs)
        external
        onlyOwner
        sphereXGuardExternal(47)
    {
        for (uint256 i = 0; i < pairs.length; i++) {
            setMediatorTokenForPair(mediatorTokens_[i], pairs[i]);
        }
    }

    // Getters

    function getPathsForTokenPair(address tokenA, address tokenB)
        public
        view
        returns (address[] memory tokenPath, address[] memory poolPath)
    {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        address mediatorToken = mediatorTokens[token0][token1];

        if (mediatorToken != address(0)) {
            (address token0AM, address token1AM) = sortTokens(tokenA, mediatorToken);
            (address token0MB, address token1MB) = sortTokens(mediatorToken, tokenB);
            address poolAM = pools[token0AM][token1AM];
            address poolMB = pools[token0MB][token1MB];

            if (poolAM == address(0) || poolMB == address(0)) revert RouteNotFound();

            poolPath = new address[](2);
            poolPath[0] = poolAM;
            poolPath[1] = poolMB;

            tokenPath = new address[](3);
            tokenPath[0] = tokenA;
            tokenPath[1] = mediatorToken;
            tokenPath[2] = tokenB;
        } else {
            address pool = pools[token0][token1];

            if (pool == address(0)) revert RouteNotFound();

            poolPath = new address[](1);
            poolPath[0] = pool;

            tokenPath = new address[](2);
            tokenPath[0] = tokenA;
            tokenPath[1] = tokenB;
        }
    }

    function getExchangeProtocolFee(address tokenA, address tokenB) public view override returns (uint256 feePercent) {
        (, address[] memory poolPath) = getPathsForTokenPair(tokenA, tokenB);

        if (poolPath.length > 1) {
            uint256 feePercentAM = IWombatPool(poolPath[0]).haircutRate();
            uint256 feePercentMB = IWombatPool(poolPath[1]).haircutRate();
            feePercent = calculateFeePercentWithMediatorToken(feePercentAM, feePercentMB);
        } else {
            feePercent = IWombatPool(poolPath[0]).haircutRate();
        }
    }

    // Utility functions

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
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

    function getRoutePrice(address tokenA, address tokenB) external view override returns (uint256 price) {
        (address[] memory tokenPath, address[] memory poolPath) = getPathsForTokenPair(tokenA, tokenB);

        int256 precisionA = int256(10 ** IERC20Metadata(tokenA).decimals());

        (uint256 amountOut,) = wombatRouter.getAmountOut(tokenPath, poolPath, precisionA);

        return amountOut;
    }

    /* ERRORS */

    error CanNotSetIdenticalMediatorToken();
    error RouteNotFound();
}
