// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
// Import added for artifact generation purpose
import "@spherex-xyz/contracts/src/ProtectedProxies/ProtectedERC1967Proxy.sol";

/* It is a placeholder contract for Create2Deployer to deploy an upgradeable proxy contract
 * It is the first implementation of the ERC1967Proxy contract to get a permanent bytecode hash and address
 * Our contract addresses will changed only by providing different salt
 */
contract PlaceholderContract is UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override {}
}
