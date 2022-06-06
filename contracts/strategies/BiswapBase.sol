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

// Base contract to be inherited, works with biswap MasterChef:
// BNB Chain: 0xDbc1A13490deeF9c3C12b44FE77b503c1B061739
// MasterChef github: https://github.com/biswap-org/staking/blob/main/contracts/MasterChef.sol
contract BiswapBase is Ownable, IStrategy {
    ERC20 internal immutable tokenA;
    ERC20 internal immutable tokenB;
    ERC20 internal immutable bsw;
    ERC20 internal immutable lpToken;
    StrategyRouter internal immutable strategyRouter;

    IBiswapFarm internal constant farm =
        IBiswapFarm(0xDbc1A13490deeF9c3C12b44FE77b503c1B061739);
    IUniswapV2Router02 internal constant biswapRouter =
        IUniswapV2Router02(0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8);

    uint256 internal immutable poolId;

    uint256 private immutable LEFTOVER_TRESHOLD_TOKEN_A;
    uint256 private immutable LEFTOVER_TRESHOLD_TOKEN_B;

    constructor(
        StrategyRouter _strategyRouter,
        uint256 _poolId,
        ERC20 _tokenA,
        ERC20 _tokenB,
        ERC20 _bsw,
        ERC20 _lpToken
    ) {
        strategyRouter = _strategyRouter;
        poolId = _poolId;
        tokenA = _tokenA;
        tokenB = _tokenB;
        bsw = _bsw;
        lpToken = _lpToken;
        LEFTOVER_TRESHOLD_TOKEN_A = 10**_tokenA.decimals();
        LEFTOVER_TRESHOLD_TOKEN_B = 10**_tokenB.decimals();
    }

    function depositToken() external view override returns (address) {
        return address(tokenA);
    }

    function deposit(uint256 amount) external override onlyOwner {
        // TODO: Is there a way to swap tokens to get perfect (or better) ratio to addLiquidity?

        // swap a bit more to account for swap fee (0.06% on acryptos)
        uint256 amountB = (amount * 5003) / 10000;
        uint256 amountA = amount - amountB;

        Exchange exchange = strategyRouter.exchange();
        tokenA.transfer(address(exchange), amountB);
        amountB = exchange.swapRouted(
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

        uint256 amountA = amount / 2;
        uint256 amountB = amount - amountA;

        (balance0, balance1) = token0 == address(tokenA)
            ? (balance0, balance1)
            : (balance1, balance0);

        amountB = biswapRouter.quote(amountB, balance0, balance1);

        uint256 liquidityToRemove = (lpToken.totalSupply() *
            (amountA + amountB)) / (balance0 + balance1);

        farm.withdraw(poolId, liquidityToRemove);
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

        Exchange exchange = strategyRouter.exchange();
        tokenB.transfer(address(exchange), amountB);
        amountA += exchange.swapRouted(
            amountB,
            address(tokenB),
            address(tokenA),
            address(this)
        );
        tokenA.transfer(msg.sender, amountA);
        return amountA;
    }

    function compound() external override onlyOwner {
        farm.withdraw(poolId, 0);
        // use balance because BSW is harvested on deposit and withdraw calls
        uint256 bswAmount = bsw.balanceOf(address(this));

        if (bswAmount > 0) {
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

    function totalTokens() external view override returns (uint256) {
        (uint256 liquidity, ) = farm.userInfo(poolId, address(this));

        uint256 _totalSupply = lpToken.totalSupply();
        // this formula is from uniswap.remove_liquidity -> uniswapPair.burn function 
        uint256 balanceA = tokenA.balanceOf(address(lpToken));
        uint256 balanceB = tokenB.balanceOf(address(lpToken));
        uint256 amountA = (liquidity * balanceA) /
            _totalSupply;
        uint256 amountB = (liquidity * balanceB) /
            _totalSupply;

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
        (uint256 amount, ) = farm.userInfo(poolId, address(this));
        if (amount > 0) {
            farm.withdraw(poolId, amount);
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
            Exchange exchange = strategyRouter.exchange();
            tokenB.transfer(address(exchange), amountB);
            amountA += exchange.swapRouted(
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
    function fix_leftover(uint256 amoungIgnore) private {
        Exchange exchange = strategyRouter.exchange();
        uint256 amountB = tokenB.balanceOf(address(this));
        uint256 amountA = tokenA.balanceOf(address(this)) - amoungIgnore;
        uint256 toSwap;
        if (
            amountB > amountA &&
            (toSwap = amountB - amountA) > LEFTOVER_TRESHOLD_TOKEN_B
        ) {
            toSwap = (toSwap * 5003) / 1e4;
            tokenB.transfer(address(exchange), toSwap);
            exchange.swapRouted(
                toSwap,
                address(tokenB),
                address(tokenA),
                address(this)
            );
        } else if (
            amountA > amountB &&
            (toSwap = amountA - amountB) > LEFTOVER_TRESHOLD_TOKEN_A
        ) {
            toSwap = (toSwap * 5003) / 1e4;
            tokenA.transfer(address(exchange), toSwap);
            exchange.swapRouted(
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
        // take comission
        bswAmount = takeFee(bswAmount);

        // sell for lp ratio
        uint256 amountA = bswAmount / 2;
        uint256 amountB = bswAmount - amountA;

        Exchange exchange = strategyRouter.exchange();
        bsw.transfer(address(exchange), amountA);
        receivedA = exchange.swapRouted(
            amountA,
            address(bsw),
            address(tokenA),
            address(this)
        );

        bsw.transfer(address(exchange), amountB);
        receivedB = exchange.swapRouted(
            amountB,
            address(bsw),
            address(tokenB),
            address(this)
        );
    }

    function takeFee(uint256 amount) private returns (uint256 amountAfterFee) {
        Exchange exchange = strategyRouter.exchange();

        uint256 feePercent = StrategyRouter(strategyRouter).feePercent();
        address feeAddress = StrategyRouter(strategyRouter).feeAddress();
        uint256 fee = (amount * feePercent) / 1e4;
        if (fee > 0 && feeAddress != address(0)) {
            bsw.transfer(address(exchange), fee);
            exchange.swapRouted(fee, address(bsw), address(tokenA), feeAddress);
        }
        return amount - fee;
    }
}
