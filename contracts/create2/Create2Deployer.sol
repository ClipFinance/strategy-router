// SPDX-License-Identifier: MIT
// Further information: https://eips.ethereum.org/EIPS/eip-1014

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/utils/introspection/ERC1820Implementer.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import {SphereXProtected} from "@spherex-xyz/contracts/src/SphereXProtected.sol";

// import "hardhat/console.sol";

interface Proxy {
    function upgradeTo(address) external;

    function initialize() external;

    function initialize(bytes memory) external;
}

contract Create2Deployer is Ownable, Pausable {
    /**
     * @dev Deploys a contract using `CREATE2`. The address where the
     * contract will be deployed can be known in advance via {computeAddress}.
     *
     * The bytecode for a contract can be obtained from Solidity with
     * `type(contractName).creationCode`.
     *
     * Requirements:
     * - `bytecode` must not be empty.
     * - `salt` must have not been used for `bytecode` already.
     * - the factory must have a balance of at least `value`.
     * - if `value` is non-zero, `bytecode` must have a `payable` constructor.
     * - `initializeData` must be a valid data to call `initialize` on the new implementation.
     */
    function deployProxy(
        uint256 value,
        bytes32 salt,
        bytes memory code,
        address newImplementation,
        bytes memory initializeData
    ) public whenNotPaused onlyOwner sphereXGuardPublic(13, 0x115d01c4) {
        address proxy = Create2.deploy(value, salt, code);
        Proxy(proxy).upgradeTo(newImplementation);
        Proxy(proxy).initialize(initializeData);
    }

    /**
     * @dev Deploys a contract using `CREATE2`. The address where the
     * contract will be deployed can be known in advance via {computeAddress}.
     *
     * The bytecode for a contract can be obtained from Solidity with
     * `type(contractName).creationCode`.
     *
     * Requirements:
     * - `bytecode` must not be empty.
     * - `salt` must have not been used for `bytecode` already.
     * - the factory must have a balance of at least `value`.
     * - if `value` is non-zero, `bytecode` must have a `payable` constructor.
     */
    function deploy(uint256 value, bytes32 salt, bytes memory code)
        public
        whenNotPaused
        onlyOwner
        sphereXGuardPublic(11, 0x66cfa057)
    {
        Create2.deploy(value, salt, code);
    }

    /**
     * @dev Deployment of the {ERC1820Implementer}.
     * Further information: https://eips.ethereum.org/EIPS/eip-1820
     */
    function deployERC1820Implementer(uint256 value, bytes32 salt)
        public
        whenNotPaused
        onlyOwner
        sphereXGuardPublic(12, 0x076c37b2)
    {
        Create2.deploy(value, salt, type(ERC1820Implementer).creationCode);
    }

    /**
     * @dev Returns the address where a contract will be stored if deployed via {deploy}.
     * Any change in the `bytecodeHash` or `salt` will result in a new destination address.
     */
    function computeAddress(bytes32 salt, bytes32 codeHash) public view returns (address) {
        return Create2.computeAddress(salt, codeHash);
    }

    /**
     * @dev Returns the address where a contract will be stored if deployed via {deploy} from a
     * contract located at `deployer`. If `deployer` is this contract's address, returns the
     * same value as {computeAddress}.
     */
    function computeAddressWithDeployer(bytes32 salt, bytes32 codeHash, address deployer)
        public
        pure
        returns (address)
    {
        return Create2.computeAddress(salt, codeHash, deployer);
    }

    /**
     * @dev Contract can receive ether. However, the only way to transfer this ether is
     * to call the function `killCreate2Deployer`.
     */
    receive() external payable {}

    /**
     * @dev Triggers stopped state.
     * Requirements: The contract must not be paused.
     */
    function pause() public onlyOwner sphereXGuardPublic(15, 0x8456cb59) {
        _pause();
    }

    /**
     * @dev Returns to normal state.
     * Requirements: The contract must be paused.
     */
    function unpause() public onlyOwner sphereXGuardPublic(16, 0x3f4ba83a) {
        _unpause();
    }

    /**
     * @dev Destroys the Create2Deployer contract and transfers all ether to a pre-defined payout address.
     * @notice Using the `CREATE2` EVM opcode always allows to redeploy a new smart contract to a
     * previously seldestructed contract address. However, if a contract creation is attempted,
     * due to either a creation transaction or the `CREATE`/`CREATE2` EVM opcode, and the destination
     * address already has either nonzero nonce, or non-empty code, then the creation throws immediately,
     * with exactly the same behavior as would arise if the first byte in the init code were an invalid opcode.
     * This applies retroactively starting from genesis.
     */
    function killCreate2Deployer(address payable payoutAddress) public onlyOwner sphereXGuardPublic(14, 0x64470454) {
        payoutAddress.transfer(address(this).balance);
        selfdestruct(payoutAddress);
    }
}
