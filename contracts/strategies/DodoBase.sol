//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IDodoMine.sol";
import "../interfaces/IDodoSingleAssetPool.sol";
import "../StrategyRouter.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract DodoBase is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    IStrategy
{
    using SafeERC20 for IERC20;

    error CallerUpgrader();

    address internal upgrader;

    IERC20 public immutable token;
    IERC20 public immutable lpToken;
    StrategyRouter public immutable strategyRouter;

    IERC20 public immutable dodoToken;
    IDodoSingleAssetPool public immutable pool;
    IDodoMine public immutable farm;
    bool public immutable isBase;

    uint256 private constant PERCENT_DENOMINATOR = 10000;

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        StrategyRouter _strategyRouter,
        IERC20 _token,
        IERC20 _lpToken,
        IERC20 _dodoToken,
        IDodoSingleAssetPool _pool,
        IDodoMine _farm
    ) {
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

    function initialize(address _upgrader) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        upgrader = _upgrader;
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyUpgrader
    {}

    function depositToken() external view override returns (address) {
        return address(token);
    }

    function deposit(uint256 amount) external override onlyOwner {
        _deposit(amount);
    }

    function withdraw(uint256 strategyTokenAmountToWithdraw)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        uint256 currentBal = token.balanceOf(address(this));

        if (currentBal < strategyTokenAmountToWithdraw) {
            uint256 remainingBal = strategyTokenAmountToWithdraw - currentBal;
            uint256 lpTokenTotalSupply = lpToken.totalSupply();

            uint256 lpAmountToWithdraw = (remainingBal * lpTokenTotalSupply) /
                _getExpectedTarget();

            uint256 stakedLpBalance = farm.getUserLpBalance(
                address(lpToken),
                address(this)
            );

            if (stakedLpBalance < lpAmountToWithdraw)
                lpAmountToWithdraw = stakedLpBalance;
            farm.withdraw(address(lpToken), lpAmountToWithdraw);

            uint256 receiveAmount = _getAmountFromLpAmount(lpAmountToWithdraw, false);
            _withdrawFromDodoLp(receiveAmount);
            _sellDodo();

            currentBal = token.balanceOf(address(this));

            if (currentBal < strategyTokenAmountToWithdraw)
                strategyTokenAmountToWithdraw = currentBal;
            else _deposit(currentBal - strategyTokenAmountToWithdraw);
        }

        token.safeTransfer(msg.sender, strategyTokenAmountToWithdraw);

        return strategyTokenAmountToWithdraw;
    }

    function compound() external override onlyOwner {
        farm.claim(address(lpToken));

        uint256 tokenAmountToCompound = _sellDodo();

        _deposit(tokenAmountToCompound);
    }

    function totalTokens() external view override returns (uint256) {
        uint256 currentBal = token.balanceOf(address(this));
        return
            currentBal +
            _getAmountFromLpAmount(
                farm.getUserLpBalance(address(lpToken), address(this)),
                true
            );
    }

    function withdrawAll()
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        farm.withdrawAll(address(lpToken));

        if (lpToken.balanceOf(address(this)) != 0)
            amountWithdrawn = _withdrawAllFromDodoLp();

        _sellDodo();
        amountWithdrawn = token.balanceOf(address(this));

        if (amountWithdrawn != 0)
            token.safeTransfer(msg.sender, amountWithdrawn);
    }

    function _getExpectedTarget() internal view returns (uint256) {
        (uint256 baseExpectedTarget, uint256 quoteExpectedTarget) = pool
            .getExpectedTarget();
        if (isBase) return baseExpectedTarget;
        return quoteExpectedTarget;
    }

    function getQuoteExpectedTarget()
        private
        view
        returns (uint256 quoteExpectedTarget)
    {
        (, quoteExpectedTarget) = pool.getExpectedTarget();
    }

    function _deposit(uint256 amount) internal {
        token.safeApprove(address(pool), amount);
        uint256 lpTokens = _depositToDodoLp(amount);

        if (lpTokens != 0) {
            lpToken.safeApprove(address(farm), lpTokens);
            farm.deposit(address(lpToken), lpTokens);
        }
    }

    function _depositToDodoLp(uint256 _amount) internal returns (uint256) {
        if (isBase) {
            return pool.depositBase(_amount);
        } else {
            return pool.depositQuote(_amount);
        }
    }

    function _withdrawFromDodoLp(uint256 _amount) internal returns (uint256) {
        if (isBase) {
            return pool.withdrawBase(_amount);
        } else {
            return pool.withdrawQuote(_amount);
        }
    }

    function _withdrawAllFromDodoLp() internal returns (uint256) {
        if (isBase) {
            return pool.withdrawAllBase();
        } else {
            return pool.withdrawAllQuote();
        }
    }

    function _sellDodo() internal returns (uint256) {
        uint256 dodoTokenBalance = dodoToken.balanceOf(address(this));
        if (dodoTokenBalance == 0) {
            return 0;
        }

        Exchange exchange = strategyRouter.getExchange();
        dodoToken.transfer(address(exchange), dodoTokenBalance);

        return
            exchange.swap(
                dodoTokenBalance,
                address(dodoToken),
                address(token),
                address(this)
            );
    }

    function _getAmountFromLpAmount(uint256 lpAmount, bool subtractPenalty)
        internal
        view
        returns (uint256)
    {
        uint256 lpSupply = lpToken.totalSupply();
        if (lpSupply == 0) {
            return 0;
        }
        uint256 amount = (lpAmount * _getExpectedTarget()) / lpSupply;
        uint256 penalty = isBase
            ? pool.getWithdrawBasePenalty(amount)
            : pool.getWithdrawQuotePenalty(amount);

        if(subtractPenalty)
            return amount - penalty;

        return amount;
    }
}
