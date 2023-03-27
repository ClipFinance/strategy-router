//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IStargateRouter.sol";
import "../interfaces/IStargateFarm.sol";
import "../interfaces/IStargatePool.sol";
import "../StrategyRouter.sol";

// import "hardhat/console.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract StargateBase is UUPSUpgradeable, OwnableUpgradeable, IStrategy {
    using SafeERC20 for IERC20;
    using SafeERC20 for IStargatePool;

    error CallerUpgrader();
    error InvalidInput();
    error NotAllAssetsWithdrawn();
    error DepositAmountExceedsBalance();

    uint256 private constant PERCENT_DENOMINATOR = 10000;

    address internal upgrader;

    IERC20 private immutable token;
    StrategyRouter public immutable strategyRouter;
    IERC20 public immutable stgToken;
    IStargateRouter public immutable stargateRouter; // Stargate router
    IStargateFarm public immutable stargateFarm;
    IStargatePool public immutable lpToken;
    uint256 public immutable poolId; // Stargate router
    uint256 public immutable farmId; // Stargate farm id

    modifier onlyUpgrader() {
        if (msg.sender != address(upgrader)) revert CallerUpgrader();
        _;
    }

    constructor(
        StrategyRouter _strategyRouter,
        IERC20 _token,
        IStargatePool _lpToken,
        IERC20 _stgToken,
        IStargateRouter _stargateRouter,
        IStargateFarm _stargateFarm,
        uint256 _poolId,
        uint256 _farmId
    ) {
        strategyRouter = _strategyRouter;
        if (_lpToken.token() != address(_token)) revert InvalidInput();
        token = _token;
        stgToken = _stgToken;
        lpToken = _lpToken;
        stargateRouter = _stargateRouter;
        stargateFarm = _stargateFarm;
        poolId = _poolId;
        farmId = _farmId;

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
        returns (uint256)
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

            if (lpToRemove != 0) {
                _withdrawFromFarm(lpToRemove);
                _sellReward();
                currTokenBalance = token.balanceOf(address(this));
            }

            if (currTokenBalance < strategyTokenAmountToWithdraw) {
                strategyTokenAmountToWithdraw = currTokenBalance;
            } else {
                _deposit(currTokenBalance - strategyTokenAmountToWithdraw);
            }
        }

        token.safeTransfer(msg.sender, strategyTokenAmountToWithdraw);

        return strategyTokenAmountToWithdraw;
    }

    function compound() external override onlyOwner {
        // inside withdraw happens STG rewards collection
        stargateFarm.withdraw(farmId, 0);

        _sellReward();
        _deposit(token.balanceOf(address(this)));
    }

    function totalTokens() public view override returns (uint256) {
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
        (uint256 amount, ) = stargateFarm.userInfo(farmId, address(this));

        if (amount != 0) {
            _withdrawFromFarm(amount);
        }

        _sellReward();

        amountWithdrawn = token.balanceOf(address(this));

        if (amountWithdrawn != 0) {
            token.safeTransfer(msg.sender, amountWithdrawn);
        }

        if (totalTokens() > 0) revert NotAllAssetsWithdrawn();
    }

    function _deposit(uint256 amount) internal {
        if (amount == 0 || _amountLDtoLP(amount) == 0) return; // don't proceed if provided not enough amount to stake less than 1 LP token
        if (amount > token.balanceOf(address(this))) revert DepositAmountExceedsBalance();

        token.safeApprove(address(stargateRouter), amount);
        stargateRouter.addLiquidity(poolId, amount, address(this));

        // remove dust allowance
        if (token.allowance(address(this), address(stargateRouter)) > 0) {
            token.safeApprove(address(stargateRouter), 0);
        }

        uint256 lpBalance = lpToken.balanceOf(address(this));

        lpToken.safeApprove(address(stargateFarm), lpBalance);
        stargateFarm.deposit(farmId, lpBalance);
    }

    function _withdrawFromFarm(uint256 _lpAmount) internal {
        stargateFarm.withdraw(farmId, _lpAmount);
        stargateRouter.instantRedeemLocal(
            uint16(poolId),
            _lpAmount,
            address(this)
        );
        uint remainLp = lpToken.balanceOf(address(this));
        if (remainLp != 0) {
            lpToken.safeApprove(address(stargateFarm), remainLp);
            stargateFarm.deposit(farmId, remainLp);
        }
    }

    function _sellReward() private returns (uint256 received) {
        uint256 stgBalance = stgToken.balanceOf(address(this));

        if (stgBalance != 0) {
            Exchange exchange = strategyRouter.getExchange();
            uint256 amountOut = exchange.getAmountOut(
                stgBalance,
                address(stgToken),
                address(token)
            );

            if (_amountLDtoSD(amountOut) == 0) return 0;

            stgToken.transfer(address(exchange), stgBalance);
            received = exchange.swap(
                stgBalance,
                address(stgToken),
                address(token),
                address(this)
            );
        }
    }

    function _amountLDtoLP(uint256 _amountLD)
        internal
        view
        returns (uint256 _amountLP)
    {
        uint256 _amountSD = _amountLDtoSD(_amountLD);
        return _amountSDtoLP(_amountSD);
    }

    function _amountLDtoSD(uint256 _amountLD)
        internal
        view
        returns (uint256 _amountSD)
    {
        _amountSD = _amountLD / lpToken.convertRate();
    }

    function _amountSDtoLP(uint256 _amountSD)
        internal
        view
        returns (uint256 _amountLP)
    {
        return (_amountSD * lpToken.totalSupply()) /
            lpToken.totalLiquidity();
    }
}
