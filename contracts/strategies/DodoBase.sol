//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AbstractBaseStrategyWithHardcap.sol";
import "../deps/UUPSUpgradeable.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IDodoMine.sol";
import "../interfaces/IDodoSingleAssetPool.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IExchange.sol";
import "../lib/Math.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract DodoBase is Initializable, UUPSUpgradeable, OwnableUpgradeable, IStrategy, AbstractBaseStrategyWithHardcap {
    using SafeERC20 for IERC20Metadata;
    using ClipMath for uint256;

    uint256 private constant PERCENT_DENOMINATOR = 10000;

    address internal upgrader;

    IERC20Metadata private immutable token;
    IERC20Metadata public immutable lpToken;
    IStrategyRouter public immutable strategyRouter;
    IERC20Metadata public immutable dodoToken;
    IDodoSingleAssetPool public immutable pool;
    IDodoMine public immutable farm;
    bool public immutable isBase;

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        IStrategyRouter _strategyRouter,
        IERC20Metadata _token,
        IERC20Metadata _lpToken,
        IERC20Metadata _dodoToken,
        IDodoSingleAssetPool _pool,
        IDodoMine _farm
    ) {
        if (address(_token) != _pool._BASE_TOKEN_() && address(_token) != _pool._QUOTE_TOKEN_()) revert InvalidInput();

        strategyRouter = _strategyRouter;
        token = _token;
        lpToken = _lpToken;
        dodoToken = _dodoToken;
        pool = _pool;
        farm = _farm;
        isBase = address(_token) == _pool._BASE_TOKEN_();

        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        (
            address _upgrader,
            uint256 _hardcapTargetInToken,
            uint16 _hardcapDeviationInBps,
            address[] memory depositors
        ) = abi.decode(initializeData, (address, uint256, uint16, address[]));

        super.initialize(_hardcapTargetInToken, _hardcapDeviationInBps, depositors);

        __UUPSUpgradeable_init();
        upgrader = _upgrader;

        // set proxi admin to address that deployed this contract from Create2Deployer
        _changeAdmin(tx.origin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    function depositToken() external view override returns (address) {
        return address(token);
    }

    function rewardToken() external view override returns (address) {
        return address(dodoToken);
    }

    function getPendingReward() external view override returns (uint256) {
        return farm.getPendingReward(address(lpToken), address(this));
    }

    function withdraw(
        uint256 strategyTokenAmountToWithdraw
    ) external override onlyOwner returns (uint256 amountWithdrawn) {
        uint256 currentTokenBalance = token.balanceOf(address(this));

        if (currentTokenBalance < strategyTokenAmountToWithdraw) {
            uint256 tokenAmountToRetrieve = strategyTokenAmountToWithdraw - currentTokenBalance;
            uint256 lpAmountToWithdraw = _getLpAmountFromAmount(tokenAmountToRetrieve);

            uint256 stakedLpBalance = farm.getUserLpBalance(address(lpToken), address(this));

            if (lpAmountToWithdraw > stakedLpBalance) {
                lpAmountToWithdraw = stakedLpBalance;
            }

            if (lpAmountToWithdraw != 0) {
                farm.withdraw(address(lpToken), lpAmountToWithdraw);
                uint256 receiveAmount = _getAmountFromLpAmount(lpAmountToWithdraw);
                _withdrawFromDodoLp(receiveAmount);
                _sellDodo();
                currentTokenBalance = token.balanceOf(address(this));
            }

            if (currentTokenBalance < strategyTokenAmountToWithdraw) {
                strategyTokenAmountToWithdraw = currentTokenBalance;
            } else {
                _deposit(currentTokenBalance - strategyTokenAmountToWithdraw);
            }
        }

        token.safeTransfer(msg.sender, strategyTokenAmountToWithdraw);

        return strategyTokenAmountToWithdraw;
    }

    function compound() external override onlyOwner {
        farm.claim(address(lpToken));

        _sellDodo();

        _deposit(token.balanceOf(address(this)));
    }

    function totalTokens() public view override returns (uint256) {
        return _totalTokens();
    }

    function withdrawAll() external override onlyOwner returns (uint256 amountWithdrawn) {
        farm.withdrawAll(address(lpToken));

        if (lpToken.balanceOf(address(this)) != 0) {
            _withdrawAllFromDodoLp();
        }

        _sellDodo();
        amountWithdrawn = token.balanceOf(address(this));

        if (amountWithdrawn != 0) {
            token.safeTransfer(msg.sender, amountWithdrawn);
        }

        if (totalTokens() > 0) revert NotAllAssetsWithdrawn();
    }

    function _getExpectedTarget() internal view returns (uint256) {
        (uint256 baseExpectedTarget, uint256 quoteExpectedTarget) = pool.getExpectedTarget();
        return isBase ? baseExpectedTarget : quoteExpectedTarget;
    }

    function _deposit(uint256 amount) internal override {
        if (amount == 0) return;
        if (amount > token.balanceOf(address(this))) revert DepositAmountExceedsBalance();
        token.safeApprove(address(pool), amount);

        uint256 lpTokens = _depositToDodoLp(amount);

        if (lpTokens != 0) {
            lpToken.safeApprove(address(farm), lpTokens);
            farm.deposit(address(lpToken), lpTokens);
        }
    }

    function _totalTokens() internal view override returns (uint256) {
        uint256 currentTokenBalance = token.balanceOf(address(this));

        return currentTokenBalance + _getAmountFromLpAmount(farm.getUserLpBalance(address(lpToken), address(this)));
    }

    function _depositToDodoLp(uint256 _amount) internal returns (uint256) {
        if (isBase) {
            pool.depositBase(_amount);
        } else {
            pool.depositQuote(_amount);
        }
        return lpToken.balanceOf(address(this));
    }

    function _withdrawFromDodoLp(uint256 _amount) internal {
        if (isBase) {
            pool.withdrawBase(_amount);
        } else {
            pool.withdrawQuote(_amount);
        }
    }

    function _withdrawAllFromDodoLp() internal {
        if (isBase) {
            pool.withdrawAllBase();
        } else {
            pool.withdrawAllQuote();
        }
    }

    function _sellDodo() internal returns (uint256) {
        uint256 dodoTokenBalance = dodoToken.balanceOf(address(this));
        if (dodoTokenBalance == 0) {
            return 0;
        }

        IExchange exchange = strategyRouter.getExchange();
        dodoToken.transfer(address(exchange), dodoTokenBalance);

        return exchange.swap(dodoTokenBalance, address(dodoToken), address(token), address(this));
    }

    function _getAmountFromLpAmount(uint256 lpAmount) internal view returns (uint256) {
        uint256 lpSupply = lpToken.totalSupply();
        if (lpSupply == 0) {
            return 0;
        }
        uint256 amount = (lpAmount * _getExpectedTarget()) / lpSupply;
        return amount;
    }

    function _getLpAmountFromAmount(uint256 amount) internal view returns (uint256) {
        uint256 lpSupply = lpToken.totalSupply();
        uint256 lpAmount = (amount * lpSupply).divCeil(_getExpectedTarget());
        return lpAmount;
    }

    /* ERRORS */

    error InvalidInput();
    error CallerUpgrader();
    error DepositAmountExceedsBalance();
    error NotAllAssetsWithdrawn();
}
