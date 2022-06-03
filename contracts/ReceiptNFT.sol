//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
// import "@openzeppelin/contracts/access/Ownable.sol";

// import "hardhat/console.sol";

contract ReceiptNFT is ERC721("Receipt NFT", "RECEIPT") {

    error NonExistingToken();
    error NotManager();
    error AlreadyInitialized();
    
    struct ReceiptData {
        uint256 cycleId;
        uint256 amount;
        address token;
    }

    uint256 private _tokenIdCounter;
    bool private initialized;

    mapping(uint256 => ReceiptData) public receipts;
    mapping(address => bool) public managers;

    modifier onlyManager {
        if(managers[msg.sender] == false) revert NotManager();
        _;
    }

    constructor () { }

    function init(address strategyRouter, address batching) external {
        if(initialized == true) revert AlreadyInitialized();
        managers[strategyRouter] = true;
        managers[batching] = true;
        initialized = true;
    }

    function setAmount(uint256 tokenId, uint256 amount) external onlyManager {
        if (!_exists(tokenId)) revert NonExistingToken();
        receipts[tokenId].amount = amount;
    }     

    function mint(
        uint256 cycleId, 
        uint256 amount, 
        address token, 
        address wallet
    ) external onlyManager {
        uint256 _tokenId = _tokenIdCounter;
        receipts[_tokenId] = ReceiptData({
            cycleId: cycleId,
            token: token,
            amount: amount
        });
        _mint(wallet, _tokenId);
        _tokenIdCounter++;
    }

    function burn(uint256 tokenId) external onlyManager {
        _burn(tokenId);
        delete receipts[tokenId];
    }

    /////// remove

    /// @notice Get receipt data recorded in NFT.
    function viewReceipt(uint256 tokenId)
        external 
        view 
        returns (ReceiptData memory) 
    {
        if(_exists(tokenId) == false) revert NonExistingToken();
        return receipts[tokenId];
    }
    
    /// @notice Get all tokens owned by user
    function walletOfOwner(address ownerAddr)
        public 
        view 
        returns (uint256[] memory tokens) 
    {
        uint256 balance = balanceOf(ownerAddr);
        tokens = new uint256[](balance);
        uint256 tokenId;

        while(balance > 0) {
            if (_exists(tokenId) && ownerOf(tokenId) == ownerAddr) {
                tokens[--balance] = tokenId; 
            }
            tokenId++;
        }
    }

    ///////// replace by

    function getReceipt(uint256 tokenId)
        external
        view
        returns (ReceiptData memory)
    {
        if(_exists(tokenId) == false) revert NonExistingToken();
        return receipts[tokenId];
    }

    function getTokensOwnedBy(address ownerAddr)
        public
        view
        returns (uint256[] memory tokens)
    {
        uint256 balance = balanceOf(ownerAddr);
        tokens = new uint256[](balance);
        uint256 tokenId;

        while(balance > 0) {
            if (_exists(tokenId) && ownerOf(tokenId) == ownerAddr) {
                tokens[--balance] = tokenId;
            }
            tokenId++;
        }
    }

}
