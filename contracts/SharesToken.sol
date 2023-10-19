pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract SharesToken is ERC20Upgradeable, UUPSUpgradeable, OwnableUpgradeable {
    address private strategyRouter;
    address private batchOut;

    modifier onlyOperators() {
        if (msg.sender != strategyRouter && msg.sender != batchOut) revert CallerIsNotOperator();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // lock implementation
        _disableInitializers();
    }

    function initialize(bytes memory initializeData) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        __ERC20_init("Clip-Finance Shares", "CF");

        (address _strategyRouter, address _batchOut) = abi.decode(initializeData, (address, address));

        strategyRouter = _strategyRouter;
        batchOut = _batchOut;

        // transer ownership and set proxi admin to address that deployed this contract from Create2Deployer
        transferOwnership(tx.origin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Helper 'transferFrom' function that don't require user approval
    /// @dev Only callable by strategy router.
    function transferFromAutoApproved(address from, address to, uint256 amount) external onlyOperators {
        _transfer(from, to, amount);
    }

    function mint(address to, uint256 amount) external onlyOperators {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOperators {
        _burn(from, amount);
    }

    function setOperators(address _strategyRouter, address _batchOut) external onlyOwner {
        strategyRouter = _strategyRouter;
        batchOut = _batchOut;
    }

    /* ERRORS */

    error CallerIsNotOperator();
}
