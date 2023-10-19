pragma solidity ^0.8.0;

import "../interfaces/IExchangePlugin.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IUsdOracle.sol";
import {StrategyRouter} from "../StrategyRouter.sol";
import {toUniform, fromUniform} from "../lib/Math.sol";

contract MockExchangePlugin is Ownable, IExchangePlugin {
    uint8 private constant UNIFORM_DECIMALS = 18;
    IUsdOracle private oracle;
    // For example, 500 means that received amount will be less by 5%
    uint16 private slippageInBps;
    // Fee amount that is charged by exchange on every swap
    // For example, 30 means that received amount will be less by 0.3%
    uint16 private exchangeFeeBps;
    // capture amout of time swap was called
    uint16 public swapCallNumber = 0;

    // routes with fixed received amount
    mapping(address => mapping(address => uint256)) public fixedReceivedAmounts;

    constructor(IUsdOracle _oracle, uint16 _slippageInBps, uint16 _exchangeFeeBps) {
        oracle = _oracle;
        slippageInBps = _slippageInBps;
        exchangeFeeBps = _exchangeFeeBps;

        if (tx.origin != msg.sender) {
            // set proxi owner to address that deployed this contract from Create2Deployer
            transferOwnership(tx.origin);
        }
    }

    function setFixedReceivedAmount(
        address tokenA,
        address tokenB,
        uint256 amountB // set zero to disable fixed amount
    ) external onlyOwner {
        fixedReceivedAmounts[tokenA][tokenB] = amountB;
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        uint256 minAmountTokenB
    ) external override returns (uint256 amountReceivedTokenB) {
        uint256 fixedReceivedAmountB = fixedReceivedAmounts[tokenA][tokenB];
        if (fixedReceivedAmountB != 0) {
            ERC20(tokenB).transfer(to, fixedReceivedAmountB);
            return fixedReceivedAmountB;
        }

        uint256 amountToReceive = toUniform(amountA, tokenA);
        (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(tokenA);
        amountToReceive = (amountToReceive * price) / 10 ** priceDecimals; // convert to USD amount

        (price, priceDecimals) = oracle.getTokenUsdPrice(tokenB);
        amountToReceive = (amountToReceive * 10 ** priceDecimals) / price; // convert to TokenB amount

        amountToReceive = (amountToReceive * (10000 - slippageInBps)) / 10000;
        amountToReceive = (amountToReceive * (10000 - exchangeFeeBps)) / 10000;
        amountToReceive = fromUniform(amountToReceive, tokenB);

        ERC20(tokenB).transfer(to, amountToReceive);

        swapCallNumber += 1;

        amountReceivedTokenB = amountToReceive;

        if (amountReceivedTokenB < minAmountTokenB) revert ReceivedTooLittleTokenB();
    }

    /// @notice Returns percent taken by DEX on which we swap provided tokens.
    /// @dev Fee percent has 18 decimals,
    /// e.g.
    /// 10000 bps = 100%  = 10**18
    /// 1 bps     = 0.01% = 10**14
    /// 30 bps    = 0.3%  = 0.003 * 10**18 = 3 * 10**15
    function getExchangeProtocolFee(
        address tokenA,
        address tokenB
    ) external view override returns (uint256 feePercent) {
        return uint256(exchangeFeeBps) * 10 ** 14;
    }

    function getRoutePrice(address tokenA, address tokenB) external view override returns (uint256 price) {
        (uint256 priceA, uint8 priceDecimalsA) = oracle.getTokenUsdPrice(tokenA);
        (uint256 priceB, uint8 priceDecimalsB) = oracle.getTokenUsdPrice(tokenB);
        return ((priceA * 10 ** priceDecimalsB) / priceB) * 10 ** priceDecimalsA;
    }
}
