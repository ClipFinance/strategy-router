//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../strategies/BiswapBase.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "../interfaces/IStrategyRouter.sol";

// Mock Biswap strategy to test Biswap strategy

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract MockBiswapBase is BiswapBase {
    constructor(
        IStrategyRouter _strategyRouter,
        uint256 _poolId,
        IERC20Metadata _tokenA,
        IERC20Metadata _tokenB,
        IUniswapV2Pair _lpToken,
        IUsdOracle _oracle,
        uint256 _priceManipulationPercentThresholdInBps
    )
        BiswapBase(
            _strategyRouter,
            _poolId,
            _tokenA,
            _tokenB,
            _lpToken,
            _oracle,
            _priceManipulationPercentThresholdInBps
        )
    {}

    function calculateSwapAmountPublic(
        uint256 tokenAmount,
        uint256 dexFee
    ) public view returns (uint256 amountA, uint256 amountAToSell) {
        TokenPrice memory tokenAOracleData = getOraclePrice(address(tokenA));
        TokenPrice memory tokenBOracleData = getOraclePrice(address(tokenB));

        return calculateSwapAmount(tokenAmount, dexFee, tokenAOracleData, tokenBOracleData);
    }
}
