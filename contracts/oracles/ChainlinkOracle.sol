pragma solidity ^0.8.4;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@chainlink/contracts/src/v0.8/Denominations.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IUsdOracle.sol";

// import "hardhat/console.sol";

contract ChainlinkOracle is IUsdOracle, UUPSUpgradeable, OwnableUpgradeable {
    error StaleChainlinkPrice();
    error BadPrice();

    // address public constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    // address public constant BUSDT = 0x55d398326f99059fF775485246999027B3197955;
    // address public constant DAI = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
    // address public constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;

    // token address => token/usd feed address
    mapping(address => address) public feeds;

    // constructor() {
    //     feeds[BUSD][Denominations.USD] = 0xcBb98864Ef56E9042e7d2efef76141f15731B82f;
    //     feeds[USDC][Denominations.USD] = 0x51597f405303C4377E36123cBc172b13269EA163;
    // }

    constructor() {
        // lock implementation
        _disableInitializers();
    }

    function initialize() external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @notice Set multiple price feed for token / usd.
    function setPriceFeeds(address[] calldata token, address[] calldata feed) external onlyOwner {
        for (uint256 i = 0; i < token.length; i++) {
            feeds[token[i]] = feed[i];
        }
    }

    /**
     * Returns the latest token / usd price and its decimals
     */
    function getTokenUsdPrice(address base) public view override returns (uint256 price, uint8 decimals) {
        AggregatorV3Interface feed = AggregatorV3Interface(feeds[base]);

        (, int256 _price, , uint256 updatedAt, ) = feed.latestRoundData();

        if (updatedAt <= block.timestamp - 24 hours) revert StaleChainlinkPrice();
        if (_price <= 0) revert BadPrice();

        return (uint256(_price), feed.decimals());
    }
}
