//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IIdleStrategy.sol";
import "../interfaces/IStrategyRouter.sol";
import "../deps/Initializable.sol";
import "../deps/UUPSUpgradeable.sol";
import "../deps/OwnableUpgradeable.sol";
import "../deps/AccessControlUpgradeable.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract DefaultIdleStrategy is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    AccessControlUpgradeable,
    IIdleStrategy
{
    using SafeERC20 for IERC20;

    address internal upgrader;
    address internal moderator;

    IERC20 internal immutable token;
    IStrategyRouter internal immutable strategyRouter;

    uint256 private constant DUST_THRESHOLD_UNIFORM = 1e17; // 0.1 USDT/BUSD/USDC in uniform decimals
    uint8 public constant UNIFORM_DECIMALS = 18;

    // Create a new role identifier for the depositor role
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(address _strategyRouter, IERC20 _token) {
        strategyRouter = IStrategyRouter(_strategyRouter);
        token = _token;

        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();

        (address _upgrader, address[] memory depositors) = abi.decode(initializeData, (address, address[]));

        upgrader = _upgrader;

        // transer ownership to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);

        _setupRole(DEFAULT_ADMIN_ROLE, owner());
        for (uint256 i; i < depositors.length; i++) {
            _setupRole(DEPOSITOR_ROLE, depositors[i]);
        }
    }

    function setModerator(address _moderator) external onlyOwner {
        moderator = _moderator;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    /// @notice Token used to deposit to strategy.
    function depositToken() external view override returns (address) {
        return address(token);
    }

    /// @notice Deposit token to strategy.
    function deposit(uint256 amount) external override {
        if (!hasRole(DEPOSITOR_ROLE, _msgSender())) {
            revert OnlyDepositorsAllowedToDeposit();
        }
        uint256 uniformAmount = toUniform(amount, address(token));

        if (uniformAmount < DUST_THRESHOLD_UNIFORM) {
            token.safeTransfer(moderator, amount);
        }
    }

    /// @notice Withdraw tokens from strategy.
    /// @dev Max withdrawable amount is returned by totalTokens.
    function withdraw(uint256 amount) external override onlyOwner returns (uint256 amountWithdrawn) {
        uint256 totalTokens_ = _totalTokens();
        if (totalTokens_ < amount) {
            amount = totalTokens_;
        }
        token.safeTransfer(msg.sender, amount);

        return amount;
    }

    /// @notice Approximated amount of token on the strategy.
    function totalTokens() external view override returns (uint256) {
        uint totalTokens_ = _totalTokens();
        uint256 uniformTotalTokens_ = toUniform(totalTokens_, address(token));

        if (uniformTotalTokens_ < DUST_THRESHOLD_UNIFORM) return 0;
        else return totalTokens_;
    }

    function _totalTokens() internal view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Withdraw all tokens from strategy.
    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        amountWithdrawn = token.balanceOf(address(this));
        token.safeTransfer(msg.sender, amountWithdrawn);
        if (_totalTokens() != 0) {
            revert NotAllAssetsWithdrawn();
        }
    }

    // Internals

    /// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
    function changeDecimals(uint256 amount, uint8 oldDecimals, uint8 newDecimals) private pure returns (uint256) {
        if (oldDecimals < newDecimals) {
            return amount * (10 ** (newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10 ** (oldDecimals - newDecimals));
        }
        return amount;
    }

    /// @dev Change decimal places from token decimals to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address _token) private view returns (uint256) {
        return changeDecimals(amount, ERC20(_token).decimals(), UNIFORM_DECIMALS);
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address _token) private view returns (uint256) {
        return changeDecimals(amount, UNIFORM_DECIMALS, ERC20(_token).decimals());
    }

    /* ERRORS */

    error CallerUpgrader();
    error NotAllAssetsWithdrawn();
    error OnlyDepositorsAllowedToDeposit();
}
