//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IUsdOracle.sol";
import "../interfaces/IBiswapFarm.sol";
import "../StrategyRouter.sol";

import "hardhat/console.sol";

// Base contract to be inherited, works with biswap MasterChef:
// address on BNB Chain: 0xDbc1A13490deeF9c3C12b44FE77b503c1B061739
// their code on github: https://github.com/biswap-org/staking/blob/main/contracts/MasterChef.sol

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract BiswapBase is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    IStrategy
{
    error CallerUpgrader();
    error PriceManipulation();
    error ZeroAmount();

    address public upgrader;

    ERC20 public immutable tokenA;
    ERC20 public immutable tokenB;
    ERC20 public immutable lpToken;
    StrategyRouter public immutable strategyRouter;
    IUsdOracle public immutable oracle;

    ERC20 internal constant bsw =
        ERC20(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1);
    IBiswapFarm internal constant farm =
        IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 internal constant biswapRouter =
        IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);

    uint256 public immutable poolId;

    uint256 private immutable LEFTOVER_THRESHOLD_TOKEN_A;
    uint256 private immutable LEFTOVER_THRESHOLD_TOKEN_B;
    uint256 private constant PERCENT_DENOMINATOR = 10000;
    uint256 private constant ETHER = 1e18;
    uint256 private constant PRICE_DELTA = 1e17; // allow until 10%

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        StrategyRouter _strategyRouter,
        uint256 _poolId,
        ERC20 _tokenA,
        ERC20 _tokenB,
        ERC20 _lpToken,
        IUsdOracle _oracle
    ) {
        strategyRouter = _strategyRouter;
        poolId = _poolId;
        tokenA = _tokenA;
        tokenB = _tokenB;
        lpToken = _lpToken;
        LEFTOVER_THRESHOLD_TOKEN_A = 10**_tokenA.decimals();
        LEFTOVER_THRESHOLD_TOKEN_B = 10**_tokenB.decimals();
        oracle = _oracle;

        // lock implementation
        _disableInitializers();
    }

    function initialize(address _upgrader) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        upgrader = _upgrader;
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyUpgrader
    {}

    function depositToken() external view override returns (address) {
        return address(tokenA);
    }

    function deposit(uint256 amount) external override onlyOwner {
        Exchange exchange = strategyRouter.getExchange();

        uint256 dexFee = exchange.getExchangeProtocolFee(
            amount / 2,
            address(tokenA),
            address(tokenB)
        );
        (uint256 amountA, uint256 amountB) = calculateSwapAmount(
            amount,
            dexFee
        );

        tokenA.transfer(address(exchange), amountB);
        amountB = exchange.swap(
            amountB,
            address(tokenA),
            address(tokenB),
            address(this)
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

        if (liquidity == 0) revert ZeroAmount();

        lpToken.approve(address(farm), liquidity);
        farm.deposit(poolId, liquidity);
    }

    function withdraw(uint256 strategyTokenAmountToWithdraw)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        uint256 tokenABalance = tokenA.balanceOf(address(this));
        if (strategyTokenAmountToWithdraw <= tokenABalance) {
            tokenA.transfer(msg.sender, strategyTokenAmountToWithdraw);
            return strategyTokenAmountToWithdraw;
        } else {
            strategyTokenAmountToWithdraw -= tokenABalance;

            address token0 = IUniswapV2Pair(address(lpToken)).token0();
            address token1 = IUniswapV2Pair(address(lpToken)).token1();
            uint256 balance0 = IERC20(token0).balanceOf(address(lpToken));
            uint256 balance1 = IERC20(token1).balanceOf(address(lpToken));

            uint256 amountA = strategyTokenAmountToWithdraw / 2;
            uint256 amountB = strategyTokenAmountToWithdraw - amountA;

            (balance0, balance1) = token0 == address(tokenA)
                ? (balance0, balance1)
                : (balance1, balance0);

            amountB = biswapRouter.quote(amountB, balance0, balance1);

            uint256 liquidityToRemove = (lpToken.totalSupply() *
                (amountA + amountB)) / (balance0 + balance1);

            farm.withdraw(poolId, liquidityToRemove);
            uint256 bswAmount = bsw.balanceOf(address(this));
            if (bswAmount != 0) {
                sellRewardToTokenA(bswAmount);
                _compoundBsw();
            }

            lpToken.approve(address(biswapRouter), liquidityToRemove);
            (amountA, amountB) = biswapRouter.removeLiquidity(
                address(tokenA),
                address(tokenB),
                lpToken.balanceOf(address(this)),
                0,
                0,
                address(this),
                block.timestamp
            );

            Exchange exchange = strategyRouter.getExchange();
            tokenB.transfer(address(exchange), amountB);
            amountA +=
                exchange.swap(
                    amountB,
                    address(tokenB),
                    address(tokenA),
                    address(this)
                ) +
                tokenABalance;
            tokenA.transfer(msg.sender, amountA);
            return amountA;
        }
    }

    function compound() external override onlyOwner {
        // inside withdraw happens BSW rewards collection
        farm.withdraw(poolId, 0);
        // use balance because BSW is harvested on deposit and withdraw calls
        _compoundBsw();
    }

    function totalTokens() external view override returns (uint256) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));

        uint256 _totalSupply = lpToken.totalSupply();
        // this formula is from uniswap.remove_liquidity -> uniswapPair.burn function
        uint256 balanceA = tokenA.balanceOf(address(lpToken));
        uint256 balanceB = tokenB.balanceOf(address(lpToken));
        uint256 amountA = (liquidity * balanceA) /
            _totalSupply +
            tokenA.balanceOf(address(this));
        uint256 amountB = (liquidity * balanceB) /
            _totalSupply +
            tokenB.balanceOf(address(this));

        if (amountB > 0) {
            address token0 = IUniswapV2Pair(address(lpToken)).token0();

            (uint256 _reserve0, uint256 _reserve1) = token0 == address(tokenB)
                ? (balanceB, balanceA)
                : (balanceA, balanceB);

            // convert amountB to amount tokenA
            amountA += biswapRouter.quote(amountB, _reserve0, _reserve1);
        }

        return amountA;
    }

    function withdrawAll()
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
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
            Exchange exchange = strategyRouter.getExchange();
            tokenB.transfer(address(exchange), amountB);
            amountA += exchange.swap(
                amountB,
                address(tokenB),
                address(tokenA),
                address(this)
            );
        }
        if (amountA > 0) {
            tokenA.transfer(msg.sender, amountA);
            return amountA;
        }
    }

    /// @dev Swaps leftover tokens for a better ratio for LP.
    function fix_leftover(uint256 amountIgnore) private {
        Exchange exchange = strategyRouter.getExchange();
        uint256 amountB = tokenB.balanceOf(address(this));
        uint256 amountA = tokenA.balanceOf(address(this)) - amountIgnore;
        uint256 toSwap;
        if (
            amountB > amountA &&
            (toSwap = amountB - amountA) > LEFTOVER_THRESHOLD_TOKEN_B
        ) {
            uint256 dexFee = exchange.getExchangeProtocolFee(
                toSwap / 2,
                address(tokenA),
                address(tokenB)
            );
            // TODO: looks wrong
            (toSwap, ) = calculateSwapAmount(toSwap, dexFee);
            tokenB.transfer(address(exchange), toSwap);
            exchange.swap(
                toSwap,
                address(tokenB),
                address(tokenA),
                address(this)
            );
        } else if (
            amountA > amountB &&
            (toSwap = amountA - amountB) > LEFTOVER_THRESHOLD_TOKEN_A
        ) {
            uint256 dexFee = exchange.getExchangeProtocolFee(
                toSwap / 2,
                address(tokenA),
                address(tokenB)
            );
            (toSwap, ) = calculateSwapAmount(toSwap, dexFee);
            tokenA.transfer(address(exchange), toSwap);
            exchange.swap(
                toSwap,
                address(tokenA),
                address(tokenB),
                address(this)
            );
        }
    }

    // swap bsw for tokenA & tokenB in proportions 50/50
    function sellReward(uint256 bswAmount)
        private
        returns (uint256 receivedA, uint256 receivedB)
    {
        // sell for lp ratio
        uint256 amountA = bswAmount / 2;
        uint256 amountB = bswAmount - amountA;

        Exchange exchange = strategyRouter.getExchange();
        bsw.transfer(address(exchange), amountA);
        receivedA = exchange.swap(
            amountA,
            address(bsw),
            address(tokenA),
            address(this)
        );

        bsw.transfer(address(exchange), amountB);

        receivedB = exchange.swap(
            amountB,
            address(bsw),
            address(tokenB),
            address(this)
        );
    }

    function sellRewardToTokenA(uint256 bswAmount)
        private
        returns (uint256 receivedA)
    {
        Exchange exchange = strategyRouter.getExchange();
        bsw.transfer(address(exchange), bswAmount);
        receivedA = exchange.swap(
            bswAmount,
            address(bsw),
            address(tokenA),
            address(this)
        );
    }

    function calculateSwapAmount(uint256 tokenAmount, uint256 dexFee)
        internal
        view
        returns (uint256 amountA, uint256 amountB)
    {
        (uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(
            address(lpToken)
        ).getReserves();
        address token0 = IUniswapV2Pair(address(lpToken)).token0();
        uint256 oraclePrice = getOraclePrice(address(tokenB), address(tokenA));
        uint256 ammPrice;
        (reserve0, reserve1,  ammPrice) = address(tokenA) == token0
            ? (
                reserve0,
                reserve1,
                (reserve1 * 1e18) / reserve0
            )
            : (
                reserve1,
                reserve0,
                (reserve0 * 1e18) / reserve1
            );

        _checkPriceManipulation(oraclePrice, ammPrice);
        uint256 amountAToSell = (tokenAmount * reserve1 * 1e18) /
            ((oraclePrice * reserve0 * (1e18 - dexFee)) /
                1e18 +
                reserve1 *
                1e18);
        amountB = (amountAToSell * oraclePrice * (1e18 - dexFee)) / 1e36;
        amountA = tokenAmount - amountAToSell;
    }

    function _checkPriceManipulation(uint oraclePrice, uint ammPrice) internal virtual view {
        if (oraclePrice != ammPrice) {
            uint256 priceDiff = oraclePrice > ammPrice
                ? (oraclePrice - ammPrice) * 1e18 / ammPrice
                : (ammPrice - oraclePrice) * 1e18 / oraclePrice;
            if (priceDiff > PRICE_DELTA) revert PriceManipulation();
        }
    }

    // Return Price of token0 in token1 with 18 decimals
    function getOraclePrice(address token0, address token1)
        public
        view
        returns (uint256 price)
    {
        (uint256 price0, uint8 price0Decimals) = oracle.getTokenUsdPrice(
            token0
        );
        (uint256 price1, uint8 price1Decimals) = oracle.getTokenUsdPrice(
            token1
        );
        price =
            (price1 * 1e18 * (10**price0Decimals)) /
            (price0 * (10**price1Decimals));
    }

    function _compoundBsw() internal {
        uint256 bswAmount = bsw.balanceOf(address(this));

        if (bswAmount != 0) {
            fix_leftover(0);
            sellReward(bswAmount);
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
}
