const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const strategyTest = require("./shared/strategyTest");
const { parseUsdc, parseBusd, getUSDC, getBUSD } = require("./utils");

describe("Test strategies", function () {

  let strategies = [
    { name: "BiswapUsdcUsdt", parseAmount: parseUsdc, getDepositToken: getUSDC },
    { name: "BiswapBusdUsdt", parseAmount: parseBusd, getDepositToken: getBUSD },
  ];

  for (let i = 0; i < strategies.length; i++) {
      let strategy = strategies[i];
      strategyTest(strategy.name, strategy.parseAmount, strategy.getDepositToken);   
  }
});
