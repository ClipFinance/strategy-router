//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "hardhat/console.sol";

contract ReceiptNFT is ERC721("Receipt NFT", "RECEIPT"), Ownable {
    
    struct ReceiptData {
        uint256 cycleId;
        uint256 amount;
        address token;
    }

    uint256 private _tokenIdCounter;

    mapping(uint256 => ReceiptData) public receipts;

    constructor () { }

    function viewReceipt(uint256 tokenId) external view returns (ReceiptData memory) {
        return receipts[tokenId];
    }

    function mint(
        uint256 cycleId, 
        uint256 amount, 
        address token, 
        address wallet
    ) external onlyOwner {
        uint256 _tokenId = _tokenIdCounter;
        receipts[_tokenId] = ReceiptData({
            cycleId: cycleId,
            amount: amount,
            token: token
        });
        _mint(wallet, _tokenId);
        _tokenIdCounter++;
    }

    function burn(uint256 tokenId) external onlyOwner {
        _burn(tokenId);
        delete receipts[tokenId];
    } 
}
