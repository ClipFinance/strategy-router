// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import "./interfaces/IStrategyRouter.sol";
import {StrategyInfo} from "./lib/Structs.sol";

contract Rewards {
    IStrategyRouter public strategyRouter;
    IUsdOracle public oracle;

    constructor(IStrategyRouter _strategyRouter, IUsdOracle _oracle) {
        strategyRouter = _strategyRouter;
        oracle = _oracle;
    }

    function getPendingRewards()
        external
        view
        returns (
            uint256[] memory pendingRewardsInUsd,
            uint256[] memory pendingRewardsInToken,
            address[] memory rewardTokens
        )
    {
        (StrategyInfo[] memory strategies, ) = strategyRouter.getStrategies();

        pendingRewardsInToken = new uint256[](strategies.length);
        pendingRewardsInUsd = new uint256[](strategies.length);
        rewardTokens = new address[](strategies.length);

        for (uint256 i = 0; i < strategies.length; i++) {
            IStrategy strategy = IStrategy(strategies[i].strategyAddress);
            rewardTokens[i] = strategy.rewardToken();
            pendingRewardsInToken[i] = strategy.getPendingReward();

            bool hasPriceFeed = oracle.isTokenSupported(rewardTokens[i]);
            if (hasPriceFeed) {
                (uint256 price, uint8 decimals) = oracle.getTokenUsdPrice(rewardTokens[i]);
                pendingRewardsInUsd[i] = (pendingRewardsInToken[i] * price) / (10 ** decimals);
            } else {
                address depositToken = strategies[i].depositToken;
                uint256 exchangePrice = strategyRouter.getExchange().getRoutePrice(rewardTokens[i], depositToken);
                uint256 pendingRewardsInDepositToken = (pendingRewardsInToken[i] * exchangePrice) /
                    10 ** IERC20Metadata(rewardTokens[i]).decimals();

                (uint256 price, uint8 decimals) = oracle.getTokenUsdPrice(depositToken);
                pendingRewardsInUsd[i] = (pendingRewardsInDepositToken * price) / (10 ** decimals);
            }
        }
    }
}
