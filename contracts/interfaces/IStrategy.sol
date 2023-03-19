//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;


interface IStrategy {


    /// @notice Token used to deposit to strategy.
    function depositToken() external view returns (address);

    /// @notice Deposit token to strategy.
    function deposit(uint256 amount) external;

    /// @notice Withdraw tokens from strategy.
    /// @dev Max withdrawable amount is returned by totalTokens.
    function withdraw(uint256 amount) external returns (uint256 amountWithdrawn);

    /// @notice Harvest rewards and reinvest them.
    function compound() external;

    /// @notice Approximated amount of token on the strategy.
    function totalTokens() external view returns (uint256);

    /// @notice Withdraw all tokens from strategy.
    function withdrawAll() external returns (uint256 amountWithdrawn);

    /// @notice Get hardcap target value
    function getHardcardTargetInToken() view external returns (uint256);

    /// @notice Set allowed deviation from target value
    function getHardcardDeviationInBps() view external returns (uint16);

    /// @notice Get data on satisfying hard limits
    function getCapacityData() view external returns (bool limitReached, uint256 underflow, uint256 overflow);
}