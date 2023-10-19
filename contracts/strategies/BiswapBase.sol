//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "../deps/UUPSUpgradeable.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IUsdOracle.sol";
import "../interfaces/IBiswapFarm.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IExchange.sol";
import "./AbstractBaseStrategyWithHardcap.sol";

import {TokenPrice} from "../lib/Structs.sol";

// Base contract to be inherited, works with biswap MasterChef:
// address on BNB Chain: 0xDbc1A13490deeF9c3C12b44FE77b503c1B061739
// their code on github: https://github.com/biswap-org/staking/blob/main/contracts/MasterChef.sol

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract BiswapBase is Initializable, UUPSUpgradeable, OwnableUpgradeable, IStrategy, AbstractBaseStrategyWithHardcap {
    using SafeERC20 for IERC20Metadata;

    address internal upgrader;

    IStrategyRouter public immutable strategyRouter;
    IUsdOracle public immutable oracle;
    IERC20Metadata public immutable tokenA;
    IERC20Metadata public immutable tokenB;
    IUniswapV2Pair public immutable lpToken;

    IERC20Metadata internal constant bsw = IERC20Metadata(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1);
    IBiswapFarm internal constant farm = IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 internal constant biswapRouter = IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);

    uint256 public immutable poolId;

    uint256 private immutable LEFTOVER_THRESHOLD_TOKEN_A;
    uint256 private immutable LEFTOVER_THRESHOLD_TOKEN_B;
    uint256 private immutable PRICE_THRESHOLD;
    uint256 private constant PERCENT_DENOMINATOR = 10000;

    uint256 private constant UNIFORM_PRECISION = 1e18;
    uint8 private constant UNIFORM_DECIMALS = 18;

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        IStrategyRouter _strategyRouter,
        uint256 _poolId,
        IERC20Metadata _tokenA,
        IERC20Metadata _tokenB,
        IUniswapV2Pair _lpToken,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    ) {
        strategyRouter = _strategyRouter;
        poolId = _poolId;
        tokenA = _tokenA;
        tokenB = _tokenB;
        lpToken = _lpToken;
        LEFTOVER_THRESHOLD_TOKEN_A = 10 ** _tokenA.decimals();
        LEFTOVER_THRESHOLD_TOKEN_B = 10 ** _tokenB.decimals();
        oracle = _oracle;
        if (_priceManipulationPercentThresholdInBps > PERCENT_DENOMINATOR) revert InvalidPriceThreshold();
        PRICE_THRESHOLD = _priceManipulationPercentThresholdInBps;

        // lock implementation
        _disableInitializers();
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

    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    function depositToken() external view override returns (address) {
        return address(tokenA);
    }

    function rewardToken() external pure override returns (address) {
        return address(bsw);
    }

    function getPendingReward() external view override returns (uint256) {
        return farm.pendingBSW(poolId, address(this));
    }

    function _deposit(uint256 amount) internal override {
        if (amount == 0) return;
        if (amount > tokenA.balanceOf(address(this))) revert DepositAmountExceedsBalance();
        IExchange exchange = strategyRouter.getExchange();

        TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
        TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));

        uint256 dexFee = exchange.getExchangeProtocolFee(amount / 2, address(tokenA), address(tokenB));
        (uint256 amountA, uint256 amountAToSell) = calculateSwapAmount(
            amount,
            dexFee,
            tokenAOracleData,
            tokenBOracleData
        );

        _checkPriceManipulation(tokenAOracleData, tokenBOracleData);

        tokenA.transfer(address(exchange), amountAToSell);

        uint256 amountB = exchange.stablecoinSwap(
            amountAToSell,
            address(tokenA),
            address(tokenB),
            address(this),
            tokenAOracleData,
            tokenBOracleData
        );

        tokenA.approve(address(biswapRouter), amountA);
        tokenB.approve(address(biswapRouter), amountB);

        (, , uint256 liquidity) = biswapRouter.addLiquidity(
            address(tokenA),
            address(tokenB),
            amountA,
            amountB,
            0,
            0,
            address(this),
            block.timestamp
        );

        lpToken.approve(address(farm), liquidity);
        farm.deposit(poolId, liquidity);
    }

    function withdraw(
        uint256 strategyTokenAmountToWithdraw
    ) external override onlyOwner returns (uint256 amountWithdrawn) {
        uint256 tokenABalance = tokenA.balanceOf(address(this));

        if (strategyTokenAmountToWithdraw > tokenABalance) {
            TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
            TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));

            _checkPriceManipulation(tokenAOracleData, tokenBOracleData);

            // calculate liquidity to remove
            uint256 amountA = (strategyTokenAmountToWithdraw - tokenABalance) / 2;
            uint256 amountB = (tokenAOracleData.price * amountA * (10 ** tokenBOracleData.priceDecimals)) /
                (tokenBOracleData.price * (10 ** tokenAOracleData.priceDecimals));

            uint256 lpTotalSupply = lpToken.totalSupply() / 2;
            uint256 lpBalanceA = tokenA.balanceOf(address(lpToken));
            uint256 lpBalanceB = tokenB.balanceOf(address(lpToken));

            uint256 liquidityToRemove = (lpTotalSupply * amountA) / lpBalanceA;
            liquidityToRemove += (lpTotalSupply * amountB) / lpBalanceB;

            // check liquidity
            (uint256 totalLiquidity, ) = farm.userInfo(poolId, address(this));

            if (liquidityToRemove > totalLiquidity) {
                liquidityToRemove = totalLiquidity;
            }

            farm.withdraw(poolId, liquidityToRemove);
            lpToken.approve(address(biswapRouter), liquidityToRemove);
            (, amountB) = biswapRouter.removeLiquidity(
                address(tokenA),
                address(tokenB),
                liquidityToRemove,
                0,
                0,
                address(this),
                block.timestamp
            );

            IExchange exchange = strategyRouter.getExchange();
            tokenB.transfer(address(exchange), amountB);
            exchange.stablecoinSwap(
                amountB,
                address(tokenB),
                address(tokenA),
                address(this),
                tokenBOracleData,
                tokenAOracleData
            );

            tokenABalance = tokenA.balanceOf(address(this));

            if (strategyTokenAmountToWithdraw > tokenABalance) {
                strategyTokenAmountToWithdraw = tokenABalance;
            }
        }

        tokenA.transfer(msg.sender, strategyTokenAmountToWithdraw);

        _compoundBsw();

        return strategyTokenAmountToWithdraw;
    }

    function compound() external override onlyOwner {
        // inside withdraw happens BSW rewards collection
        farm.withdraw(poolId, 0);
        // use balance because BSW is harvested on deposit and withdraw calls
        _compoundBsw();
    }

    function totalTokens() public view override returns (uint256) {
        return _totalTokens();
    }

    function _totalTokens() internal view override returns (uint256 totalDepositTokens) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));
        uint256 lpTotalSupply = lpToken.totalSupply();
        // this formula is from uniswap.remove_liquidity -> uniswapPair.burn function
        uint256 lpBalanceA = tokenA.balanceOf(address(lpToken));
        uint256 lpBalanceB = tokenB.balanceOf(address(lpToken));
        uint256 amountA = (liquidity * lpBalanceA) / lpTotalSupply + tokenA.balanceOf(address(this));
        uint256 amountB = (liquidity * lpBalanceB) / lpTotalSupply + tokenB.balanceOf(address(this));

        if (amountB > 0) {
            // convert amountB to amount tokenA
            TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
            TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));

            amountA +=
                (tokenBOracleData.price * amountB * (10 ** tokenAOracleData.priceDecimals)) /
                (tokenAOracleData.price * (10 ** tokenBOracleData.priceDecimals));
        }
        return amountA;
    }

    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));
        if (liquidity != 0) {
            farm.withdraw(poolId, liquidity);
            uint256 bswAmount = bsw.balanceOf(address(this));

            if (bswAmount != 0) sellRewardToTokenA(bswAmount);

            uint256 lpAmount = lpToken.balanceOf(address(this));
            lpToken.approve(address(biswapRouter), lpAmount);
            biswapRouter.removeLiquidity(
                address(tokenA),
                address(tokenB),
                lpToken.balanceOf(address(this)),
                0,
                0,
                address(this),
                block.timestamp
            );
        }
        uint256 amountA = tokenA.balanceOf(address(this));
        uint256 amountB = tokenB.balanceOf(address(this));
        if (amountB > 0) {
            IExchange exchange = strategyRouter.getExchange();
            tokenB.transfer(address(exchange), amountB);
            amountA += exchange.stablecoinSwap(
                amountB,
                address(tokenB),
                address(tokenA),
                address(this),
                getOraclePrice(address(tokenB)),
                getOraclePrice(address(tokenA))
            );
        }
        if (amountA > 0) {
            tokenA.transfer(msg.sender, amountA);
            return amountA;
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
        (uint256 reserve0, uint256 reserve1, ) = lpToken.getReserves();
        (uint256 reserveA, uint256 reserveB) = address(tokenA) == lpToken.token0()
            ? (reserve0, reserve1)
            : (reserve1, reserve0);

        uint256 reserveTokenBRatio = (reserveB * UNIFORM_PRECISION) / reserveA;
        uint256 oraclePriceAB = getOraclePriceAB(tokenAOracleData, tokenBOracleData);

        // Calculate totalRatio depending on price and reserves
        uint256 totalBRatio = (reserveTokenBRatio * oraclePriceAB) / UNIFORM_PRECISION;

        // Calculate desired amount of tokenA and tokenB in USD
        uint256 desiredAmountBInUsd = (totalAmountInUsd * totalBRatio) / (totalBRatio + UNIFORM_PRECISION);
        uint256 desiredAmountAInUsd = totalAmountInUsd - desiredAmountBInUsd;

        // Check leftover and calculate which and how amount need to swap
        uint256 toSwap;
        IExchange exchange = strategyRouter.getExchange();

        if (desiredAmountAInUsd > currentAmountAInUsd) {
            // Swap tokenB to tokenA
            toSwap =
                ((desiredAmountAInUsd - currentAmountAInUsd) * (10 ** tokenBOracleData.priceDecimals)) /
                tokenBOracleData.price;
            if (toSwap < LEFTOVER_THRESHOLD_TOKEN_B) return;

            _checkPriceManipulation(tokenAOracleData, tokenBOracleData);

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
            // Swap tokenA to tokenB
            toSwap =
                ((desiredAmountBInUsd - currentAmountBInUsd) * (10 ** tokenAOracleData.priceDecimals)) /
                tokenAOracleData.price;
            if (toSwap < LEFTOVER_THRESHOLD_TOKEN_B) return;

            _checkPriceManipulation(tokenAOracleData, tokenBOracleData);

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

    // swap bsw for tokenA & tokenB in proportions 50/50
    function sellReward(uint256 bswAmount) private returns (uint256 receivedA, uint256 receivedB) {
        // sell for lp ratio
        uint256 amountA = bswAmount / 2;
        uint256 amountB = bswAmount - amountA;

        IExchange exchange = strategyRouter.getExchange();
        bsw.transfer(address(exchange), amountA);
        receivedA = exchange.protectedSwap(
            amountA,
            address(bsw),
            address(tokenA),
            address(this),
            getOraclePrice(address(bsw)),
            getOraclePrice(address(tokenA))
        );

        bsw.transfer(address(exchange), amountB);
        receivedB = exchange.protectedSwap(
            amountB,
            address(bsw),
            address(tokenB),
            address(this),
            getOraclePrice(address(bsw)),
            getOraclePrice(address(tokenB))
        );
    }

    function sellRewardToTokenA(uint256 bswAmount) private returns (uint256 receivedA) {
        IExchange exchange = strategyRouter.getExchange();
        bsw.transfer(address(exchange), bswAmount);
        receivedA = exchange.protectedSwap(
            bswAmount,
            address(bsw),
            address(tokenA),
            address(this),
            getOraclePrice(address(bsw)),
            getOraclePrice(address(tokenA))
        );
    }

    function calculateSwapAmount(
        uint256 tokenAmount,
        uint256 dexFee,
        TokenPrice memory tokenAOracleData,
        TokenPrice memory tokenBOracleData
    ) internal view returns (uint256 amountA, uint256 amountAToSell) {
        // Get reserves
        (uint256 reserve0, uint256 reserve1, ) = lpToken.getReserves();
        (uint256 reserveA, uint256 reserveB) = address(tokenA) == lpToken.token0()
            ? (reserve0, reserve1)
            : (reserve1, reserve0);

        uint256 oraclePriceAB = getOraclePriceAB(tokenAOracleData, tokenBOracleData);

        amountAToSell =
            (tokenAmount * reserveB * UNIFORM_PRECISION) /
            ((oraclePriceAB * reserveA * (UNIFORM_PRECISION - dexFee)) /
                UNIFORM_PRECISION +
                reserveB *
                UNIFORM_PRECISION);
        amountA = tokenAmount - amountAToSell;
    }

    // Return uniform (decimal is 18) price tokenA/tokenB
    function getOraclePriceAB(
        TokenPrice memory tokenAUsdPrice,
        TokenPrice memory tokenBUsdPrice
    ) internal pure returns (uint256 price) {
        price =
            (tokenAUsdPrice.price * UNIFORM_PRECISION * (10 ** tokenBUsdPrice.priceDecimals)) /
            (tokenBUsdPrice.price * (10 ** tokenAUsdPrice.priceDecimals));
    }

    function getOraclePrice(address tokenAddress) internal view returns (TokenPrice memory priceData) {
        (uint256 price, uint8 decimals) = oracle.getTokenUsdPrice(tokenAddress);
        priceData = TokenPrice({price: price, priceDecimals: decimals, token: tokenAddress});
        return priceData;
    }

    function _compoundBsw() internal {
        uint256 bswAmount = bsw.balanceOf(address(this));

        if (bswAmount != 0) {
            sellReward(bswAmount);

            fix_leftover(0);
            uint256 balanceA = tokenA.balanceOf(address(this));
            uint256 balanceB = tokenB.balanceOf(address(this));

            tokenA.approve(address(biswapRouter), balanceA);
            tokenB.approve(address(biswapRouter), balanceB);

            biswapRouter.addLiquidity(
                address(tokenA),
                address(tokenB),
                balanceA,
                balanceB,
                0,
                0,
                address(this),
                block.timestamp
            );

            uint256 lpAmount = lpToken.balanceOf(address(this));
            lpToken.approve(address(farm), lpAmount);
            farm.deposit(poolId, lpAmount);
        }
    }

    function _checkPriceManipulation(TokenPrice memory oracleDataA, TokenPrice memory oracleDataB) internal view {
        // Simulate selling tokenA
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        // Get the decimals of tokenB and one tokenA for calculate prices
        uint8 tokenBDecimals = tokenB.decimals();
        uint256 oneTokenA = 10 ** tokenA.decimals();

        // Get prices
        uint256[] memory ammPrice = biswapRouter.getAmountsOut(oneTokenA, path);
        uint256 oraclePrice = (oracleDataA.price * oneTokenA * (10 ** oracleDataB.priceDecimals)) /
            (oracleDataB.price * (10 ** oracleDataA.priceDecimals));

        // Convert AMM price and oracle price to uniform
        uint256 adjustedAmmPrice = changeDecimals(ammPrice[1], tokenBDecimals, 18);
        uint256 adjustedOraclePrice = changeDecimals(oraclePrice, tokenBDecimals, 18);

        if (adjustedOraclePrice != adjustedAmmPrice) {
            uint256 priceDiff = adjustedOraclePrice > adjustedAmmPrice
                ? ((adjustedOraclePrice - adjustedAmmPrice) * 10000) / adjustedAmmPrice
                : ((adjustedAmmPrice - adjustedOraclePrice) * 10000) / adjustedOraclePrice;
            if (priceDiff > PRICE_THRESHOLD) revert PriceManipulation();
        }
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

    /* ERRORS */

    error CallerUpgrader();
    error InvalidPriceThreshold();
    error PriceManipulation();
    error DepositAmountExceedsBalance();
}
