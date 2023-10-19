//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import {ReceiptData} from "./lib/Structs.sol";

contract ReceiptNFT is ERC721Upgradeable, UUPSUpgradeable, OwnableUpgradeable {
    using Strings for uint256;

    uint256 private _receiptsCounter;

    mapping(uint256 => ReceiptData) public receipts;
    mapping(address => bool) public managers;

    string public uri;
    bool public dynamicURI;

    modifier onlyManager() {
        if (managers[msg.sender] == false) revert NotManager();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        __ERC721_init("Proof Of Deposit", "CLIP-V1-POD");

        // decode initialize data
        (address strategyRouter, address batch, string memory link, bool isDynamic) = abi.decode(
            initializeData,
            (address, address, string, bool)
        );

        setBaseURI(link, isDynamic);

        managers[strategyRouter] = true;
        managers[batch] = true;

        // transer ownership and set proxi admin to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setAmount(uint256 receiptId, uint256 amount) external onlyManager {
        if (!_exists(receiptId)) revert NonExistingToken();
        if (receipts[receiptId].tokenAmountUniform < amount) revert ReceiptAmountCanOnlyDecrease();
        receipts[receiptId].tokenAmountUniform = amount;
        emit SetAmount(receiptId, amount);
    }

    function mint(uint256 cycleId, uint256 amount, address token, address wallet) external onlyManager {
        uint256 _receiptId = _receiptsCounter;
        receipts[_receiptId] = ReceiptData({cycleId: cycleId, token: token, tokenAmountUniform: amount});
        _mint(wallet, _receiptId);
        _receiptsCounter++;
    }

    function burn(uint256 receiptId) external onlyManager {
        if (!_exists(receiptId)) revert NonExistingToken();
        _burn(receiptId);
        delete receipts[receiptId];
    }

    /// @notice Get receipt data recorded in NFT.
    function getReceipt(uint256 receiptId) external view returns (ReceiptData memory) {
        if (_exists(receiptId) == false) revert NonExistingToken();
        return receipts[receiptId];
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
     * - `start <= receiptId < stop`
     */
    function getTokensOfOwnerIn(
        address owner,
        uint256 start,
        uint256 stop
    ) public view returns (uint256[] memory receiptIds) {
        unchecked {
            if (start >= stop) revert InvalidQueryRange();
            uint256 receiptIdsIdx;
            uint256 stopLimit = _receiptsCounter;
            // Set `stop = min(stop, stopLimit)`.
            if (stop > stopLimit) {
                // At this point `start` could be greater than `stop`.
                stop = stopLimit;
            }
            uint256 receiptIdsMaxLength = balanceOf(owner);
            // Set `receiptIdsMaxLength = min(balanceOf(owner), stop - start)`,
            // to cater for cases where `balanceOf(owner)` is too big.
            if (start < stop) {
                uint256 rangeLength = stop - start;
                if (rangeLength < receiptIdsMaxLength) {
                    receiptIdsMaxLength = rangeLength;
                }
            } else {
                receiptIdsMaxLength = 0;
            }
            receiptIds = new uint256[](receiptIdsMaxLength);
            if (receiptIdsMaxLength == 0) {
                return receiptIds;
            }

            // We want to scan tokens in range [start <= receiptId < stop].
            // And if whole range is owned by user or when receiptIdsMaxLength is less than range,
            // then we also want to exit loop when array is full.
            uint256 receiptId = start;
            while (receiptId != stop && receiptIdsIdx != receiptIdsMaxLength) {
                if (_exists(receiptId) && ownerOf(receiptId) == owner) {
                    receiptIds[receiptIdsIdx++] = receiptId;
                }
                receiptId++;
            }

            // If after scan we haven't filled array, then downsize the array to fit.
            assembly {
                mstore(receiptIds, receiptIdsIdx)
            }
            return receiptIds;
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
    function getTokensOfOwner(address owner) public view returns (uint256[] memory receiptIds) {
        uint256 balance = balanceOf(owner);
        receiptIds = new uint256[](balance);
        uint256 receiptId;

        while (balance > 0) {
            if (_exists(receiptId) && ownerOf(receiptId) == owner) {
                receiptIds[--balance] = receiptId;
            }
            receiptId++;
        }
    }

    function tokenURI(uint256 receiptId) public view virtual override returns (string memory) {
        if (!_exists(receiptId)) revert NonExistingToken();

        return dynamicURI != true ? uri : string(abi.encodePacked(uri, receiptId.toString()));
    }

    function setBaseURI(string memory link, bool dynamic) public onlyOwner {
        uri = link;
        dynamicURI = dynamic;
        emit BaseURISet(link, dynamic);
    }

    /* ERRORS */
    error NonExistingToken();
    error ReceiptAmountCanOnlyDecrease();
    error NotManager();
    /// Invalid query range (`start` >= `stop`).
    error InvalidQueryRange();

    /* EVENTS */

    event SetAmount(uint256 indexed receiptId, uint256 amount);
    event BaseURISet(string newBaseURI, bool isDynamicURI);
}
