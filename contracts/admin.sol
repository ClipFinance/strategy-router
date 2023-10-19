// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

import "./deps/OwnableUpgradeable.sol";
import "./interfaces/IStrategyRouter.sol";
import "./interfaces/IStrategy.sol";
import {SphereXProtected} from "@spherex-xyz/contracts/src/SphereXProtected.sol";

contract RouterAdmin is AccessControl {
    using SafeERC20 for IERC20;

    IStrategyRouter public strategyRouter;

    bytes32 public constant MODERATOR = keccak256("MODERATOR");

    constructor(IStrategyRouter _strategyRouter) {
        strategyRouter = _strategyRouter;

        // set proxi admin to address that deployed this contract from Create2Deployer or msg.sender if it was called directly
        _grantRole(DEFAULT_ADMIN_ROLE, tx.origin);
        _grantRole(MODERATOR, tx.origin);
    }

    // StrategyRouter methods

    function setAddresses(
        IExchange _exchange,
        IUsdOracle _oracle,
        ISharesToken _sharesToken,
        IBatch _batch,
        IReceiptNFT _receiptNft
    ) external onlyRole(DEFAULT_ADMIN_ROLE) sphereXGuardExternal(28) {
        strategyRouter.setAddresses(_exchange, _oracle, _sharesToken, _batch, _receiptNft);
    }

    function redeemReceiptsToSharesByModerators(uint256[] calldata receiptIds)
        external
        onlyRole(MODERATOR)
        sphereXGuardExternal(26)
    {
        strategyRouter.redeemReceiptsToSharesByModerators(receiptIds);
    }

    function setSupportedToken(address tokenAddress, bool supported, address idleStrategy)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(32)
    {
        strategyRouter.setSupportedToken(tokenAddress, supported, idleStrategy);
    }

    function setFeesCollectionAddress(address _moderator)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(30)
    {
        strategyRouter.setFeesCollectionAddress(_moderator);
    }

    function setAllocationWindowTime(uint256 timeInSeconds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(29)
    {
        strategyRouter.setAllocationWindowTime(timeInSeconds);
    }

    function setIdleStrategy(uint256 i, address idleStrategy)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(31)
    {
        strategyRouter.setIdleStrategy(i, idleStrategy);
    }

    function addStrategy(address _strategyAddress, uint256 _weight)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(22)
    {
        strategyRouter.addStrategy(_strategyAddress, _weight);
    }

    function removeStrategy(uint256 _strategyId) external onlyRole(DEFAULT_ADMIN_ROLE) sphereXGuardExternal(27) {
        strategyRouter.removeStrategy(_strategyId);
    }

    function rebalanceStrategies() external onlyRole(DEFAULT_ADMIN_ROLE) sphereXGuardExternal(25) {
        strategyRouter.rebalanceStrategies();
    }

    function updateStrategy(uint256 _strategyId, uint256 _weight)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(35)
    {
        strategyRouter.updateStrategy(_strategyId, _weight);
    }

    // Removed (idle and/or base) Strategies only owner methods

    function transferOwner(address contractAddress, address newOwner)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(34)
    {
        OwnableUpgradeable(contractAddress).transferOwnership(newOwner);
    }

    function withdrawFromStrategy(address strategy, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(37)
    {
        IStrategy(strategy).withdraw(amount);
    }

    function withdrawAllFromStrategy(address strategy) external onlyRole(DEFAULT_ADMIN_ROLE) sphereXGuardExternal(36) {
        IStrategy(strategy).withdrawAll();
    }

    function compoundStrategy(address strategy) external onlyRole(DEFAULT_ADMIN_ROLE) sphereXGuardExternal(24) {
        IStrategy(strategy).compound();
    }

    // Additional methods

    function tokenTransfer(address tokenAddress, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardExternal(33)
    {
        IERC20(tokenAddress).safeTransfer(to, amount);
    }

    function callTarget(address _target, bytes memory _data)
        public
        payable
        onlyRole(DEFAULT_ADMIN_ROLE)
        sphereXGuardPublic(23, 0xb002fba9)
        returns (bool, bytes memory)
    {
        (bool success, bytes memory result) = _target.call{value: msg.value}(_data);
        return (success, result);
    }
}
