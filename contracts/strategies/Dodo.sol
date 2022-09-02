//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IDodoMine.sol";
import "../interfaces/IDodoSingleAssetPool.sol";
import "../StrategyRouter.sol";

import "hardhat/console.sol";

contract Dodo is Initializable, UUPSUpgradeable, OwnableUpgradeable, IStrategy {
    error CallerUpgrader();

    address internal upgrader;

    function (uint256) external returns (uint256) internal immutable depositFn;
    function (uint256) external returns (uint256) internal immutable withdrawFn;
    function () internal returns (uint256) internal immutable expectedTargetFn;

    ERC20 internal immutable tokenA;
    ERC20 internal immutable tokenB;
    ERC20 internal immutable lpToken;
    StrategyRouter internal immutable strategyRouter;

    ERC20 internal immutable dodoToken;
    IDodoSingleAssetPool internal immutable pool;
    IDodoMine internal immutable farm;

    uint256 private constant PERCENT_DENOMINATOR = 10000;

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    /// @dev construct is intended to initialize immutables on implementation
    constructor(
        StrategyRouter _strategyRouter,
        ERC20 _tokenA,
        ERC20 _tokenB,
        ERC20 _lpToken,
        ERC20 _dodoToken,
        IDodoSingleAssetPool _pool,
        IDodoMine _farm
    ) {
        strategyRouter = _strategyRouter;
        tokenA = _tokenA;
        tokenB = _tokenB;
        lpToken = _lpToken;
        dodoToken = _dodoToken;
        pool = _pool;
        farm = _farm;

        if (address(tokenA) == pool._BASE_TOKEN_() && address(tokenB) == pool._QUOTE_TOKEN_()) {
            depositFn = pool.depositBase;
            withdrawFn = pool.withdrawBase;
            expectedTargetFn = getBaseExpectedTarget;
        } else if (address(tokenA) == pool._QUOTE_TOKEN_() && address(tokenB) == pool._BASE_TOKEN_()) {
            depositFn = pool.depositQuote;
            withdrawFn = pool.withdrawQuote;
            expectedTargetFn = getQuoteExpectedTarget;
        } else {
            revert("NOT_MATCHING_TOKENS");
        }

        // lock implementation
        _disableInitializers();
    }

    function initialize(address _upgrader) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        upgrader = _upgrader;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    function depositToken()
    external
    view
    override
    returns (address)
    {
        return address(tokenA);
    }

    function deposit(uint256 amount)
    external
    override
    onlyOwner
    {
        Exchange exchange = strategyRouter.getExchange();
        amountB = exchange.swap(amountB, address(tokenA), address(tokenB), address(this));

        tokenA.approve(address(pool), amount);
        uint256 lpTokens = depositFn(amount);

        lpToken.approve(address(farm), lpTokens);
        farm.deposit(address(lpToken), lpTokens);
    }

    function withdraw(uint256 strategyTokenAmountToWithdraw)
    external
    override
    onlyOwner
    returns (uint256 amountWithdrawn)
    {
        uint256 lpTokenTotalSupply = lpToken.totalSupply();

        uint256 lpAmountToWithdraw = strategyTokenAmountToWithdraw
            .mul(lpTokenTotalSupply)
            .div(
                expectedTargetFn()
            );

        farm.withdraw(lpToken, lpAmountToWithdraw);

        lpToken.approve(pool, lpAmountToWithdraw);

        // there could be withdrawal penalty on input amount
        strategyTokenAmountToWithdraw = withdrawFn(strategyTokenAmountToWithdraw);

        // withdraw also claims rewards
        uint256 dodoTokenBalance = dodoToken.balanceOf(address(this));
        if (dodoTokenBalance > 0) {
            Exchange exchange = strategyRouter.getExchange();
            dodoToken.transfer(address(exchange), dodoTokenBalance);

            uint256 rewardsInTokenA = exchange.swap(
                dodoTokenBalance,
                address(dodoToken),
                address(tokenA),
                address(this)
            );

            rewardsInTokenA = collectProtocolCommission(rewardsInTokenA);

            strategyTokenAmountToWithdraw += rewardsInTokenA;
        }

        tokenA.transfer(msg.sender, strategyTokenAmountToWithdraw);

        return strategyTokenAmountToWithdraw;
    }

    function compound()
    external
    override
    onlyOwner
    {
        farm.claim(lpToken);

        uint256 dodoTokenBalance = dodoToken.balanceOf(address(this));
        if (dodoTokenBalance == 0) {
            return;
        }

        Exchange exchange = strategyRouter.getExchange();
        dodoToken.transfer(address(exchange), dodoTokenBalance);

        uint256 tokenAAmountToCompound = exchange.swap(
            dodoTokenBalance,
            address(dodoToken),
            address(tokenA),
            address(this)
        );

        tokenAAmountToCompound = collectProtocolCommission(tokenAAmountToCompound);

        tokenA.approve(address(pool), tokenAAmountToCompound);
        uint256 lpTokens = depositFn(tokenAAmountToCompound);

        lpToken.approve(address(farm), lpTokens);
        farm.deposit(address(lpToken), lpTokens);
    }

    function totalTokens()
    external
    view
    override
    returns (uint256 totalTokens)
    {
        totalTokens = farm.getUserLpBalance(lpToken, address(this))
            .mul(
                expectedTargetFn()
            )
            .div(
                lpToken.totalSupply()
            )
        ;
    }

    function withdrawAll()
    external
    override
    onlyOwner
    returns (uint256 amountWithdrawn)
    {
        farm.withdrawAll(address(lpToken));

        uint256 lpTokenBalance = lpToken.balanceOf(address(this));
        lpToken.approve(address(pool), lpTokenBalance);
        amountWithdrawn = withdrawFn(lpTokenBalance);

        uint256 dodoTokenBalance = dodoToken.balanceOf(address(this));
        if (dodoTokenBalance > 0) {
            Exchange exchange = strategyRouter.getExchange();
            dodoToken.transfer(address(exchange), dodoTokenBalance);

            uint256 rewardsInTokenA = exchange.swap(
                dodoTokenBalance,
                address(dodoToken),
                address(tokenA),
                address(this)
            );
            rewardsInTokenA = collectProtocolCommission(rewardsInTokenA);

            amountWithdrawn += rewardInTokenA;
        }
    }

    function collectProtocolCommission(uint256 amountA)
    private
    returns (uint256 amountAAfterFee)
    {
        uint256 feePercent = strategyRouter.feePercent();
        address feeAddress = strategyRouter.feeAddress();
        uint256 fee = amountA.mul(feePercent).div(PERCENT_DENOMINATOR);

        tokenA.transfer(feeAddress, fee);

        return amountA.sub(fee);
    }

    function getBaseExpectedTarget()
    private
    view
    returns (uint256 baseExpectedTarget)
    {
        (baseExpectedTarget, ) = pool.getExpectedTarget();
    }

    function getQuoteExpectedTarget()
    private
    view
    returns (uint256 quoteExpectedTarget)
    {
        (, quoteExpectedTarget) = pool.getExpectedTarget();
    }
}
