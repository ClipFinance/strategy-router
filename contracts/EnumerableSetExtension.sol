pragma solidity ^0.8.4;

import "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import "@chainlink/contracts/src/v0.8/Denominations.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IUsdOracle.sol";
// import {EnumerableSet as EnumSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

library EnumerableSetExtension {

    /// @dev Function will revert if address is not in set.
    function indexOf(EnumerableSet.AddressSet storage set, address value)
        internal
        view
        returns (uint256 index)
    {
        return set._inner._indexes[bytes32(uint256(uint160(value)))] - 1;
    }
}
// import "hardhat/console.sol";

// library EnumerableSet {

// }
