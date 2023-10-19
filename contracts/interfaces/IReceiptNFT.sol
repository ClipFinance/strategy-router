//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import {ReceiptData} from "../lib/Structs.sol";

interface IReceiptNFT {
    function ownerOf(uint256 receiptId) external view returns (address owner);

    function getReceipt(uint256 receiptId) external view returns (ReceiptData memory);

    function mint(uint256 cycleId, uint256 amount, address token, address wallet) external;

    function burn(uint256 receiptId) external;

    function setAmount(uint256 receiptId, uint256 amount) external;
}
