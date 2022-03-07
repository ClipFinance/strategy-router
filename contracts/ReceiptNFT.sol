//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "hardhat/console.sol";

contract ReceiptNFT is ERC721("Receipt NFT", "RECEIPT"), Ownable {

    error NonexistenToken();
    
    struct ReceiptData {
        uint256 cycleId;
        uint256 amount;
    }

    uint256 private _tokenIdCounter;

    mapping(uint256 => ReceiptData) public receipts;

    constructor () { }


    function viewReceipt(uint256 tokenId) 
        external 
        view 
        returns (ReceiptData memory) 
    {
        if(_exists(tokenId) == false) revert NonexistenToken();
        return receipts[tokenId];
    }
    
    /// @notice Get all tokens owned by user, to be used off-chain.
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

    function setAmount(uint256 tokenId, uint256 amount) external onlyOwner {
        if (_exists(tokenId) == false) revert NonexistenToken();
        receipts[tokenId].amount = amount;
    } 

    function mint(
        uint256 cycleId, 
        uint256 amount, 
        address wallet
    ) external onlyOwner {
        uint256 _tokenId = _tokenIdCounter;
        receipts[_tokenId] = ReceiptData({
            cycleId: cycleId,
            amount: amount
        });
        _mint(wallet, _tokenId);
        _tokenIdCounter++;
    }

    function burn(uint256 tokenId) external onlyOwner {
        _burn(tokenId);
        delete receipts[tokenId];
    } 

}
