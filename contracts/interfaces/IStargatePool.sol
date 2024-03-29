//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStargatePool is IERC20 {
    function deltaCredit() external view returns (uint256);

    function amountLPtoLD(uint256 _amountLP) external view returns (uint256);

    function convertRate() external view returns (uint256);

    function totalLiquidity() external view returns (uint256);

    function token() external view returns (address);
}
