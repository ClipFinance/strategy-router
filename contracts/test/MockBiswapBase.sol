//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "../strategies/BiswapBase.sol";

// Mock Biswap strategy to test Biswap strategy

/// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
contract MockBiswapBase is BiswapBase
{
    bool public checkPriceManipulation;

    constructor(
        StrategyRouter _strategyRouter,
        uint256 _poolId,
        ERC20 _tokenA,
        ERC20 _tokenB,
        ERC20 _lpToken,
        IUsdOracle _oracle
    ) BiswapBase(_strategyRouter, _poolId, _tokenA, _tokenB, _lpToken, _oracle){
    }

    function setCheckPriceManipulation(bool _check) external {
        checkPriceManipulation = _check;
    }
    
    function calculateSwapAmountPublic(uint256 tokenAmount, uint256 dexFee)
        public
        view
        returns (uint256 amountA, uint256 amountB) {
            return calculateSwapAmount(tokenAmount, dexFee);
        }

    function _checkPriceManipulation(uint oraclePrice, uint ammPrice) internal override view {
        if (checkPriceManipulation) {
            super._checkPriceManipulation(oraclePrice, ammPrice);
        }
    }
}
