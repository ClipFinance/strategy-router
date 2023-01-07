pragma solidity ^0.8.0;

import "../interfaces/IExchangePlugin.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IUsdOracle.sol";
//import "hardhat/console.sol";

contract MockExchangePlugin is Ownable, IExchangePlugin {
    uint8 private constant UNIFORM_DECIMALS = 18;
    IUsdOracle private oracle;
    // For example, 500 means that received amount will be less by 5%
    uint16 private slippageInBps;
    // Fee amount that is charged by exchange on every swap
    // For example, 30 means that received amount will be less by 0.3%
    uint16 private exchangeFeeBps;

    constructor(IUsdOracle _oracle, uint16 _slippageInBps, uint16 _exchangeFeeBps) {
        oracle = _oracle;
        slippageInBps = _slippageInBps;
        exchangeFeeBps = _exchangeFeeBps;
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) external override returns (uint256 amountReceivedTokenB) {
        uint256 amountToReceive = toUniform(amountA, tokenA);
        (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(tokenA);
        amountToReceive = amountToReceive * price / 10**priceDecimals; // convert to USD amount

        (price, priceDecimals) = oracle.getTokenUsdPrice(tokenB);
        amountToReceive = amountToReceive * 10**priceDecimals / price; // convert to TokenB amount

        amountToReceive = amountToReceive * (10000 - slippageInBps) / 10000;
        amountToReceive = amountToReceive * (10000 - exchangeFeeBps) / 10000;
        amountToReceive = fromUniform(amountToReceive, tokenB);

        ERC20(tokenB).transfer(to, amountToReceive);

        return amountToReceive;
    }

    /// @notice Returns percent taken by DEX on which we swap provided tokens.
    /// @dev Fee percent has 18 decimals,
    /// e.g.
    /// 10000 bps = 100%  = 10**18
    /// 1 bps     = 0.01% = 10**14
    /// 30 bps    = 0.3%  = 0.003 * 10**18 = 3 * 10**15
    function getExchangeProtocolFee(address tokenA, address tokenB)
    external
    view
    override
    returns (uint256 feePercent)
    {
        return uint256(exchangeFeeBps) * 10**14;
    }

    /// @notice Synonym of the uniswapV2's function, estimates amount you receive after swap.
    function getAmountOut(uint256 amountA, address tokenA, address tokenB)
    external
    view
    override
    returns (uint256 amountOut) {
        uint256 amountToReceive = toUniform(amountA, tokenA);
        (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(tokenA);
        amountToReceive = amountToReceive * price / 10**priceDecimals; // convert to USD amount

        (price, priceDecimals) = oracle.getTokenUsdPrice(tokenB);
        amountToReceive = amountToReceive * 10**priceDecimals / price; // convert to TokenB amount

        amountToReceive = amountToReceive * (10000 - slippageInBps) / 10000;
        amountToReceive = amountToReceive * (10000 - exchangeFeeBps) / 10000;
        amountToReceive = fromUniform(amountToReceive, tokenB);

        return amountToReceive;
    }

    /// @dev Change decimal places to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address token) internal view returns (uint256) {
        return changeDecimals(amount, ERC20(token).decimals(), UNIFORM_DECIMALS);
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address token) internal view returns (uint256) {
        return changeDecimals(amount, UNIFORM_DECIMALS, ERC20(token).decimals());
    }

    /// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
    function changeDecimals(
        uint256 amount,
        uint8 oldDecimals,
        uint8 newDecimals
    ) internal pure returns (uint256) {
        if (oldDecimals < newDecimals) {
            return amount * (10**(newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10**(oldDecimals - newDecimals));
        }
        return amount;
    }
}
