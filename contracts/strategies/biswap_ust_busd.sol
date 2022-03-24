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
// import "./StrategyRouter.sol";

import "hardhat/console.sol";

contract biswap_ust_busd is Ownable, IStrategy {
    IERC20 public ust = IERC20(0x23396cF899Ca06c4472205fC903bDB4de249D6fC);
    IERC20 public busd = IERC20(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56);
    IERC20 public bsw = IERC20(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1);
    IERC20 public lpToken = IERC20(0x9E78183dD68cC81bc330CAF3eF84D354a58303B5);
    IBiswapFarm public farm =
        IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 public router =
        IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);
    uint256 public poolId = 18;

    constructor() {}

    function deposit(uint256 amount) external override onlyOwner {
        console.log("block.number", block.number);
        ust.transferFrom(msg.sender, address(this), amount);

        // ust balance in case there is dust left from previous deposits
        uint256 ustAmount = amount / 2;
        uint256 busdAmount = amount - ustAmount;
        busdAmount = swapExactTokensForTokens(busdAmount, ust, busd);

        ust.approve(address(router), ustAmount);
        busd.approve(address(router), busdAmount);
        (uint256 amountA, uint256 amountB, uint256 liquidity) = router
            .addLiquidity(
                address(ust),
                address(busd),
                ustAmount,
                busdAmount,
                0,
                0,
                address(this),
                block.timestamp + 1200
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
        uint256 amountBusd = amount - amountUst;
        address[] memory path = new address[](2);
        path[0] = address(ust);
        path[1] = address(busd);
        amountBusd = router.getAmountsOut(amountBusd, path)[path.length - 1];

        // copied code from pair's mint function
        (uint112 _reserve0, uint112 _reserve1, ) = IUniswapV2Pair(
            address(lpToken)
        ).getReserves();
        address token0 = IUniswapV2Pair(address(lpToken)).token0();
        address token1 = IUniswapV2Pair(address(lpToken)).token1();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        if (token0 == address(ust)) {
            balance0 += amountUst;
            balance1 += amountBusd;
        } else {
            balance0 += amountBusd;
            balance1 += amountUst;
        }
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        uint256 _totalSupply = lpToken.totalSupply();
        uint256 liquidity = min(
            (amount0 * _totalSupply) / _reserve0,
            (amount1 * _totalSupply) / _reserve1
        );
        // end copied code from pair's mint function

        farm.withdraw(poolId, liquidity);
        (uint256 amountA, uint256 amountB) = router.removeLiquidity(
            address(ust),
            address(busd),
            lpToken.balanceOf(address(this)),
            0,
            0,
            address(this),
            block.timestamp + 1200
        );

        ust.transfer(msg.sender, amountA);
        busd.transfer(msg.sender, amountB);
    }

    function compound() external override onlyOwner {
        //     farm.harvest(address(lpToken));
        //     uint256 acsiAmount = acsi.balanceOf(address(this));
        //     console.log("acsiAmount", acsiAmount);
        //     console.log("block.number", block.number);
        //     if (acsiAmount > 0) {
        //         uint256 amount = swapExactTokensForTokens(acsiAmount, acsi, ust);
        //         ust.approve(address(zapDepositer), amount);
        //         uint256[5] memory amounts;
        //         amounts[0] = amount;
        //         zapDepositer.add_liquidity(amounts, 0);
        //         uint256 lpAmount = lpToken.balanceOf(address(this));
        //         lpToken.approve(address(farm), lpAmount);
        //         //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));
        //         farm.deposit(address(lpToken), lpAmount);
        //         //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));
        //         // (uint256 amount, , , ) = farm.userInfo(address(lpToken), address(this));
        //         //  console.log(lpAmount, amount);
        //     }
    }

    function totalTokens() external view override onlyOwner returns (uint256) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));

        uint256 amountUst = (liquidity * ust.balanceOf(address(lpToken))) /
            lpToken.totalSupply();
        uint256 amountBusd = (liquidity * busd.balanceOf(address(lpToken))) /
            lpToken.totalSupply();

        address[] memory path = new address[](2);
        path[0] = address(busd);
        path[1] = address(ust);
        amountUst += router.getAmountsOut(amountBusd, path)[path.length - 1];

        return amountUst;
    }

    function swapExactTokensForTokens(
        uint256 amountA,
        IERC20 tokenA,
        IERC20 tokenB
    ) public returns (uint256 amountReceivedTokenB) {
        tokenA.approve(address(router), amountA);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 amountOutMin = router.getAmountsOut(amountA, path)[
            path.length - 1
        ];

        uint256 received = router.swapExactTokensForTokens(
            amountA,
            amountOutMin,
            path,
            address(this),
            block.timestamp + 1200
        )[path.length - 1];

        return received;
    }

    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        z = x < y ? x : y;
    }
}
