//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "../Batch.sol";
import {TokenPrice, StrategyInfo} from "../lib/Structs.sol";

contract BatchWithPublicRebalanceNoAllocation is Batch {
    function rebalanceNoAllocation()
        external
        returns (uint256[] memory balancesPendingAllocationToStrategy, TokenInfo[] memory tokenInfos)
    {
        (StrategyInfo[] memory strategies, uint256 remainingToAllocateStrategiesWeightSum) = router.getStrategies();

        (balancesPendingAllocationToStrategy, tokenInfos) = this._rebalanceNoAllocationPublic(
            getSupportedTokensWithPriceInUsd(),
            strategies,
            remainingToAllocateStrategiesWeightSum
        );
    }

    function _rebalanceNoAllocationPublic(
        TokenPrice[] calldata supportedTokenPrices,
        StrategyInfo[] memory strategies,
        uint256 remainingToAllocateStrategiesWeightSum
    ) public returns (uint256[] memory balancesPendingAllocationToStrategy, TokenInfo[] memory tokenInfos) {
        return _rebalanceNoAllocation(supportedTokenPrices, strategies, remainingToAllocateStrategiesWeightSum);
    }
}
