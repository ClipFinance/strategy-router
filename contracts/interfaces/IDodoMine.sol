//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IDodoMine {
    function deposit(address _lpToken, uint256 _amount) public;
    function withdraw(address _lpToken, uint256 _amount) public;
    function withdrawAll(address _lpToken) public;
    function claim(address _lpToken) public;
    function getUserLpBalance(address _lpToken, address _user) public view returns (uint256);
}
