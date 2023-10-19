//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IRouterAdmin {
    function redeemReceiptsToSharesByModerators(uint256[] calldata receiptIds) external;
}
