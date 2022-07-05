pragma solidity ^0.8.4;

import "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import "@chainlink/contracts/src/v0.8/Denominations.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IUsdOracle.sol";

// import "hardhat/console.sol";

contract FakeOracle is IUsdOracle, Ownable {
    error StaleChainlinkPrice();
    error BadPrice();

    struct Price {
        uint256 price;
        uint8 decimals;
    }

    // addresses from bnb chain!
    address public constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant BUSDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant DAI = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
    address public constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    mapping(address => mapping(address => Price)) prices;

    constructor() {
        prices[USDC][Denominations.USD] = Price(100_100_000, 8); // 1.001$
        prices[BUSD][Denominations.USD] = Price(10_000_000_000, 10); // 1$
    }

    // set fake prices
    function setPrice(address base, uint256 price) public {
        prices[base][Denominations.USD] = Price(price, ERC20(base).decimals());
    }

    /**
     * Returns the latest token / usd price and its decimals
     */
    function getTokenUsdPrice(address base) public view override returns (uint256 price, uint8 decimals) {
        price = prices[base][Denominations.USD].price;
        decimals = prices[base][Denominations.USD].decimals;
    }
}
