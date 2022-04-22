# Solidity API

## ReceiptNFT

### viewReceipt

```solidity
function viewReceipt(uint256 tokenId) external view returns (struct ReceiptNFT.ReceiptData)
```

Get info (ReceiptData) noted in NFT.

### walletOfOwner

```solidity
function walletOfOwner(address ownerAddr) public view returns (uint256[] tokens)
```

Get all tokens owned by user, to be used off-chain.

