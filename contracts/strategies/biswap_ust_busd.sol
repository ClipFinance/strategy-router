//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../interfaces/IZapDepositer.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IBiswapFarm.sol";
import "../StrategyRouter.sol";
// import "hardhat/console.sol";


// TODO: do something with leftover amounts
contract biswap_ust_busd is Ownable, IStrategy {
    ERC20 public constant ust =
        ERC20(0x23396cF899Ca06c4472205fC903bDB4de249D6fC);
    ERC20 public constant busd =
        ERC20(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56);
    ERC20 public constant bsw =
        ERC20(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1);
    ERC20 public constant lpToken =
        ERC20(0x9E78183dD68cC81bc330CAF3eF84D354a58303B5);
    IBiswapFarm public constant farm =
        IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 public constant biswapRouter =
        IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);
    StrategyRouter public immutable strategyRouter;
    uint256 public constant poolId = 18;

    uint256 public immutable LEFTOVER_TRESHOLD_BUSD = 10**busd.decimals(); // 1 busd
    uint256 public immutable LEFTOVER_TRESHOLD_UST = 10**ust.decimals(); // 1 ust

    constructor(StrategyRouter _strategyRouter) {
        strategyRouter = _strategyRouter;
    }

    function depositToken() external pure override returns (address) {
        return address(ust);
    }

    function deposit(uint256 amount) external override onlyOwner {

        // TODO: Is there a way to swap ust to busd so that we'll get perfect ratio to addLiquidity?
        //       If so, we could get rid of that helper function.

        // swap a bit more to account for swap fee (0.06% on acryptos)
        uint256 busdAmount = (amount * 5003) / 10000;
        uint256 ustAmount = amount - busdAmount;

        Exchange exchange = strategyRouter.exchange();
        ust.transfer(address(exchange), busdAmount);
        busdAmount = exchange.swapRouted(busdAmount, ust, busd, address(this));

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
        farm.deposit(poolId, liquidity);
    }

    function withdraw(uint256 amount)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
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

        farm.withdraw(poolId, liquidity);
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
        amountWithdrawn = amountA;
    }

    function compound() external override onlyOwner {
        farm.withdraw(poolId, 0);
        // use balance because BSW is harvested on deposit and withdraw calls
        uint256 bswAmount = bsw.balanceOf(address(this));

        if (bswAmount > 0) {
            fix_leftover(0);
            sellBSW(bswAmount);
            uint256 balanceUst = ust.balanceOf(address(this));
            uint256 balanceBusd = busd.balanceOf(address(this));

            ust.approve(address(biswapRouter), balanceUst);
            busd.approve(address(biswapRouter), balanceBusd);

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
            farm.deposit(poolId, lpAmount);
        }
    }

    /// @dev Swaps leftover tokens for a better ratio for LP.
    function fix_leftover(uint256 amoungIgnore) public {
        Exchange exchange = strategyRouter.exchange();
        uint256 busdAmount = busd.balanceOf(address(this));
        uint256 ustAmount = ust.balanceOf(address(this)) - amoungIgnore;
        uint256 toSwap;
        if (
            busdAmount > ustAmount &&
            (toSwap = busdAmount - ustAmount) > LEFTOVER_TRESHOLD_BUSD
        ) {
            toSwap = (toSwap * 5003) / 1e4;
            busd.transfer(address(exchange), toSwap);
            exchange.swapRouted(toSwap, busd, ust, address(this));
        } else if (
            ustAmount > busdAmount &&
            (toSwap = ustAmount - busdAmount) > LEFTOVER_TRESHOLD_UST
        ) {
            toSwap = (toSwap * 5003) / 1e4;
            ust.transfer(address(exchange), toSwap);
            exchange.swapRouted(toSwap, ust, busd, address(this));
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
        // take comission
        amountA = takeFee(amountA);

        // sell for lp ratio
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
        (uint256 amount, ) = farm.userInfo(poolId, address(this));
        if (amount > 0) {
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

        if (amountBusd > 0) {
            Exchange exchange = strategyRouter.exchange();
            busd.transfer(address(exchange), amountBusd);
            amountUst += exchange.swapRouted(
                amountBusd,
                busd,
                ust,
                address(this)
            );
        }
        if (amountUst > 0) {
            ust.transfer(msg.sender, amountUst);
            amountWithdrawn = amountUst;
        }
    }

    function takeFee(uint256 amount) private returns (uint256 amountAfterFee) {
        Exchange exchange = strategyRouter.exchange();

        uint256 feePercent = StrategyRouter(strategyRouter).feePercent();
        address feeAddress = StrategyRouter(strategyRouter).feeAddress();
        uint256 fee = (amount * feePercent) / 1e4;
        if (fee > 0 && feeAddress != address(0)) {
            bsw.transfer(address(exchange), fee);
            exchange.swapRouted(fee, bsw, ust, feeAddress);
        }
        return amount - fee;
    }
}
