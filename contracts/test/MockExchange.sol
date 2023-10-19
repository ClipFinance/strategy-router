//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/ICurvePool.sol";
import "../interfaces/IExchangePlugin.sol";
import "../interfaces/IStrategyRouter.sol";
import {TokenPrice} from "../lib/Structs.sol";

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

    function swap(uint256 amountA, address tokenA, address tokenB, address to) public returns (uint256 amountReceived) {
        IERC20(tokenB).transfer(to, _amountReceived);
        return _amountReceived;
    }

    function stablecoinSwap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) public returns (uint256 amountReceived) {
        IERC20(tokenB).transfer(to, _amountReceived);
        return _amountReceived;
    }

    function protectedSwap(
        uint256 amountA,
        address tokenA,
        address tokenB,
        address to,
        TokenPrice calldata usdPriceTokenA,
        TokenPrice calldata usdPriceTokenB
    ) public returns (uint256 amountReceived) {
        IERC20(tokenB).transfer(to, _amountReceived);
        return _amountReceived;
    }
}
