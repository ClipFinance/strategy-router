const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const strategyTest = require("./utils/strategyTest");
const { getTokens, skipBlocks, BLOCKS_MONTH, parseUsdc, parseBusd, getUSDC, getBUSD } = require("./utils/utils");

describe("Test strategies", function () {

  let strategies = [
    { name: "biswap_usdc_usdt", parseAmount: parseUsdc, getDepositToken: getUSDC },
    { name: "biswap_busd_usdt", parseAmount: parseBusd, getDepositToken: getBUSD },
  ];

  for (let i = 0; i < strategies.length; i++) {
      let strategy = strategies[i];
      strategyTest(strategy.name, strategy.parseAmount, strategy.getDepositToken);   
  }
});
