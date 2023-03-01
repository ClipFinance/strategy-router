//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IDodoMine {
    function deposit(address _lpToken, uint256 _amount) external;

    function withdraw(address _lpToken, uint256 _amount) external;

    function withdrawAll(address _lpToken) external;

    function claim(address _lpToken) external;

    function getUserLpBalance(address _lpToken, address _user)
        external
        view
        returns (uint256);

    function getPendingReward(address _lpToken, address _user)
        external
        view
        returns (uint256);
}
