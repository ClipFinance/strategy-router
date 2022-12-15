pragma solidity ^0.8.0;

import "../interfaces/IExchangePlugin.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IUsdOracle.sol";
//import "hardhat/console.sol";

contract MockExchangePlugin is Ownable, IExchangePlugin {
    uint8 private constant UNIFORM_DECIMALS = 18;
    IUsdOracle private oracle;
    uint16 private slippageBps;
    uint16 private feeBps;

    constructor(IUsdOracle _oracle, uint16 _slippageBps, uint16 _feeBps) {
        oracle = _oracle;
        slippageBps = _slippageBps;
        feeBps = _feeBps;
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

        amountToReceive = amountToReceive * (10000 - slippageBps) / 10000;
        amountToReceive = amountToReceive * (10000 - feeBps) / 10000;
        amountToReceive = fromUniform(amountToReceive, tokenB);

        ERC20(tokenB).transfer(to, amountToReceive);

        return amountToReceive;
    }

    /// @notice Returns percent taken by DEX on which we swap provided tokens.
    /// @dev Fee percent has 18 decimals, e.g. 100% = 10**18
    function getExchangeProtocolFee(address tokenA, address tokenB)
    external
    view
    override
    returns (uint256 feePercent)
    {
        return uint256(feeBps) * 10**14;
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

        amountToReceive = amountToReceive * (10000 - slippageBps) / 10000;
        amountToReceive = amountToReceive * (10000 - feeBps) / 10000;
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
