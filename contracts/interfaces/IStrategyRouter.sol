//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "./IUsdOracle.sol";
import "./IExchange.sol";
import "./IReceiptNFT.sol";
import "./ISharesToken.sol";
import "./IBatch.sol";

interface IStrategyRouter {
    function getStrategiesCount() external view returns (uint256);

    function getStrategyDepositToken(uint256 i) external view returns (address);

    function supportsToken(address tokenAddress) external view returns (bool isSupported);

    function calculateSharesUsdValue(uint256 amountShares) external view returns (uint256 amountUsd);

    function withdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 shares,
        uint256 minTokenAmountToWithdraw,
        bool performCompound
    ) external returns (uint256 withdrawnAmount);

    function setAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        ISharesToken _sharesToken,
        IBatch _batch,
        IReceiptNFT _receiptNft
    ) external;

    function redeemReceiptsToSharesByModerators(uint256[] calldata receiptIds) external;

    function setSupportedToken(address tokenAddress, bool supported, address idleStrategy) external;

    function setFeesCollectionAddress(address moderator) external;

    function setAllocationWindowTime(uint256 timeInSeconds) external;

    function setIdleStrategy(uint256 i, address idleStrategy) external;

    function addStrategy(address strategyAddress, uint256 weight) external;

    function removeStrategy(uint256 strategyId) external;

    function rebalanceStrategies() external returns (uint256[] memory balances);

    function updateStrategy(uint256 strategyId, uint256 weight) external;

    function getExchange() external view returns (IExchange);

    function getStrategies() external view returns (StrategyInfo[] memory, uint256);
}
