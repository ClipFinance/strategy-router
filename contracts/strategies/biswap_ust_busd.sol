//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "../interfaces/IZapDepositer.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IBiswapFarm.sol";
// import "./interfaces/IExchangeRegistry.sol";
import "../StrategyRouter.sol";

import "hardhat/console.sol";

contract biswap_ust_busd is Ownable, IStrategy {
    IERC20 public ust = IERC20(0x23396cF899Ca06c4472205fC903bDB4de249D6fC);
    IERC20 public busd = IERC20(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56);
    IERC20 public bsw = IERC20(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1);
    IERC20 public lpToken = IERC20(0x9E78183dD68cC81bc330CAF3eF84D354a58303B5);
    IBiswapFarm public farm =
        IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 public biswapRouter =
        IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);
    StrategyRouter public strategyRouter;
    uint256 public poolId = 18;
    uint256 public max_leftover_busd = 1 * 10**ERC20(address(busd)).decimals();
    uint256 public max_leftover_ust = 1 * 10**ERC20(address(ust)).decimals();

    constructor(StrategyRouter _strategyRouter) {
        strategyRouter = _strategyRouter;
    }

    function deposit(uint256 amount)
        external
        override
        onlyOwner
    {
        console.log("block.number", block.number);

        // TODO: Is there a way to swap ust to busd so that we'll get perfect ratio to addLiquidity?
        //       If so, we could get rid of that helper function.
        fix_leftover(amount);

        // swap a bit more to reduce consequences of slippage and fees (0.06% on acryptos for ust-busd)
        uint256 busdAmount = amount * 5002 / 10000;
        Exchange exchange = strategyRouter.exchange();
        ust.transfer(address(exchange), busdAmount);
        console.log("busdAmount", busdAmount);
        busdAmount = exchange.swapRouted(busdAmount, ust, busd, address(this));
        // console.log(
        //     "ust %s busd %s",
        //     ust.balanceOf(address(this)),
        //     busd.balanceOf(address(this))
        // );

        uint256 ustAmount = ust.balanceOf(address(this));
        busdAmount = busd.balanceOf(address(this));

        ust.approve(address(biswapRouter), ustAmount);
        busd.approve(address(biswapRouter), busdAmount);
        (uint256 amountA, uint256 amountB, uint256 liquidity) = biswapRouter
            .addLiquidity(
                address(ust),
                address(busd),
                ustAmount,
                busdAmount,
                0,
                0,
                address(this),
                block.timestamp
            );

        console.log("addLiquidity leftover", ustAmount - amountA, busdAmount - amountB);
        lpToken.approve(address(farm), liquidity);
        //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));
        farm.deposit(poolId, liquidity);

        // after add_liquidity some tokens leftover, send them back to StrategyRouter
        // busd.transfer(msg.sender, busd.balanceOf(address(this)));
        //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));

        // (uint256 amount, , , ) = farm.userInfo(address(lpToken), address(this));
        //  console.log(lpAmount, amount);
    }

    function withdraw(uint256 amount)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        console.log("--- biswap withdraw");
        address token0 = IUniswapV2Pair(address(lpToken)).token0();
        address token1 = IUniswapV2Pair(address(lpToken)).token1();
        uint256 balance0 = IERC20(token0).balanceOf(address(lpToken));
        uint256 balance1 = IERC20(token1).balanceOf(address(lpToken));
        (uint112 _reserve0, uint112 _reserve1, ) = IUniswapV2Pair(
            address(lpToken)
        ).getReserves();

        uint256 amountUst = amount / 2;
        uint256 amountBusd;
        uint256 amountUstToBusd = amount - amountUst;

        (_reserve0, _reserve1) = token0 == address(ust)
            ? (_reserve0, _reserve1)
            : (_reserve1, _reserve0);

        amountBusd = biswapRouter.quote(amountUstToBusd, _reserve0, _reserve1);

        uint256 liquidity = (lpToken.totalSupply() * (amountUst + amountBusd)) /
            (balance0 + balance1);

        // console.log(
        //     "amountUst %s amountBusd %s",
        //     amountUst,
        //     amountBusd
        // );

        farm.withdraw(poolId, liquidity);
        console.log(
            "liquidity %s, lpToken.balanceOf(address(this)) %s",
            liquidity,
            lpToken.balanceOf(address(this))
        );
        lpToken.approve(address(biswapRouter), liquidity);
        (uint256 amountA, uint256 amountB) = biswapRouter.removeLiquidity(
            address(ust),
            address(busd),
            lpToken.balanceOf(address(this)),
            0,
            0,
            address(this),
            block.timestamp
        );

        Exchange exchange = strategyRouter.exchange();
        busd.transfer(address(exchange), amountB);
        console.log("amountA %s amountB %s", amountA, amountB);
        amountA += exchange.swapRouted(amountB, busd, ust, address(this));
        console.log("amountA %s amountB %s", amountA, amountB);
        ust.transfer(msg.sender, amountA);
        amountWithdrawn = amountA;
    }

    function compound()
        external
        override
        onlyOwner
    {
        farm.withdraw(poolId, 0);
        // use balance because BSW is harvested on deposit and withdraw calls
        uint256 bswAmount = bsw.balanceOf(address(this));
        console.log("bswAmount", bswAmount);

        console.log("block.number", block.number);
        if (bswAmount > 0) {
            fix_leftover(0);
            sellBSW(bswAmount);
            uint256 balanceUst = ust.balanceOf(address(this));
            uint256 balanceBusd = busd.balanceOf(address(this));

            ust.approve(address(biswapRouter), balanceUst);
            busd.approve(address(biswapRouter), balanceBusd);

            console.log(
                "receivedUst %s receivedBusd %s",
                balanceUst,
                balanceBusd
            );
            (uint256 amountA, uint256 amountB, uint256 liquidity) = biswapRouter
                .addLiquidity(
                    address(ust),
                    address(busd),
                    balanceUst,
                    balanceBusd,
                    0,
                    0,
                    address(this),
                    block.timestamp
                );

            uint256 lpAmount = lpToken.balanceOf(address(this));
            lpToken.approve(address(farm), lpAmount);
            console.log(
                "liquidity %s amountA %s amountB %s",
                liquidity,
                amountA,
                amountB
            );
            farm.deposit(poolId, lpAmount);
            console.log(
                "biswap farm compound leftover ust %s busd %s, max_leftover_busd %s",
                ust.balanceOf(address(this)),
                busd.balanceOf(address(this)),
                max_leftover_busd
            );
        }
    }

    /// @dev Swaps half of ust to busd once leftover amounts reach predefined limit.
    ///      Half of busd is also swapped if it reaches limit.
    function fix_leftover(uint256 amoungIgnore) public {
        Exchange exchange = strategyRouter.exchange();
        uint256 busdAmount = busd.balanceOf(address(this));
        uint256 ustAmount = ust.balanceOf(address(this)) - amoungIgnore;
        if (busdAmount > max_leftover_busd) {
            console.log("fix_leftover busd %s", busdAmount);
            busd.transfer(address(exchange), busdAmount);
            exchange.swapRouted(busdAmount / 2, busd, ust, address(this));
        }
        if (ustAmount > max_leftover_ust) {
            console.log("fix_leftover ust %s", ustAmount);
            ust.transfer(address(exchange), ustAmount);
            exchange.swapRouted(ustAmount / 2, ust, busd, address(this));
        }
    }

    function totalTokens() external view override returns (uint256) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));


        uint256 _totalSupply = lpToken.totalSupply();
        // this formula is from remove_liquidity -> burn of uniswapV2pair
        uint256 amountUst = (liquidity * ust.balanceOf(address(lpToken))) /
            _totalSupply;
        uint256 amountBusd = (liquidity * busd.balanceOf(address(lpToken))) /
            _totalSupply;

        if (amountBusd > 0) {

            address token0 = IUniswapV2Pair(address(lpToken)).token0();

            (uint112 _reserve0, uint112 _reserve1, ) = IUniswapV2Pair(
                address(lpToken)
            ).getReserves();

            (_reserve0, _reserve1) = token0 == address(busd)
                ? (_reserve0, _reserve1)
                : (_reserve1, _reserve0);

            // convert amountBusd to amount of ust
            amountUst += biswapRouter.quote(amountBusd, _reserve0, _reserve1);
        }

        return amountUst;
    }

    // swap bsw for ust & busd in proportions 50/50
    function sellBSW(uint256 amountA)
        public
        returns (uint256 receivedUst, uint256 receivedBusd)
    {
        bsw.approve(address(biswapRouter), amountA);

        uint256 ustPart = amountA / 2;
        uint256 busdPart = amountA - ustPart;

        Exchange exchange = strategyRouter.exchange();
        bsw.transfer(address(exchange), ustPart);
        receivedUst = exchange.swapRouted(ustPart, bsw, ust, address(this));

        bsw.transfer(address(exchange), busdPart);
        receivedBusd = exchange.swapRouted(busdPart, bsw, busd, address(this));
    }

    function withdrawAll()
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        console.log("--- withdrawAll call");

        (uint256 amount, ) = farm.userInfo(poolId, address(this));
        console.log("withdraw amount LPs %s", amount);
        if(amount > 0) {
            farm.withdraw(poolId, amount);
            uint256 lpAmount = lpToken.balanceOf(address(this));
            lpToken.approve(address(biswapRouter), lpAmount);
            (uint256 amountA, uint256 amountB) = biswapRouter.removeLiquidity(
                address(ust),
                address(busd),
                lpToken.balanceOf(address(this)),
                0,
                0,
                address(this),
                block.timestamp
            );
        }

        uint256 amountUst = ust.balanceOf(address(this));
        uint256 amountBusd = busd.balanceOf(address(this));

        console.log("ust balance %s busd %s", amountUst, amountBusd);
        if(amountBusd > 0) {
            Exchange exchange = strategyRouter.exchange();
            busd.transfer(address(exchange), amountBusd);
            amountUst += exchange.swapRouted(amountBusd, busd, ust, address(this));
        }
        // console.log("amountA %s amountB %s", amountA, amountB);
        if(amountUst > 0) {
            ust.transfer(msg.sender, amountUst);
            amountWithdrawn = amountUst;
        }
    }
}
