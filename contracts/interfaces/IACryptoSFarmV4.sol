//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IACryptoSFarmV4 {
    struct AdditionalPoolReward {
        address rewardToken;
        address from;
        uint256 rewardPerBlock;
    }

    struct AdditionalReward {
        address to;
        uint256 reward;
    }

    event Deposit(
        address indexed user,
        address indexed lpToken,
        uint256 amount
    );
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );
    event Withdraw(
        address indexed user,
        address indexed lpToken,
        uint256 amount
    );

    function REWARD_DENOMINATOR() external view returns (uint256);

    function addAdditionalPoolRewards(
        address _lpToken,
        AdditionalPoolReward[] memory _additionalPoolRewards
    ) external;

    function addAdditionalRewards(AdditionalReward[] memory _additionalRewards)
        external;

    function additionalPoolRewards(address, uint256)
        external
        view
        returns (
            address rewardToken,
            address from,
            uint256 rewardPerBlock
        );

    function additionalPoolRewardsLength(address _lpToken)
        external
        view
        returns (uint256);

    function additionalRewards(uint256)
        external
        view
        returns (address to, uint256 reward);

    function boostFactor() external view returns (uint256);

    function boostToken() external view returns (address);

    function calculateWeight(address _lpToken, address _user)
        external
        view
        returns (uint256);

    function deleteAdditionalPoolRewards(address _lpToken) external;

    function deleteAdditionalRewards() external;

    function deposit(address _lpToken, uint256 _amount) external;

    function harvest(address _lpToken) external;

    function harvestFee() external view returns (uint256);

    function harvestFeeAddress() external view returns (address);

    function maxBoost() external view returns (uint256);

    function owner() external view returns (address);

    function pendingSushi(address _lpToken, address _user)
        external
        view
        returns (uint256);

    function poolInfo(address)
        external
        view
        returns (
            uint256 totalWeight,
            uint256 allocPoint,
            uint256 lastRewardBlock,
            uint256 accSushiPerShare,
            uint256 withdrawalFee
        );

    function renounceOwnership() external;

    function set(
        address _lpToken,
        uint256 _allocPoint,
        uint256 _withdrawalFee
    ) external;

    function setBoostFactor(uint256 _boostFactor) external;

    function setBoostToken(address _boostToken) external;

    function setHarvestFee(uint256 _harvestFee) external;

    function setHarvestFeeAddress(address _harvestFeeAddress) external;

    function setMaxBoost(uint256 _maxBoost) external;

    function setStrategist(address _strategist) external;

    function setSushiPerBlock(uint256 _sushiPerBlock) external;

    function strategist() external view returns (address);

    function sushi() external view returns (address);

    function sushiPerBlock() external view returns (uint256);

    function totalAllocPoint() external view returns (uint256);

    function transferOwnership(address newOwner) external;

    function updatePool(address _lpToken) external;

    function userInfo(address, address)
        external
        view
        returns (
            uint256 amount,
            uint256 weight,
            uint256 rewardDebt,
            uint256 rewardCredit
        );

    function withdraw(address _lpToken, uint256 _amount) external;
}
