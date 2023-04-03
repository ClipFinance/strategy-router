//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IStargateFarm {
    function deposit(uint256 _pid, uint256 _amount) external;

    function withdraw(uint256 _pid, uint256 _amount) external;

    function pendingStargate(uint256 _pid, address _user)
        external
        view
        returns (uint256);

    function owner() external view returns (address);

    function poolInfo(uint256)
        external
        view
        returns (
            address lpToken,
            uint256 allocPoint,
            uint256 lastRewardBlock,
            uint256 accStargatePerShare
        );

    function poolLength() external view returns (uint256);

    function userInfo(uint256, address)
        external
        view
        returns (uint256 amount, uint256 rewardDebt);

    function stargate() external view returns (address);

    function router() external view returns (address);
}
