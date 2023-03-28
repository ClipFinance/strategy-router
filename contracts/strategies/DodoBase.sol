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

    error InvalidInput();
    error CallerUpgrader();
    error DepositAmountExceedsBalance();
    error NotAllAssetsWithdrawn();

    uint256 private constant PERCENT_DENOMINATOR = 10000;

    address internal upgrader;

    IERC20 private immutable token;
    IERC20 public immutable lpToken;
    StrategyRouter public immutable strategyRouter;
    IERC20 public immutable dodoToken;
    IDodoSingleAssetPool public immutable pool;
    IDodoMine public immutable farm;
    bool public immutable isBase;

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
        if(address(_token) != _pool._BASE_TOKEN_() 
        && address(_token) != _pool._QUOTE_TOKEN_()) revert InvalidInput();

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
        uint256 currentTokenBalance = token.balanceOf(address(this));

        if (currentTokenBalance < strategyTokenAmountToWithdraw) {
            uint256 tokenAmountToRetrieve = strategyTokenAmountToWithdraw - currentTokenBalance;
            uint256 lpAmountToWithdraw = _getLpAmountFromAmount(tokenAmountToRetrieve);

            uint256 stakedLpBalance = farm.getUserLpBalance(
                address(lpToken),
                address(this)
            );

            if (lpAmountToWithdraw > stakedLpBalance)
                lpAmountToWithdraw = stakedLpBalance;

            farm.withdraw(address(lpToken), lpAmountToWithdraw);

            if(lpAmountToWithdraw != 0) {
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
        uint256 currentTokenBalance = token.balanceOf(address(this));
        return
            currentTokenBalance +
            _getAmountFromLpAmount(
                farm.getUserLpBalance(address(lpToken), address(this))
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

        if (totalTokens() > 0) revert NotAllAssetsWithdrawn();
    }

    function _getExpectedTarget() internal view returns (uint256) {
        (uint256 baseExpectedTarget, uint256 quoteExpectedTarget) = pool
            .getExpectedTarget();
        return isBase ? baseExpectedTarget : quoteExpectedTarget;
    }

    function _deposit(uint256 amount) internal {
        if(amount == 0) return;
        if (amount > token.balanceOf(address(this))) revert DepositAmountExceedsBalance();
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

    function _getAmountFromLpAmount(uint256 lpAmount)
        internal
        view
        returns (uint256)
    {
        uint256 lpSupply = lpToken.totalSupply();
        if (lpSupply == 0) {
            return 0;
        }
        uint256 amount = (lpAmount * _getExpectedTarget()) / lpSupply;
        return amount;
    }

    function _getLpAmountFromAmount(uint256 amount)
        internal
        view
        returns (uint256)
    {
        uint256 lpSupply = lpToken.totalSupply();
        uint256 lpAmount = (amount * lpSupply) / _getExpectedTarget();
        return lpAmount;
    }
}
