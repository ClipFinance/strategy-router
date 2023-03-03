//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "../strategies/BiswapBase.sol";

// Mock Biswap strategy to test Biswap strategy

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract MockBiswapBase is BiswapBase {
    constructor(
        StrategyRouter _strategyRouter,
        uint256 _poolId,
        ERC20 _tokenA,
        ERC20 _tokenB,
        ERC20 _lpToken,
        IUsdOracle _oracle,
        uint256 _priceThreshold
    )
        BiswapBase(
            _strategyRouter,
            _poolId,
            _tokenA,
            _tokenB,
            _lpToken,
            _oracle,
            _priceThreshold
        )
    {}

    function calculateSwapAmountPublic(uint256 tokenAmount, uint256 dexFee)
        public
        view
        returns (uint256 amountA, uint256 amountAToSell)
    {
        return calculateSwapAmount(tokenAmount, dexFee);
    }
}
