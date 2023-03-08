//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../interfaces/IIdleStrategy.sol";
import "../interfaces/IBiswapFarm.sol";
import "../StrategyRouter.sol";

import "hardhat/console.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract IdleStrategy is Initializable, UUPSUpgradeable, OwnableUpgradeable, IStrategy {
    error CallerUpgrader();

    address internal upgrader;

    ERC20 internal immutable depositToken;
    StrategyRouter internal immutable strategyRouter;

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        StrategyRouter _strategyRouter,
        ERC20 _depositToken
    ) {
        strategyRouter = _strategyRouter;
        depositToken = _depositToken;

        // lock implementation
        _disableInitializers();
    }

    /// @notice Token used to deposit to strategy.
    function depositToken() external view returns (address) {
        return address(depositToken);
    }

    /// @notice Deposit token to strategy.
    function deposit(uint256 amount) external {}

    /// @notice Withdraw tokens from strategy.
    /// @dev Max withdrawable amount is returned by totalTokens.
    function withdraw(uint256 amount) external returns (uint256 amountWithdrawn) {
        depositToken.transfer(strategyRouter, amount);

        return amount;
    }

    /// @notice Harvest rewards and reinvest them.
    function compound() external {}

    /// @notice Approximated amount of token on the strategy.
    function totalTokens() external view returns (uint256) {
        return depositToken.balanceOf(this);
    }

    /// @notice Withdraw all tokens from strategy.
    function withdrawAll() external returns (uint256 amountWithdrawn) {
        amountWithdrawn = depositToken.balanceOf(this);
        depositToken.transfer(strategyRouter, amountWithdrawn);
    }
}