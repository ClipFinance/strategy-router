//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import {TokenPrice, StrategyInfo, IdleStrategyInfo} from "../lib/Structs.sol";

interface IBatch {
    function getSupportedTokensWithPriceInUsd() external view returns (TokenPrice[] memory supportedTokenPrices);

    function getBatchValueUsdWithoutOracleCalls(
        TokenPrice[] calldata supportedTokenPrices
    ) external view returns (uint256 totalBalanceUsd, uint256[] memory supportedTokenBalancesUsd);

    function getSupportedTokens() external view returns (address[] memory);

    function getBatchValueUsd() external view returns (uint256 totalBalance, uint256[] memory balances);

    function supportsToken(address tokenAddress) external view returns (bool isSupported);

    function rebalance(
        TokenPrice[] calldata supportedTokenPrices,
        StrategyInfo[] calldata strategies,
        uint256 remainingToAllocateStrategiesWeightSum,
        IdleStrategyInfo[] calldata idleStrategies
    ) external;

    function withdraw(
        address receiptOwner,
        uint256[] calldata receiptIds,
        uint256 _currentCycleId
    )
        external
        returns (uint256[] memory _receiptIds, address[] memory _tokens, uint256[] memory _withdrawnTokenAmounts);

    function deposit(
        address depositor,
        address depositToken,
        uint256 depositAmount,
        uint256 _currentCycleId
    ) external payable returns (uint256 depositFeeAmount);

    function addSupportedToken(address tokenAddress) external;

    function removeSupportedToken(
        address tokenAddress
    ) external returns (bool wasRemovedFromTail, address formerTailTokenAddress, uint256 newIndexOfFormerTailToken);
}
