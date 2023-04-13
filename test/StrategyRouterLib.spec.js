const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy } = require("./shared/commonSetup");
const { parseUniform, saturateTokenBalancesInStrategies, deploy } = require("./utils");
const { applySlippageInBps, convertFromUsdToTokenAmount } = require("./utils");
const { constants } = require("@openzeppelin/test-helpers");
const { loadFixture, impersonateAccount } = require("@nomicfoundation/hardhat-network-helpers");
const { smock } = require('@defi-wonderland/smock');



describe("StrategyRouterLib test", function () {

  async function initialState() {

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(false));

    let lib = await deploy("StrategyRouterLib");
    let libTestFactory = await ethers.getContractFactory("StrategyRouterLibTest", {
      libraries: {
        StrategyRouterLib: lib.address,
      },
    });
    let libTest = await libTestFactory.deploy();
    libTest = await libTest.deployed();

    return {
      lib, libTest
    }
  }

  describe("#getStrategyIndexToSupportedTokenIndexMap", function () {
    it("0 supported tokens 0 strategies", async function () {
      let { libTest } = await loadFixture(initialState);
      let indexMap = await libTest.getStrategyIndexToSupportedTokenIndexMap();
      expect(indexMap.length).to.be.equal(0);
    });

    it("1 supported tokens 0 strategies", async function () {
      let { libTest } = await loadFixture(initialState);
      let supportedTokenPrices = [
        { token: busd.address, price: 0, priceDecimals: 0 },
      ]
      await libTest.setSupportedTokenPrices(supportedTokenPrices);

      let indexMap = await libTest.getStrategyIndexToSupportedTokenIndexMap();

      expect(indexMap.length).to.be.equal(0);
    });

    it("1 supported token 1 strategy", async function () {
      let { libTest } = await loadFixture(initialState);
      let supportedTokenPrices = [
        { token: busd.address, price: 0, priceDecimals: 0 },
      ]
      await libTest.setSupportedTokenPrices(supportedTokenPrices);

      let strategies = [
        { depositToken: busd.address, strategyAddress: ethers.constants.AddressZero, weight: 0 },
      ]
      await libTest.setStrategies(strategies);

      let indexMap = await libTest.getStrategyIndexToSupportedTokenIndexMap();

      let strategyIndex = 0;
      let supportedTokenIndex = 0;
      expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
      expect(indexMap.length).to.be.equal(1);
    });

    it("2 supported token 1 strategy", async function () {
      let { libTest } = await loadFixture(initialState);
      let supportedTokenPrices = [
        { token: usdc.address, price: 0, priceDecimals: 0 },
        { token: busd.address, price: 0, priceDecimals: 0 },
      ]
      await libTest.setSupportedTokenPrices(supportedTokenPrices);

      let strategies = [
        { depositToken: busd.address, strategyAddress: ethers.constants.AddressZero, weight: 0 },
      ]
      await libTest.setStrategies(strategies);

      let indexMap = await libTest.getStrategyIndexToSupportedTokenIndexMap();

      let strategyIndex = 0;
      let supportedTokenIndex = 1;
      expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
      expect(indexMap.length).to.be.equal(1);
    });

    it("2 supported token 3 strategy", async function () {
      let { libTest } = await loadFixture(initialState);
      let supportedTokenPrices = [
        { token: usdc.address, price: 0, priceDecimals: 0 },
        { token: busd.address, price: 0, priceDecimals: 0 },
      ]
      await libTest.setSupportedTokenPrices(supportedTokenPrices);

      let strategies = [
        { depositToken: busd.address, strategyAddress: ethers.constants.AddressZero, weight: 0 },
        { depositToken: usdc.address, strategyAddress: ethers.constants.AddressZero, weight: 0 },
        { depositToken: busd.address, strategyAddress: ethers.constants.AddressZero, weight: 0 },
      ]
      await libTest.setStrategies(strategies);

      let indexMap = await libTest.getStrategyIndexToSupportedTokenIndexMap();

      let strategyIndex = 0;
      let supportedTokenIndex = 1;
      expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
      strategyIndex = 1;
      supportedTokenIndex = 0;
      expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
      strategyIndex = 2;
      supportedTokenIndex = 1;
      expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
      expect(indexMap.length).to.be.equal(3);
    });

  });
});