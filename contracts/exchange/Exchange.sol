//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IExchangePlugin.sol";
import {TokenPrice} from "../lib/Structs.sol";
import {toUniform, fromUniform, MAX_BPS} from "../lib/Math.sol";

contract Exchange is UUPSUpgradeable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct RouteParams {
        // default exchStrategyRouterange to use, could have low slippage but also lower liquidity
        address defaultRoute;
        // whenever input amount is over limit, then should use secondRoute
        uint256 limit;
        // second exchange, could have higher slippage but also higher liquidity
        address secondRoute;
        // custom slippage for this route in bps
        uint256 customSlippageInBps;
    }

    // which plugin to use for swap for this pair
    // tokenA -> tokenB -> RouteParams
    mapping(address => mapping(address => RouteParams)) public routes;

    uint256 public constant MAX_STABLECOIN_SLIPPAGE_IN_BPS = 1000;
    uint256 public constant LIMIT_PRECISION = 1e12;
    uint256 public maxStablecoinSlippageInBps;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();

        // transer ownership and set proxi admin to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);
        _changeAdmin(tx.origin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setMaxStablecoinSlippageInBps(uint256 newMaxSlippage) external onlyOwner {
        if (newMaxSlippage > MAX_STABLECOIN_SLIPPAGE_IN_BPS) revert SlippageValueIsAboveMaxBps();
        maxStablecoinSlippageInBps = newMaxSlippage;
    }

    /// @notice Choose plugin where pair of tokens should be swapped.
    function setRoute(
        address[] calldata tokensA,
        address[] calldata tokensB,
        address[] calldata plugin
    ) external onlyOwner {
        for (uint256 i = 0; i < tokensA.length; i++) {
            (address token0, address token1) = sortTokens(tokensA[i], tokensB[i]);
            routes[token0][token1].defaultRoute = plugin[i];
        }
    }

    /// @notice Choose plugin where pair of tokens should be swapped.
    function setRouteEx(
        address[] calldata tokensA,
        address[] calldata tokensB,
        RouteParams[] calldata _routes
    ) external onlyOwner {
        for (uint256 i = 0; i < tokensA.length; i++) {
            (address token0, address token1) = sortTokens(tokensA[i], tokensB[i]);
            if (_routes[i].customSlippageInBps > MAX_STABLECOIN_SLIPPAGE_IN_BPS) revert SlippageValueIsAboveMaxBps();
            routes[token0][token1] = _routes[i];
        }
    }

    function getPlugin(uint256 amountA, address tokenA, address tokenB) public view returns (address plugin) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        uint256 limit = routes[token0][token1].limit;
        // decimals: 12 + tokenA.decimals - 12 = tokenA.decimals
        uint256 limitWithDecimalsOfTokenA = (limit * 10 ** ERC20(tokenA).decimals()) / LIMIT_PRECISION;
        if (limit == 0 || amountA < limitWithDecimalsOfTokenA) plugin = routes[token0][token1].defaultRoute;
        else plugin = routes[token0][token1].secondRoute;
        if (plugin == address(0)) revert RouteNotFound();
        return plugin;
    }

    function getExchangeProtocolFee(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) public view returns (uint256 feePercent) {
        address plugin = getPlugin(amountA, address(tokenA), address(tokenB));
        return IExchangePlugin(plugin).getExchangeProtocolFee(tokenA, tokenB);
    }

    function getSlippageInBps(address tokenA, address tokenB) public view returns (uint256 slippageInBps) {
        slippageInBps = routes[tokenA][tokenB].customSlippageInBps;

        // set default slippage if not set
        if (slippageInBps == 0) slippageInBps = maxStablecoinSlippageInBps;
    }

    function stablecoinSwap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) public returns (uint256 amountReceived) {
        address plugin = getPlugin(amountA, address(tokenA), address(tokenB));
        uint256 minAmountOut = calculateMinAmountOut(amountA, tokenA, tokenB, usdPriceTokenA, usdPriceTokenB);
        IERC20Upgradeable(tokenA).safeTransfer(plugin, amountA);
        amountReceived = IExchangePlugin(plugin).swap(amountA, tokenA, tokenB, to, minAmountOut);
        if (amountReceived == 0) revert RoutedSwapFailed();
    }

    function protectedSwap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) public returns (uint256 amountReceived) {
        return stablecoinSwap(amountA, tokenA, tokenB, to, usdPriceTokenA, usdPriceTokenB);
    }

    function swap(uint256 amountA, address tokenA, address tokenB, address to) public returns (uint256 amountReceived) {
        address plugin = getPlugin(amountA, address(tokenA), address(tokenB));
        IERC20Upgradeable(tokenA).safeTransfer(plugin, amountA);
        amountReceived = IExchangePlugin(plugin).swap(amountA, tokenA, tokenB, to, 0);
        if (amountReceived == 0) revert RoutedSwapFailed();
    }

    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function calculateMinAmountOut(
        uint256 amountA,
        address tokenA,
        address tokenB,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) private view returns (uint256 minAmountOut) {
        uint256 amountAInUsd = (toUniform(amountA, tokenA) * usdPriceTokenA.price) / 10 ** usdPriceTokenA.priceDecimals;
        minAmountOut = (amountAInUsd * 10 ** usdPriceTokenB.priceDecimals) / usdPriceTokenB.price;
        minAmountOut = (minAmountOut * (1e18 - getExchangeProtocolFee(amountA, tokenA, tokenB))) / 1e18;
        minAmountOut = (minAmountOut * (MAX_BPS - getSlippageInBps(tokenA, tokenB))) / MAX_BPS;
        minAmountOut = fromUniform(minAmountOut, tokenB);
    }

    function getRoutePrice(address tokenA, address tokenB) external view returns (uint256 price) {
        address plugin = getPlugin(0, address(tokenA), address(tokenB));
        return IExchangePlugin(plugin).getRoutePrice(tokenA, tokenB);
    }

    /* ERRORS */

    error RoutedSwapFailed();
    error RouteNotFound();
    error SlippageValueIsAboveMaxBps();
}
