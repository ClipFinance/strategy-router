//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IStargateRouter.sol";
import "../interfaces/IStargateFarm.sol";
import "../interfaces/IStargatePool.sol";
import "../StrategyRouter.sol";

contract StargateStrategy is UUPSUpgradeable, OwnableUpgradeable, IStrategy {
    using SafeERC20 for IERC20;
    using SafeERC20 for IStargatePool;

    error CallerUpgrader();

    uint256 private constant PERCENT_DENOMINATOR = 10000;

    address internal upgrader;

    IERC20 public token;
    StrategyRouter public strategyRouter;
    IERC20 public stgToken;
    IStargateRouter public stargateRouter; // Stargate router
    IStargateFarm public stargateFarm;
    IStargatePool public lpToken;
    uint256 public poolId; // Stargate router
    uint256 public farmId; // Stargate farm id

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    function initialize(
        address _upgrader,
        StrategyRouter _strategyRouter,
        IStargateFarm _stargateFarm,
        uint256 _poolId,
        IERC20 _token,
        IStargatePool _lpToken
    ) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        upgrader = _upgrader;

        strategyRouter = _strategyRouter;
        poolId = _poolId;
        token = _token;

        stargateFarm = _stargateFarm;
        stgToken = IERC20(_stargateFarm.stargate());
        stargateRouter = IStargateRouter(_stargateFarm.router());
        lpToken = _lpToken;
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

    function _deposit(uint256 amount) internal {
        token.safeApprove(address(stargateRouter), amount);
        stargateRouter.addLiquidity(poolId, amount, address(this));

        uint256 lpBalance = lpToken.balanceOf(address(this));

        lpToken.safeApprove(address(stargateFarm), lpBalance);
        stargateFarm.deposit(farmId, lpBalance);
    }

    function withdraw(uint256 strategyTokenAmountToWithdraw)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        uint256 currTokenBalance = token.balanceOf(address(this));

        if (strategyTokenAmountToWithdraw > currTokenBalance) {
            uint256 lpToRemove = _amountLDtoLP(
                strategyTokenAmountToWithdraw - currTokenBalance
            );
            (uint256 lpAmount, ) = stargateFarm.userInfo(farmId, address(this));
            if (lpToRemove > lpAmount) {
                lpToRemove = lpAmount;
            }

            _withdrawFromFarm(lpToRemove);
        }

        currTokenBalance = token.balanceOf(address(this));
        amountWithdrawn = currTokenBalance > strategyTokenAmountToWithdraw
            ? strategyTokenAmountToWithdraw
            : currTokenBalance;

        token.safeTransfer(msg.sender, amountWithdrawn);
    }

    function compound() external override onlyOwner {
        // inside withdraw happens STG rewards collection
        stargateFarm.withdraw(farmId, 0);

        uint256 swappedAmount = _sellReward();

        if (swappedAmount != 0) {
            _deposit(swappedAmount);
        }
    }

    function totalTokens() external view override returns (uint256) {
        (uint256 lpAmount, ) = stargateFarm.userInfo(farmId, address(this));
        uint256 stakedTokenAmount = IStargatePool(address(lpToken))
            .amountLPtoLD(lpAmount);

        return token.balanceOf(address(this)) + stakedTokenAmount;
    }

    function withdrawAll()
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        uint256 currTokenBalance = token.balanceOf(address(this));
        (uint256 amount, ) = stargateFarm.userInfo(farmId, address(this));

        if (amount != 0) {
            _withdrawFromFarm(amount);
        }

        _sellReward();

        amountWithdrawn = token.balanceOf(address(this)) - currTokenBalance;
    }

    function _withdrawFromFarm(uint256 _lpAmount) internal {
        stargateFarm.withdraw(farmId, _lpAmount);
        stargateRouter.instantRedeemLocal(
            uint16(poolId),
            _lpAmount,
            address(this)
        );
    }

    function _sellReward() private returns (uint256 received) {
        uint256 stgBalance = stgToken.balanceOf(address(this));

        if (stgBalance != 0) {
            Exchange exchange = strategyRouter.getExchange();
            stgToken.transfer(address(exchange), stgBalance);
            received = exchange.swap(
                stgBalance,
                address(stgToken),
                address(token),
                address(this)
            );

            _collectProtocolCommission(received);
        }
    }

    function _collectProtocolCommission(uint256 amount)
        private
        returns (uint256 amountAfterFee)
    {
        uint256 feePercent = StrategyRouter(strategyRouter).feePercent();
        address feeAddress = StrategyRouter(strategyRouter).feeAddress();
        uint256 feeAmount = (amount * feePercent) / PERCENT_DENOMINATOR;

        token.transfer(feeAddress, feeAmount);

        return (amount - feeAmount);
    }

    function _amountLDtoLP(uint256 _amountLD)
        internal
        view
        returns (uint256 _amountLP)
    {
        uint256 _amountSD = _amountLD / lpToken.convertRate();
        _amountLP =
            (_amountSD * lpToken.totalSupply()) /
            lpToken.totalLiquidity();
    }
}
