//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// import "hardhat/console.sol";

contract ReceiptNFT is ERC721, AccessControl, Initializable {
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    error NonExistingToken();
    error ReceiptAmountCanOnlyDecrease();
    error NotManager();
    /// Invalid query range (`start` >= `stop`).
    error InvalidQueryRange();

    struct ReceiptData {
        uint256 cycleId;
        uint256 amount; // in token
        address token;
    }

    uint256 private _receiptsCounter;

    mapping(uint256 => ReceiptData) public receipts;

    constructor() ERC721("Receipt NFT", "RECEIPT") {}

    function initialize(address strategyRouter, address batching) external initializer {
        _grantRole(MANAGER_ROLE, strategyRouter);
        _grantRole(MANAGER_ROLE, batching);
    }

    /// Override required by solidity
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721, AccessControl) returns (bool) {
        return ERC721.supportsInterface(interfaceId);
    }

    function setAmount(uint256 tokenId, uint256 amount) external onlyRole(MANAGER_ROLE) {
        if (!_exists(tokenId)) revert NonExistingToken();
        if (receipts[tokenId].amount < amount) revert ReceiptAmountCanOnlyDecrease();
        receipts[tokenId].amount = amount;
    }

    function mint(
        uint256 cycleId,
        uint256 amount,
        address token,
        address wallet
    ) external onlyRole(MANAGER_ROLE) {
        uint256 _receiptId = _receiptsCounter;
        receipts[_receiptId] = ReceiptData({cycleId: cycleId, token: token, amount: amount});
        _mint(wallet, _receiptId);
        _receiptsCounter++;
    }

    function burn(uint256 tokenId) external onlyRole(MANAGER_ROLE) {
        _burn(tokenId);
        delete receipts[tokenId];
    }

    /// @notice Get receipt data recorded in NFT.
    function getReceipt(uint256 tokenId) external view returns (ReceiptData memory) {
        if (_exists(tokenId) == false) revert NonExistingToken();
        return receipts[tokenId];
    }

    /**
     * @dev Returns an array of token IDs owned by `owner`,
     * in the range [`start`, `stop`].
     *
     * This function allows for tokens to be queried if the collection
     * grows too big for a single call of {ReceiptNFT-getTokensOfOwner}.
     *
     * Requirements:
     *
     * - `start <= tokenId < stop`
     */
    function getTokensOfOwnerIn(
        address owner,
        uint256 start,
        uint256 stop
    ) public view returns (uint256[] memory tokenIds) {
        unchecked {
            if (start >= stop) revert InvalidQueryRange();
            uint256 tokenIdsIdx;
            uint256 stopLimit = _receiptsCounter;
            // Set `stop = min(stop, stopLimit)`.
            if (stop > stopLimit) {
                // At this point `start` could be greater than `stop`.
                stop = stopLimit;
            }
            uint256 tokenIdsMaxLength = balanceOf(owner);
            // Set `tokenIdsMaxLength = min(balanceOf(owner), stop - start)`,
            // to cater for cases where `balanceOf(owner)` is too big.
            if (start < stop) {
                uint256 rangeLength = stop - start;
                if (rangeLength < tokenIdsMaxLength) {
                    tokenIdsMaxLength = rangeLength;
                }
            } else {
                tokenIdsMaxLength = 0;
            }
            tokenIds = new uint256[](tokenIdsMaxLength);
            if (tokenIdsMaxLength == 0) {
                return tokenIds;
            }

            // We want to scan tokens in range [start <= tokenId < stop].
            // And if whole range is owned by user or when tokenIdsMaxLength is less than range,
            // then we also want to exit loop when array is full.
            uint256 tokenId = start;
            while (tokenId != stop && tokenIdsIdx != tokenIdsMaxLength) {
                if (_exists(tokenId) && ownerOf(tokenId) == owner) {
                    tokenIds[tokenIdsIdx++] = tokenId;
                }
                tokenId++;
            }

            // If after scan we haven't filled array, then downsize the array to fit.
            assembly {
                mstore(tokenIds, tokenIdsIdx)
            }
            return tokenIds;
        }
    }

    /**
     * @dev Returns an array of token IDs owned by `owner`.
     *
     * This function scans the ownership mapping and is O(totalSupply) in complexity.
     * It is meant to be called off-chain.
     *
     * See {ReceiptNFT-getTokensOfOwnerIn} for splitting the scan into
     * multiple smaller scans if the collection is large enough to cause
     * an out-of-gas error.
     */
    function getTokensOfOwner(address owner) public view returns (uint256[] memory tokenIds) {
        uint256 balance = balanceOf(owner);
        tokenIds = new uint256[](balance);
        uint256 tokenId;

        while (balance > 0) {
            if (_exists(tokenId) && ownerOf(tokenId) == owner) {
                tokenIds[--balance] = tokenId;
            }
            tokenId++;
        }
    }
}
