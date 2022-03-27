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

    constructor(StrategyRouter _strategyRouter) {
        strategyRouter = _strategyRouter;
    }

    function deposit(uint256 amount) external override onlyOwner {
        console.log("block.number", block.number);
        ust.transferFrom(msg.sender, address(this), amount);

        // ust balance in case there is dust left from previous deposits
        uint256 ustAmount = amount / 2;
        // this is ust amount to be swapped to busd
        uint256 busdAmount = amount - ustAmount;

        Exchange exchange = strategyRouter.exchange();
        ust.transfer(address(exchange), busdAmount);
        busdAmount = exchange.swapRouted(
            busdAmount,
            ust,
            busd,
            address(this)
        );
        console.log(
            "ust %s busd %s",
            ust.balanceOf(address(this)),
            busd.balanceOf(address(this))
        );

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

        lpToken.approve(address(farm), liquidity);
        //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));
        farm.deposit(poolId, liquidity);
        ust.transfer(msg.sender, ust.balanceOf(address(this)));
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
        uint256 amountUst = amount / 2;
        uint256 amountBusd;
        uint256 amountUstToBusd = amount - amountUst;

        address token0 = IUniswapV2Pair(address(lpToken)).token0();
        address token1 = IUniswapV2Pair(address(lpToken)).token1();
        uint256 balance0 = IERC20(token0).balanceOf(address(lpToken));
        uint256 balance1 = IERC20(token1).balanceOf(address(lpToken));
        (uint112 _reserve0, uint112 _reserve1, ) = IUniswapV2Pair(
            address(lpToken)
        ).getReserves();

        if (token0 == address(ust)) {
            amountBusd = biswapRouter.quote(
                amountUstToBusd,
                _reserve0,
                _reserve1
            );
        } else {
            amountBusd = biswapRouter.quote(
                amountUstToBusd,
                _reserve1,
                _reserve0
            );
        }

        uint256 liquidity = (lpToken.totalSupply() * (amountUst + amountBusd)) /
            (balance0 + balance1);

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
        amountA += exchange.swapRouted(amountB, busd, ust, address(this));
        ust.transfer(msg.sender, amountA);
    }

    function compound() external override onlyOwner {
        farm.withdraw(poolId, 0);
        uint256 bswAmount = bsw.balanceOf(address(this));
        console.log("bswAmount", bswAmount);

        console.log("block.number", block.number);
        if (bswAmount > 0) {
            (uint256 receivedUst, uint256 receivedBusd) = sellBSW(bswAmount);
            ust.approve(address(biswapRouter), receivedUst);
            busd.approve(address(biswapRouter), receivedBusd);

            console.log(
                "receivedUst %s receivedBusd %s",
                receivedUst,
                receivedBusd
            );
            (uint256 amountA, uint256 amountB, uint256 liquidity) = biswapRouter
                .addLiquidity(
                    address(ust),
                    address(busd),
                    receivedUst,
                    receivedBusd,
                    0,
                    0,
                    address(this),
                    block.timestamp
                );

            uint256 lpAmount = lpToken.balanceOf(address(this));
            lpToken.approve(address(farm), lpAmount);
            console.log(
                "liquidity %s receivedUst %s receivedBusd %s",
                liquidity,
                receivedUst,
                receivedBusd
            );
            farm.deposit(poolId, lpAmount);
            console.log(
                "ust balance %s busd balance %s",
                ust.balanceOf(address(this)),
                busd.balanceOf(address(this))
            );
            ust.transfer(msg.sender, ust.balanceOf(address(this)));
            busd.transfer(msg.sender, busd.balanceOf(address(this)));
        }
    }

    function totalTokens() external view override returns (uint256) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));

        uint256 amountUst = (liquidity * ust.balanceOf(address(lpToken))) /
            lpToken.totalSupply();
        uint256 amountBusd = (liquidity * busd.balanceOf(address(lpToken))) /
            lpToken.totalSupply();

        address[] memory path = new address[](2);
        path[0] = address(busd);
        path[1] = address(ust);
        amountUst += biswapRouter.getAmountsOut(amountBusd, path)[
            path.length - 1
        ];

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

    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        z = x < y ? x : y;
    }
}
