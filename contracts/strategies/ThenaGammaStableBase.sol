//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../deps/UUPSUpgradeable.sol";

import "../lib/FullMath.sol";
import "../lib/TickMath.sol";

import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IExchange.sol";
import "../interfaces/IThenaHypervisor.sol";
import "../interfaces/IGammaUniProxy.sol";
import "../interfaces/IThenaGaugeV2.sol";
import "../interfaces/IUsdOracle.sol";

import "../interfaces/IStrategyRouter.sol";
import "./AbstractBaseStrategyWithHardcap.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract ThenaGammaStableBase is UUPSUpgradeable, OwnableUpgradeable, IStrategy, AbstractBaseStrategyWithHardcap {
    using SafeERC20 for IERC20Metadata;

    address internal upgrader;

    IStrategyRouter public immutable strategyRouter;
    IERC20Metadata public immutable tokenA;
    IERC20Metadata public immutable tokenB;
    IThenaHypervisor public immutable lpToken;
    IGammaUniProxy public immutable lpManager;
    IThenaGaugeV2 public immutable farm;
    IERC20Metadata public immutable the; // Thena token
    IUsdOracle public immutable oracle;

    uint256 private immutable PRICE_THRESHOLD;
    uint256 private constant PERCENT_DENOMINATOR = 10000;

    uint256 private immutable LP_PRICE_PRECISION;
    uint8 private constant UNIFORM_DECIMALS = 18;
    uint256 private constant UNIFORM_PRECISION = 1e18;

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    constructor(
        IStrategyRouter _strategyRouter,
        IERC20Metadata _tokenA,
        IERC20Metadata _tokenB,
        IThenaHypervisor _lpToken,
        IGammaUniProxy _lpManager,
        IThenaGaugeV2 _farm,
        IERC20Metadata _the,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    ) {
        address _lpTokenToken0 = address(_lpToken.token0());
        address _lpTokenToken1 = address(_lpToken.token1());
        if (_lpTokenToken0 != address(_tokenA) && _lpTokenToken1 != address(_tokenA)) revert InvalidInput();
        if (_lpTokenToken0 != address(_tokenB) && _lpTokenToken1 != address(_tokenB)) revert InvalidInput();
        tokenA = _tokenA;
        tokenB = _tokenB;

        strategyRouter = _strategyRouter;

        lpToken = _lpToken;
        lpManager = _lpManager;
        farm = _farm;
        the = _the;

        oracle = _oracle;
        if (_priceManipulationPercentThresholdInBps > PERCENT_DENOMINATOR) revert InvalidPriceThreshold();
        PRICE_THRESHOLD = _priceManipulationPercentThresholdInBps;

        LP_PRICE_PRECISION = _lpToken.PRECISION();
    }

    function initialize(bytes memory initializeData) external initializer {
        (
            address _upgrader,
            uint256 _hardcapTargetInToken,
            uint16 _hardcapDeviationInBps,
            address[] memory depositors
        ) = abi.decode(initializeData, (address, uint256, uint16, address[]));

        super.initialize(_hardcapTargetInToken, _hardcapDeviationInBps, depositors);

        __UUPSUpgradeable_init();
        upgrader = _upgrader;

        // set proxi admin to address that deployed this contract from Create2Deployer
        _changeAdmin(tx.origin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    /// @notice Deposit token of the strategy
    function depositToken() external view override returns (address) {
        return address(tokenA);
    }

    function rewardToken() external view override returns (address) {
        return address(the);
    }

    function getPendingReward() external view override returns (uint256) {
        return farm.earned(address(this));
    }

    function totalTokens() external view override returns (uint256) {
        return _totalTokens();
    }

    function withdraw(uint256 amountAToWithdraw) external override onlyOwner returns (uint256 amountWithdrawn) {
        uint256 tokenABalance = tokenA.balanceOf(address(this));

        if (tokenABalance < amountAToWithdraw) {
            uint256 amountLpToRemove = _calculateAmountLpByTokenA(amountAToWithdraw - tokenABalance);

            uint256 amountStakedLp = farm.balanceOf(address(this));
            if (amountLpToRemove > amountStakedLp) amountLpToRemove = amountStakedLp;

            if (amountLpToRemove != 0) {
                TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
                TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));

                _checkPriceManipulation(tokenAOracleData, tokenBOracleData);

                farm.withdraw(amountLpToRemove);

                lpToken.withdraw(amountLpToRemove, address(this), address(this), _getMinAmountsArray());

                IExchange exchange = strategyRouter.getExchange();

                // Swap amountB to tokenA
                uint256 amountB = tokenB.balanceOf(address(this));
                tokenB.safeTransfer(address(exchange), amountB);
                exchange.stablecoinSwap(
                    amountB,
                    address(tokenB),
                    address(tokenA),
                    address(this),
                    tokenAOracleData,
                    tokenBOracleData
                );

                tokenABalance = tokenA.balanceOf(address(this));
            }

            if (tokenABalance < amountAToWithdraw) {
                amountAToWithdraw = tokenABalance;
            }
        }

        tokenA.safeTransfer(msg.sender, amountAToWithdraw);

        _compoundThena();

        return amountAToWithdraw;
    }

    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        // Withdraw from farming pool and harvest reward
        farm.withdrawAllAndHarvest();

        // Remove liquidity
        uint256 amountLp = lpToken.balanceOf(address(this));
        if (amountLp > 0) {
            lpToken.withdraw(amountLp, address(this), address(this), _getMinAmountsArray());
        }

        uint256 amountA = tokenA.balanceOf(address(this));
        uint256 amountB = tokenB.balanceOf(address(this));

        IExchange exchange = strategyRouter.getExchange();

        // Swap amountB to amountA
        if (amountB > 0) {
            tokenB.safeTransfer(address(exchange), amountB);
            amountA += exchange.stablecoinSwap(
                amountB,
                address(tokenB),
                address(tokenA),
                address(this),
                getOraclePrice(address(tokenB)),
                getOraclePrice(address(tokenA))
            );
        }

        // Sell reward to tokenA
        uint256 amountThena = the.balanceOf(address(this));
        if (amountThena > 0) {
            the.safeTransfer(address(exchange), amountThena);
            amountA += exchange.swap(amountThena, address(the), address(tokenA), address(this));
        }

        // Transfer tokens
        if (amountA > 0) {
            tokenA.safeTransfer(msg.sender, amountA);
            return amountA;
        }
    }

    function compound() external override onlyOwner {
        _compoundThena();
    }

    // Internal functions

    function _compoundThena() internal {
        // Get reward
        farm.getReward();

        uint256 amountThena = the.balanceOf(address(this));

        if (amountThena > 0) {
            // Sell reward to tokenA
            IExchange exchange = strategyRouter.getExchange();
            the.safeTransfer(address(exchange), amountThena);
            exchange.swap(amountThena, address(the), address(tokenA), address(this));

            fix_leftover(0);

            uint256 amountA = tokenA.balanceOf(address(this));
            uint256 amountB = tokenB.balanceOf(address(this));

            // Add liquidity
            tokenA.safeApprove(address(lpToken), amountA);
            tokenB.safeApprove(address(lpToken), amountB);

            (uint256 amount0, uint256 amount1) = tokenA == lpToken.token0() ? (amountA, amountB) : (amountB, amountA);

            IGammaUniProxy(lpToken.whitelistedAddress()).deposit(
                amount0,
                amount1,
                address(this),
                address(lpToken),
                _getMinAmountsArray()
            );

            // Approve and stake lp tokens
            uint256 amountLp = lpToken.balanceOf(address(this));
            lpToken.approve(address(farm), amountLp);

            farm.deposit(amountLp);
        }
    }

    /// @dev Swaps leftover tokens for a better ratio for LP.
    function fix_leftover(uint256 amountIgnore) private {
        TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
        TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));

        uint256 amountB = tokenB.balanceOf(address(this));
        uint256 amountA = tokenA.balanceOf(address(this)) - amountIgnore;

        // Convert amountB and amountA to total amount in USD
        uint256 currentAmountAInUsd = (amountA * tokenAOracleData.price) / (10 ** tokenAOracleData.priceDecimals);
        uint256 currentAmountBInUsd = (amountB * tokenBOracleData.price) / (10 ** tokenBOracleData.priceDecimals);

        uint256 totalAmountInUsd = currentAmountAInUsd + currentAmountBInUsd;

        // Get reserves
        (uint256 reserve0, uint256 reserve1) = lpToken.getTotalAmounts();
        (uint256 reserveA, uint256 reserveB) = tokenA == lpToken.token0() ? (reserve0, reserve1) : (reserve1, reserve0);

        uint256 reserveTokenBRatio = (reserveB * UNIFORM_PRECISION) / reserveA;

        uint256 oraclePriceAB = getPairPrice(tokenAOracleData, tokenBOracleData);

        // Calculate totalRatio depending on price and reserves
        uint256 totalBRatio = (reserveTokenBRatio * oraclePriceAB) / UNIFORM_PRECISION;

        // Calculate desired amount of tokenA and tokenB in USD
        uint256 desiredAmountBInUsd = (totalAmountInUsd * totalBRatio) / (totalBRatio + UNIFORM_PRECISION);
        uint256 desiredAmountAInUsd = totalAmountInUsd - desiredAmountBInUsd;

        // Check leftover and calculate which and how amount need to swap
        uint256 toSwap;
        IExchange exchange = strategyRouter.getExchange();

        if (desiredAmountAInUsd > currentAmountAInUsd) {
            _checkPriceManipulation(tokenAOracleData, tokenBOracleData);
            // Swap tokenB to tokenA
            toSwap =
                ((desiredAmountAInUsd - currentAmountAInUsd) * (10 ** tokenBOracleData.priceDecimals)) /
                tokenBOracleData.price;
            tokenB.safeTransfer(address(exchange), toSwap);
            exchange.stablecoinSwap(
                toSwap,
                address(tokenB),
                address(tokenA),
                address(this),
                tokenBOracleData,
                tokenAOracleData
            );
        } else if (desiredAmountBInUsd > currentAmountBInUsd) {
            _checkPriceManipulation(tokenAOracleData, tokenBOracleData);
            // Swap tokenA to tokenB
            toSwap =
                ((desiredAmountBInUsd - currentAmountBInUsd) * (10 ** tokenAOracleData.priceDecimals)) /
                tokenAOracleData.price;
            tokenA.safeTransfer(address(exchange), toSwap);
            exchange.stablecoinSwap(
                toSwap,
                address(tokenA),
                address(tokenB),
                address(this),
                tokenAOracleData,
                tokenBOracleData
            );
        }
    }

    function _deposit(uint256 _amount) internal override {
        if (_amount == 0) return;
        if (_amount > tokenA.balanceOf(address(this))) revert DepositAmountExceedsBalance();

        // Provide liquidity and get lp tokens
        (uint256 amount0, uint256 amount1) = _prepareTokensToDeposit(_amount);
        IGammaUniProxy(lpToken.whitelistedAddress()).deposit(
            amount0,
            amount1,
            address(this),
            address(lpToken),
            _getMinAmountsArray()
        );

        // Approve and stake lp tokens
        uint256 amountLp = lpToken.balanceOf(address(this));
        lpToken.approve(address(farm), amountLp);

        farm.deposit(amountLp);
    }

    function _totalTokens() internal view override returns (uint256 amountTokenA) {
        uint256 amountTokenB;
        // Get amount of LP tokens
        uint256 amountLp = farm.balanceOf(address(this)) + lpToken.balanceOf(address(this));

        (uint256 currentLpPrice, uint256 priceToken1PerLpToken) = getLpPrices();

        // Convert amount of LP tokens to amount of token1
        uint256 totalAmount1 = (amountLp * priceToken1PerLpToken) / UNIFORM_PRECISION;

        if (tokenA == lpToken.token0()) {
            // Add tokenB balance
            amountTokenB = totalAmount1 + tokenB.balanceOf(address(this));

            // Convert tokenB to tokenA
            amountTokenA = (amountTokenB * LP_PRICE_PRECISION) / currentLpPrice;
            // Add tokenA balance
            amountTokenA += tokenA.balanceOf(address(this));
        } else {
            // Add tokenA balance
            amountTokenA = totalAmount1 + tokenA.balanceOf(address(this));

            // Convert tokenB balance to tokenA
            amountTokenA += (tokenB.balanceOf(address(this)) * LP_PRICE_PRECISION) / currentLpPrice;
        }
    }

    function _prepareTokensToDeposit(
        uint256 totalAmountA
    ) internal returns (uint256 amount0, uint256 amount1) {
        TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
        TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));


        // Check price manipulation
        _checkPriceManipulation(tokenAOracleData, tokenBOracleData);

        // Calculate the required amount of tokenA to deposit with the required ratio
        uint256 amountAToSell = _calculateAmountAToSellByAmountA(totalAmountA, tokenAOracleData, tokenBOracleData);

        // Subtract exchange fee
        IExchange exchange = strategyRouter.getExchange();
        uint256 dexFee = exchange.getExchangeProtocolFee(amountAToSell, address(tokenA), address(tokenB));
        amountAToSell = (amountAToSell * (1e18 + dexFee)) / 1e18;

        uint256 amountA = totalAmountA - amountAToSell;

        // Swap tokens
        tokenA.safeTransfer(address(exchange), amountAToSell);
        uint256 amountB = exchange.stablecoinSwap(
            amountAToSell,
            address(tokenA),
            address(tokenB),
            address(this),
            tokenAOracleData,
            tokenBOracleData
        );

        // Approve tokens to lpToken contract for deposit
        tokenA.safeApprove(address(lpToken), amountA);
        tokenB.safeApprove(address(lpToken), amountB);

        // Return amounts of tokens depending on the order of tokens in the lpToken contract
        (amount0, amount1) = tokenA == lpToken.token0() ? (amountA, amountB) : (amountB, amountA);
    }

    function _checkPriceManipulation(
        TokenPrice memory tokenAOracleData,
        TokenPrice memory tokenBOracleData
    ) internal view {
        (uint256 currentLpPrice, ) = getLpPrices();

        // Get prices
        uint256 ammPrice = (UNIFORM_PRECISION * LP_PRICE_PRECISION) / currentLpPrice;
        uint256 oraclePrice = getPairPrice(tokenAOracleData, tokenBOracleData);

        if (oraclePrice != ammPrice) {
            uint256 priceDiff = oraclePrice > ammPrice
                ? ((oraclePrice - ammPrice) * 10000) / ammPrice
                : ((ammPrice - oraclePrice) * 10000) / oraclePrice;
            if (priceDiff > PRICE_THRESHOLD) revert PriceManipulation();
        }
    }

    // Utils

    function _calculateAmountAToSellByAmountA(
        uint256 totalAmountA,
        TokenPrice memory tokenAOracleData,
        TokenPrice memory tokenBOracleData
    ) internal view returns (uint256 amountAToSell) {
        // Get reserves
        (uint256 reserve0, uint256 reserve1) = lpToken.getTotalAmounts();

        (uint256 reserveA, uint256 reserveB) = tokenA == lpToken.token0() ? (reserve0, reserve1) : (reserve1, reserve0);

        uint256 reserveTokenBRatio = (reserveB * UNIFORM_PRECISION) / reserveA;

        uint256 oraclePriceAB = getPairPrice(tokenAOracleData, tokenBOracleData);

        // calculate totalRatio depending on price and reserves
        uint256 totalBRatio = (reserveTokenBRatio * oraclePriceAB) / UNIFORM_PRECISION;

        // Convert total amount of tokenA to USD
        uint256 totalAmountInUsd = (totalAmountA * tokenAOracleData.price) / (10 ** tokenAOracleData.priceDecimals);

        uint256 desiredAmountBInUsd = (totalAmountInUsd * totalBRatio) / (totalBRatio + UNIFORM_PRECISION);

        amountAToSell = (desiredAmountBInUsd * (10 ** tokenAOracleData.priceDecimals)) / tokenAOracleData.price;
    }

    function _calculateAmountLpByTokenA(uint256 totalAmountA) internal view returns (uint256 amountLp) {
        (uint256 currentLpPrice, uint256 priceToken1PerLpToken) = getLpPrices();

        // Get amount1
        uint256 amount1 = tokenA == lpToken.token0()
            ? (totalAmountA * currentLpPrice) / LP_PRICE_PRECISION
            : totalAmountA;

        // Convert amount1 to amountLp
        amountLp = (amount1 * UNIFORM_PRECISION) / priceToken1PerLpToken;
    }

    function getPairPrice(
        TokenPrice memory tokenAOracleData,
        TokenPrice memory tokenBOracleData
    ) internal pure returns (uint256 price) {
        price =
            (tokenBOracleData.price * UNIFORM_PRECISION * (10 ** tokenAOracleData.priceDecimals)) /
            (tokenAOracleData.price * (10 ** tokenBOracleData.priceDecimals));
    }

    function getLpPrices() internal view returns (uint256 currentLpPrice, uint256 priceToken1PerLpToken) {
        // Calculate LP price using thena way in their hypervisor contract
        // check deposit method: https://bscscan.com/address/0x5EEca990E9B7489665F4B57D27D92c78BC2AfBF2#code
        uint160 sqrtPrice = TickMath.getSqrtRatioAtTick(lpToken.currentTick());
        currentLpPrice = FullMath.mulDiv(uint256(sqrtPrice) * uint256(sqrtPrice), LP_PRICE_PRECISION, 2 ** (96 * 2));

        // Calculte price of token1 per LP token
        (uint256 reserve0, uint256 reserve1) = lpToken.getTotalAmounts();
        uint256 reserve0PricedInToken1 = (reserve0 * currentLpPrice) / LP_PRICE_PRECISION;
        priceToken1PerLpToken = ((reserve0PricedInToken1 + reserve1) * UNIFORM_PRECISION) / lpToken.totalSupply();
    }

    function getOraclePrice(address tokenAddress) internal view returns (TokenPrice memory priceData) {
        (uint256 price, uint8 decimals) = oracle.getTokenUsdPrice(tokenAddress);
        priceData = TokenPrice({price: price, priceDecimals: decimals, token: tokenAddress});
        return priceData;
    }

    /// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
    function changeDecimals(uint256 amount, uint8 oldDecimals, uint8 newDecimals) private pure returns (uint256) {
        if (oldDecimals < newDecimals) {
            return amount * (10 ** (newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10 ** (oldDecimals - newDecimals));
        }
        return amount;
    }

    /// @dev Returns array of min amounts.
    /// Min amount0,1 returned for shares of liq during withdrawal
    /// Min amount0,1 spend for directDeposit when it is true during deposit
    function _getMinAmountsArray() internal pure returns (uint256[4] memory minAmounts) {
        minAmounts[0] = 0; // base minAmount0
        minAmounts[1] = 0; // base minAmount1
        minAmounts[2] = 0; // limit minAmount0
        minAmounts[3] = 0; // limit minAmount1
    }

    /* ERRORS */

    error CallerUpgrader();
    error InvalidInput();
    error NotAllAssetsWithdrawn();
    error DepositAmountExceedsBalance();
    error InvalidPriceThreshold();
    error PriceManipulation();
}
