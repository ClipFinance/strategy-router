//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/ICurvePool.sol";
import "../interfaces/IExchangePlugin.sol";
import {StrategyRouter} from "../StrategyRouter.sol";

contract MockExchange {
    uint private _amountReceived;

    function setAmountReceived(uint amount) external {
        _amountReceived = amount;
    }

    function getExchangeProtocolFee(
        uint256 amountA,
        address tokenA,
        address tokenB
    ) public view returns (uint256 feePercent) {
        return 25e14; // 0.25% or 0.0025 with 18 decimals
    }

    function swap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to
    ) public returns (uint256 amountReceived) {
        IERC20(tokenB).transfer(to, _amountReceived);
        return _amountReceived;
    }
}
