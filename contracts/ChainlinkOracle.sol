// // SPDX-License-Identifier: MIT
// pragma solidity ^0.8.4;

// import "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
// import "@chainlink/contracts/src/v0.8/Denominations.sol";
// import "@openzeppelin/contracts/access/Ownable.sol";

// // import "hardhat/console.sol";

// contract ChainlinkOracle is Ownable {
//     error StaleChainlinkPrice();
//     error BadPrice();


//     address public constant UST = 0x23396cF899Ca06c4472205fC903bDB4de249D6fC;
//     address public constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
//     address public constant BUSDT = 0x55d398326f99059fF775485246999027B3197955;
//     address public constant DAI = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
//     address public constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;

//     mapping(address => mapping(address => address)) feeds;

//     constructor() {
//         // feeds[0x23396cF899Ca06c4472205fC903bDB4de249D6fC][Denominations.USD] 
//     }

//     // function setPriceFeed(
//     //     address assetA,
//     //     address assetB,
//     //     address feed
//     // ) external onlyOwner {
//     //     feeds[assetA][assetB] = feed;
//     // }

//     /**
//      * Returns the latest asset / usd price and its decimals
//      */
//     function getAssetUsdPrice(address base)
//         public
//         view
//         returns (uint256 price, uint8 decimals)
//     {
//         (
//             ,
//             /* uint80 roundID */
//             int256 _price,
//             ,
//             /* uint startedAt */
//             uint256 updatedAt, /* uint80 answeredInRound */

//         ) = registry.latestRoundData(base, Denominations.USD);

//         // console.log("getAssetUsdPrice updatedAt %s, current block: %s", updatedAt, block.timestamp);

//         if (updatedAt <= block.timestamp - 24 hours)
//             revert StaleChainlinkPrice();
//         if (price <= 0) revert BadPrice();

//         return (uint256(_price), registry.decimals(base, Denominations.USD));
//     }
// }
