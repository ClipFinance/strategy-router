//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface ISharesToken {
    function balanceOf(address account) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function transfer(address to, uint256 amount) external;

    function transferFromAutoApproved(address from, address to, uint256 amount) external;

    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;
}
