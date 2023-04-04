//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IIdleStrategy.sol";
import "../StrategyRouter.sol";
import "../deps/Initializable.sol";
import "../deps/UUPSUpgradeable.sol";
import "../deps/OwnableUpgradeable.sol";

import "hardhat/console.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract DefaultIdleStrategy is Initializable, UUPSUpgradeable, OwnableUpgradeable, IIdleStrategy {
    using SafeERC20 for IERC20;

    error CallerUpgrader();

    address internal upgrader;

    IERC20 internal immutable token;
    StrategyRouter internal immutable strategyRouter;

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        address _strategyRouter,
        IERC20 _token
    ) {
        strategyRouter = StrategyRouter(_strategyRouter);
        token = _token;

        // lock implementation
        _disableInitializers();
    }

    function initialize(address _upgrader) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        upgrader = _upgrader;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    /// @notice Token used to deposit to strategy.
    function depositToken() external view override returns (address) {
        return address(token);
    }

    /// @notice Deposit token to strategy.
    function deposit(uint256 amount) external override onlyOwner {}

    /// @notice Withdraw tokens from strategy.
    /// @dev Max withdrawable amount is returned by totalTokens.
    function withdraw(uint256 amount) external override onlyOwner returns (uint256 amountWithdrawn) {
        token.safeTransfer(msg.sender, amount);

        return amount;
    }

    /// @notice Approximated amount of token on the strategy.
    function totalTokens() external view override returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Withdraw all tokens from strategy.
    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        amountWithdrawn = token.balanceOf(address(this));
        token.safeTransfer(msg.sender, amountWithdrawn);
    }
}