// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import "@chainlink/contracts/src/v0.8/Denominations.sol";

contract ChainlinkOracle {

    error StaleChainlinkPrice();
    error NegativePrice();

    FeedRegistryInterface internal registry;

    /**
     * Feed Registry Addresses
     * Kovan: 0xAa7F6f7f507457a1EE157fE97F6c7DB2BEec5cD0
     * Mainnet: 0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf
     */
    constructor(address _registry) {
        registry = FeedRegistryInterface(_registry);
    }

    /**
     * Returns the ETH / USD price
     */
    function getEthUsdPrice() public view returns (int) {
        (
            /* uint80 roundID */,
            int price,
            /* uint startedAt */,
            /* uint timeStamp */,
            /* uint80 answeredInRound */
        ) = registry.latestRoundData(Denominations.ETH, Denominations.USD);
        return price;
    }

    /**
     * Returns the latest asset / usd price and its decimals
     */
    function getAssetUsdPrice(address base) public view returns (uint price, uint8 decimals) {
        (
            /* uint80 roundID */, 
            int _price,
            /* uint startedAt */,
            uint updatedAt,
            /* uint80 answeredInRound */
        ) = registry.latestRoundData(base, Denominations.USD);

        if(updatedAt <= block.timestamp - 24 hours) revert StaleChainlinkPrice();
        if(price < 0) revert NegativePrice();
        
        return (uint(_price), registry.decimals(base, Denominations.USD));
    }
}