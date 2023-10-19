//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

struct TokenPrice {
    uint256 price;
    uint8 priceDecimals;
    address token;
}

struct StrategyInfo {
    address strategyAddress;
    address depositToken;
    uint256 depositTokenInSupportedTokensIndex;
    uint256 weight;
}

struct IdleStrategyInfo {
    address strategyAddress;
    address depositToken;
}

struct ReceiptData {
    uint256 cycleId;
    uint256 tokenAmountUniform; // in token
    address token;
}

struct Cycle {
    // block.timestamp at which cycle started
    uint256 startAt;
    // batch USD value before deposited into strategies
    uint256 totalDepositedInUsd;
    // USD value received by strategies after all swaps necessary to ape into strategies
    uint256 receivedByStrategiesInUsd;
    // Protocol TVL after compound idle strategy and actual deposit to strategies
    uint256 strategiesBalanceWithCompoundAndBatchDepositsInUsd;
    // price per share in USD
    uint256 pricePerShare;
    // tokens price at time of the deposit to strategies
    mapping(address => uint256) prices;
}
