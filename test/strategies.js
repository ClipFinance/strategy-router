const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const strategyTest = require("./strategyTest");
const { getTokens, skipBlocks, BLOCKS_MONTH, parseUsdc, getUSDC } = require("./utils");


describe("Test strategies", function () {

  let strategies = [
    { name: "biswap_usdc_usdt", parseAmount: parseUsdc, getDepositToken: getUSDC },
  ];

  for (let i = 0; i < strategies.length; i++) {
      let strategy = strategies[i];
      strategyTest(strategy.name, strategy.parseAmount, strategy.getDepositToken);   
  }

});
