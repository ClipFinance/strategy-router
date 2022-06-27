//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import "./ReceiptNFT.sol";
import "./Exchange.sol";
import "./SharesToken.sol";
import "./Batching.sol";
import "./StrategyRouter.sol";

// import "hardhat/console.sol";

library StrategyRouterLib {
    error CycleNotClosed();

    uint8 private constant UNIFORM_DECIMALS = 18;
    uint256 private constant PRECISION = 1e18;

    function getStrategiesValue(
        IUsdOracle oracle,
        StrategyRouter.StrategyInfo[] storage strategies
    ) public view returns (uint256 totalBalance, uint256[] memory balances) {
        balances = new uint256[](strategies.length);
        for (uint256 i; i < balances.length; i++) {
            address token = strategies[i].depositToken;

            uint256 balanceInDepositToken = IStrategy(
                strategies[i].strategyAddress
            ).totalTokens();

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(
                token
            );
            balanceInDepositToken = ((balanceInDepositToken * price) /
                10**priceDecimals);
            balanceInDepositToken = toUniform(balanceInDepositToken, token);
            balances[i] = balanceInDepositToken;
            totalBalance += balanceInDepositToken;
        }
    }

    // returns amount of shares locked by receipt.
    function receiptToShares(
        ReceiptNFT receiptContract,
        mapping(uint256 => StrategyRouter.Cycle) storage cycles,
        uint256 currentCycleId,
        uint256 receiptId
    ) public view returns (uint256 shares) {
        ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(
            receiptId
        );
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        // calculate old usd value
        uint256 oldValue;
        uint256 oldPrice = cycles[receipt.cycleId].prices[receipt.token];
        oldValue = (receipt.amount * oldPrice) / 10**UNIFORM_DECIMALS;
        assert(oldValue > 0);
        // adjust according to what was actually deposited into strategies
        uint256 oldValueAdjusted = (oldValue * cycles[receipt.cycleId].receivedByStrategiesInUsd) /
            cycles[receipt.cycleId].totalDepositedInUsd;
        return oldValueAdjusted * PRECISION / cycles[receipt.cycleId].pricePerShare;
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

    /// @dev Swap tokens if they are different (i.e. not the same token)
    function trySwap(
        Exchange exchange,
        uint256 amount,
        address from,
        address to
    ) internal returns (uint256 result) {
        if (from != to) {
            IERC20(from).transfer(address(exchange), amount);
            result = exchange.swap(amount, from, to, address(this));
            return result;
        }
        return amount;
    }

    /// @dev Change decimal places to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address token)
        internal
        view
        returns (uint256)
    {
        return
            changeDecimals(amount, ERC20(token).decimals(), UNIFORM_DECIMALS);
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address token)
        internal
        view
        returns (uint256)
    {
        return
            changeDecimals(amount, UNIFORM_DECIMALS, ERC20(token).decimals());
    }
}
