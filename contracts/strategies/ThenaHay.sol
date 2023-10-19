//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IUsdOracle.sol";
import "../interfaces/IStrategyRouter.sol";
import "./ThenaGammaStableBase.sol";

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract ThenaHay is ThenaGammaStableBase {
    constructor(
        IStrategyRouter _strategyRouter,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    )
        ThenaGammaStableBase(
            _strategyRouter,
            IERC20Metadata(0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5), // tokenA - hay mainnet on bsc
            IERC20Metadata(0x55d398326f99059fF775485246999027B3197955), // tokenB - usdt
            IThenaHypervisor(0xDf0B9b59E92A2554dEdB6F6F4AF6918d79DD54c4), // lpToken - hay-usdt
            IGammaUniProxy(0x6B3d98406779DDca311E6C43553773207b506Fa6), // gammaUniProxy - hypervisors manager
            IThenaGaugeV2(0x2Da06b6338f3d503cb2F0ee0e66C8e98A6d8001C), // thena gauge farming pool
            IERC20Metadata(0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11), // thena token
            _oracle,
            _priceManipulationPercentThresholdInBps
        )
    {}
}
