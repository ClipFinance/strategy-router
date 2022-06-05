# Solidity API

## ReceiptNFT

### getReceipt

```solidity
function getReceipt(uint256 tokenId) external view returns (struct ReceiptNFT.ReceiptData)
```

Get info (ReceiptData) noted in NFT.

### getTokensOfOwner

```solidity
function getTokensOfOwner(address ownerAddr) public view returns (uint256[] tokens)
```

Get all tokens owned by user, to be used off-chain.

