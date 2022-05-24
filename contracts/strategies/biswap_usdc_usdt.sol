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


contract biswap_usdc_usdt is Ownable, IStrategy {
    ERC20 public constant USDC =
        ERC20(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d);
    ERC20 public constant USDT =
        ERC20(0x55d398326f99059fF775485246999027B3197955);
    ERC20 public constant bsw =
        ERC20(0x965F527D9159dCe6288a2219DB51fc6Eef120dD1);
    ERC20 public constant lpToken =
        ERC20(0x1483767E665B3591677Fd49F724bf7430C18Bf83);
    IBiswapFarm public constant farm =
        IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 public constant biswapRouter =
        IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);
    StrategyRouter public immutable strategyRouter;
    uint256 private constant poolId = 4;

    uint256 private immutable LEFTOVER_TRESHOLD_BUSD = 10**USDT.decimals(); // 1USDT 
    uint256 private immutable LEFTOVER_TRESHOLD_UST = 10**USDC.decimals(); // 1USDC 

    constructor(StrategyRouter _strategyRouter) {
        strategyRouter = _strategyRouter;
    }

    function depositToken() external pure override returns (address) {
        return address(USDC);
    }

    function deposit(uint256 amount) external override onlyOwner {

        // TODO: Is there a way to swap tokens to get perfect (or better) ratio to addLiquidity?

        // swap a bit more to account for swap fee (0.06% on acryptos)
        uint256 usdtAmount = (amount * 5003) / 10000;
        uint256 usdcAmount = amount - usdtAmount;

        Exchange exchange = strategyRouter.exchange();
        USDC.transfer(address(exchange), usdtAmount);
        usdtAmount = exchange.swapRouted(usdtAmount, USDC, USDT, address(this));

        USDC.approve(address(biswapRouter), usdcAmount);
        USDT.approve(address(biswapRouter), usdtAmount);
        (uint256 amountA, uint256 amountB, uint256 liquidity) = biswapRouter
            .addLiquidity(
                address(USDC),
                address(USDT),
                usdcAmount,
                usdtAmount,
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

        (_reserve0, _reserve1) = token0 == address(USDC)
            ? (_reserve0, _reserve1)
            : (_reserve1, _reserve0);

        amountBusd = biswapRouter.quote(amountUstToBusd, _reserve0, _reserve1);

        uint256 liquidity = (lpToken.totalSupply() * (amountUst + amountBusd)) /
            (balance0 + balance1);

        farm.withdraw(poolId, liquidity);
        lpToken.approve(address(biswapRouter), liquidity);
        (uint256 amountA, uint256 amountB) = biswapRouter.removeLiquidity(
            address(USDC),
            address(USDT),
            lpToken.balanceOf(address(this)),
            0,
            0,
            address(this),
            block.timestamp
        );

        Exchange exchange = strategyRouter.exchange();
        USDT.transfer(address(exchange), amountB);
        amountA += exchange.swapRouted(amountB, USDT, USDC, address(this));
        USDC.transfer(msg.sender, amountA);
        amountWithdrawn = amountA;
    }

    function compound() external override onlyOwner {
        farm.withdraw(poolId, 0);
        // use balance because BSW is harvested on deposit and withdraw calls
        uint256 bswAmount = bsw.balanceOf(address(this));

        if (bswAmount > 0) {
            fix_leftover(0);
            sellReward(bswAmount);
            uint256 balanceUst = USDC.balanceOf(address(this));
            uint256 balanceBusd = USDT.balanceOf(address(this));

            USDC.approve(address(biswapRouter), balanceUst);
            USDT.approve(address(biswapRouter), balanceBusd);

            (uint256 amountA, uint256 amountB, uint256 liquidity) = biswapRouter
                .addLiquidity(
                    address(USDC),
                    address(USDT),
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

    function totalTokens() external view override returns (uint256) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));

        uint256 _totalSupply = lpToken.totalSupply();
        // this formula is from remove_liquidity -> burn of uniswapV2pair
        uint256 amountUst = (liquidity * USDC.balanceOf(address(lpToken))) /
            _totalSupply;
        uint256 amountBusd = (liquidity * USDT.balanceOf(address(lpToken))) /
            _totalSupply;

        if (amountBusd > 0) {
            address token0 = IUniswapV2Pair(address(lpToken)).token0();

            (uint112 _reserve0, uint112 _reserve1, ) = IUniswapV2Pair(
                address(lpToken)
            ).getReserves();

            (_reserve0, _reserve1) = token0 == address(USDT)
                ? (_reserve0, _reserve1)
                : (_reserve1, _reserve0);

            // convert amountBusd to amount USDC 
            amountUst += biswapRouter.quote(amountBusd, _reserve0, _reserve1);
        }

        return amountUst;
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
                address(USDC),
                address(USDT),
                lpToken.balanceOf(address(this)),
                0,
                0,
                address(this),
                block.timestamp
            );
        }

        uint256 amountUst = USDC.balanceOf(address(this));
        uint256 amountBusd = USDT.balanceOf(address(this));

        if (amountBusd > 0) {
            Exchange exchange = strategyRouter.exchange();
            USDT.transfer(address(exchange), amountBusd);
            amountUst += exchange.swapRouted(
                amountBusd,
                USDT,
                USDC,
                address(this)
            );
        }
        if (amountUst > 0) {
            USDC.transfer(msg.sender, amountUst);
            amountWithdrawn = amountUst;
        }
    }

    /// @dev Swaps leftover tokens for a better ratio for LP.
    function fix_leftover(uint256 amoungIgnore) private {
        Exchange exchange = strategyRouter.exchange();
        uint256 usdtAmount = USDT.balanceOf(address(this));
        uint256 usdcAmount = USDC.balanceOf(address(this)) - amoungIgnore;
        uint256 toSwap;
        if (
            usdtAmount > usdcAmount &&
            (toSwap = usdtAmount - usdcAmount) > LEFTOVER_TRESHOLD_BUSD
        ) {
            toSwap = (toSwap * 5003) / 1e4;
            USDT.transfer(address(exchange), toSwap);
            exchange.swapRouted(toSwap, USDT, USDC, address(this));
        } else if (
            usdcAmount > usdtAmount &&
            (toSwap = usdcAmount - usdtAmount) > LEFTOVER_TRESHOLD_UST
        ) {
            toSwap = (toSwap * 5003) / 1e4;
            USDC.transfer(address(exchange), toSwap);
            exchange.swapRouted(toSwap, USDC, USDT, address(this));
        }
    }

    // swap bsw for USDC & USDT in proportions 50/50
    function sellReward(uint256 amountA)
        private
        returns (uint256 receivedUst, uint256 receivedBusd)
    {
        // take comission
        amountA = takeFee(amountA);

        // sell for lp ratio
        uint256 ustPart = amountA / 2;
        uint256 busdPart = amountA - ustPart;

        Exchange exchange = strategyRouter.exchange();
        bsw.transfer(address(exchange), ustPart);
        receivedUst = exchange.swapRouted(ustPart, bsw, USDC, address(this));

        bsw.transfer(address(exchange), busdPart);
        receivedBusd = exchange.swapRouted(busdPart, bsw, USDT, address(this));
    }

    function takeFee(uint256 amount) private returns (uint256 amountAfterFee) {
        Exchange exchange = strategyRouter.exchange();

        uint256 feePercent = StrategyRouter(strategyRouter).feePercent();
        address feeAddress = StrategyRouter(strategyRouter).feeAddress();
        uint256 fee = (amount * feePercent) / 1e4;
        if (fee > 0 && feeAddress != address(0)) {
            bsw.transfer(address(exchange), fee);
            exchange.swapRouted(fee, bsw, USDC, feeAddress);
        }
        return amount - fee;
    }
}
