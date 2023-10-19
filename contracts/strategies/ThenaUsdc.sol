//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IUsdOracle.sol";
import "../interfaces/IStrategyRouter.sol";
import "./ThenaGammaStableBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract ThenaUsdc is ThenaGammaStableBase {
    constructor(
        IStrategyRouter _strategyRouter,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    )
        ThenaGammaStableBase(
            _strategyRouter,
            IERC20Metadata(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d), // tokenA - usdc mainnet on bsc
            IERC20Metadata(0x55d398326f99059fF775485246999027B3197955), // tokenB - usdt
            IThenaHypervisor(0x5EEca990E9B7489665F4B57D27D92c78BC2AfBF2), // lpToken - usdt-usdc
            IGammaUniProxy(0x6B3d98406779DDca311E6C43553773207b506Fa6), // gammaUniProxy - hypervisors manager
            IThenaGaugeV2(0x1011530830c914970CAa96a52B9DA1C709Ea48fb), // thena gauge farming pool
            IERC20Metadata(0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11), // thena token
            _oracle,
            _priceManipulationPercentThresholdInBps
        )
    {}
}
