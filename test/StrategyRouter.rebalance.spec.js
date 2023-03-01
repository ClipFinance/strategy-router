const { expect, assert } = require("chai");
const { BigNumber } = require("ethers");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake } = require("./shared/commonSetup");

describe("Test rebalance functions", function () {

  let owner;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // core contracts
  let router, oracle, exchange;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {

    [owner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts`
    ({ router, oracle, exchange } = await setupCore());

    // deploy mock tokens 
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd);
    await router.setAllocationWindowTime(1);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

  });

  beforeEach(async () => {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async () => {
    await provider.send("evm_revert", [snapshotId]);
  });

  after(async () => {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("Test rebalanceBatch function", function () {

    it("usdt strategy, router supports only usdt, should revert", async function () {

      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      // await expect(router.rebalanceBatch()).to.be.revertedWith("NothingToRebalance()");
    });

    it("usdt strategy, router supports multiple arbitrary tokens", async function () {

      await router.setSupportedToken(usdt.address, true);
      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdc.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.depositToBatch(usdc.address, parseUsdc("1"));

      await verifyTokensRatio([1, 1, 1]);

      let ret = await router.callStatic.rebalanceBatch();
      let gas = (await (await router.rebalanceBatch()).wait()).gasUsed;
      // console.log("gasUsed", gas);
      // console.log("ret", ret);
      // console.log("getTokenBalances", await getTokenBalances());

      await verifyTokensRatio([1, 0, 0]);

    });

    it("two usdt strategies, router supports only usdt", async function () {

      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm2.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));

      let ret = await router.callStatic.rebalanceBatch();
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatch()).wait()).gasUsed;
      // console.log("gasUsed", gas);
      // console.log("ret", ret);
      // console.log("getTokenBalances", await getTokenBalances());


    });

    it("two usdt strategies, router supports usdt,busd,usdc", async function () {

      await router.setSupportedToken(usdt.address, true);
      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdc.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm2.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.depositToBatch(usdc.address, parseUsdc("1"));
      // console.log(await router.getBatchValueUsd());

      await verifyTokensRatio([1, 1, 1]);

      let ret = await router.callStatic.rebalanceBatch();
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatch()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyTokensRatio([1, 0, 0]);

    });

    it("usdt and busd strategies, router supports usdt,busd", async function () {

      await router.setSupportedToken(usdt.address, true);
      await router.setSupportedToken(busd.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseBusd("1"));

      await verifyTokensRatio([2, 1]);

      let ret = await router.callStatic.rebalanceBatch();
      // console.log(ret);
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatch()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyTokensRatio([1, 1]);

    });

    it("usdt and busd strategies, router supports usdt,busd,usdc", async function () {

      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdc.address, true);
      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);

      await router.addStrategy(farm2.address, busd.address, 7000);
      await router.addStrategy(farm.address, usdt.address, 3000);

      await router.depositToBatch(usdt.address, parseUsdt("2201"));
      await router.depositToBatch(busd.address, parseBusd("923"));
      await router.depositToBatch(usdc.address, parseUsdc("3976"));

      await verifyTokensRatio([13, 56, 31]);

      let ret = await router.callStatic.rebalanceBatch();
      // console.log(ret);
      await verifyRatioOfReturnedData([7, 3], ret);

      let gas = (await (await router.rebalanceBatch()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyTokensRatio([70, 0, 30]);

    });

    it("'dust' token balances should not be swapped on dexes", async function () {

      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdc.address, true);
      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, 2);
      await router.depositToBatch(busd.address, 2);
      await router.depositToBatch(usdc.address, parseUsdc("1"));

      let ret = await router.callStatic.rebalanceBatch();
      await expect(ret[0]).to.be.closeTo(
        parseUsdt("1"),
        parseUsdt("0.01")
      );

      let gas = (await (await router.rebalanceBatch()).wait()).gasUsed;

      await verifyTokensRatio([0, 0, 1]);

    });

    it("high number of strategies", async function () {
      await router.setSupportedToken(usdt.address, true);
      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdc.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      let farm3 = await createMockStrategy(usdt.address, 10000);
      let farm4 = await createMockStrategy(busd.address, 10000);
      let farm5 = await createMockStrategy(busd.address, 10000);
      let farm6 = await createMockStrategy(usdc.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 30000);
      await router.addStrategy(farm2.address, usdt.address, 10000);
      await router.addStrategy(farm3.address, usdt.address, 10000);
      await router.addStrategy(farm4.address, busd.address, 10000);
      await router.addStrategy(farm5.address, busd.address, 10000);
      await router.addStrategy(farm6.address, usdc.address, 50000);

      await router.depositToBatch(usdt.address, parseUsdt("1000"));
      await router.depositToBatch(busd.address, parseBusd("1000"));
      await router.depositToBatch(usdc.address, parseBusd("1000"));
      await router.allocateToStrategies();

      await verifyStrategiesRatio([3, 1, 1, 1, 1, 5]);
    });
  });

  describe("Test rebalanceStrategies function", function () {

    it.skip("one strategy rebalance should revert", async function () {

      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await expect(router.rebalanceStrategies()).to.be.revertedWithCustomError(router, "NothingToRebalance");
    });

    it("two usdt strategies", async function () {

      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm2.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));
      await router.allocateToStrategies();
      await router.updateStrategy(0, 10000);

      await verifyStrategiesRatio([1, 1]);
      let ret = await router.callStatic.rebalanceStrategies();

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;

      await verifyStrategiesRatio([2, 1]);

    });

    it("usdt and busd strategies", async function () {

      await router.setSupportedToken(usdt.address, true);
      await router.setSupportedToken(busd.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();

      await router.updateStrategy(0, 10000);

      await verifyStrategiesRatio([1, 1]);

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyStrategiesRatio([2, 1]);

    });


    it("usdt,usdt,busd strategies", async function () {

      await router.setSupportedToken(usdt.address, true);
      await router.setSupportedToken(busd.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      let farm3 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm3.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();

      await verifyStrategiesRatio([1, 1, 1]);

      await router.updateStrategy(0, 10000);
      await router.updateStrategy(2, 10000);

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyStrategiesRatio([2, 1, 2]);

    });

    it("'dust' amounts should be ignored and not swapped on dex", async function () {

      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdc.address, true);
      await router.setSupportedToken(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      let farm3 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm3.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, 2);
      await router.depositToBatch(busd.address, 2);
      await router.depositToBatch(usdc.address, parseUsdc("1"));

      await router.allocateToStrategies();

      await router.updateStrategy(0, 10000);
      await router.updateStrategy(1, 10001);
      await router.updateStrategy(2, 10001); // notice 1 in the end

      await verifyStrategiesRatio([1, 1, 1]);

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyStrategiesRatio([1, 1, 1]);

    });
  });

  async function verifyRatioOfReturnedData(weights, data) {
    assert(Number(await router.getStrategiesCount()) == weights.length);
    let balances = Array.from(data);
    let totalDeposit = BigNumber.from(0);
    let [strategies] = await router.getStrategies();

    for (let i = 0; i < balances.length; i++) {
      let uniformAmount = await toUniform(balances[i], strategies[i].depositToken);
      balances[i] = uniformAmount;
      totalDeposit = totalDeposit.add(uniformAmount);
    }
    let totalWeight = weights.reduce((e, acc) => acc + e);
    const ERROR_THRESHOLD = 0.3;
    for (let i = 0; i < weights.length; i++) {
      const percentWeight = weights[i] * 100 / totalWeight;
      const percentBalance = balances[i] * 100 / totalDeposit;
      expect(percentBalance).to.be.closeTo(percentWeight, ERROR_THRESHOLD);
    }
  }
  async function toUniform(amount, tokenAddress) {
    let decimals = await (await ethers.getContractAt("ERC20", tokenAddress)).decimals();
    return await changeDecimals(amount, Number(decimals), Number(18));
  }

  async function changeDecimals(amount, oldDecimals, newDecimals) {
    if (oldDecimals < (newDecimals)) {
      return amount.mul(BigNumber.from(10).pow(newDecimals - oldDecimals));
      // return amount * (10 ** (newDecimals - oldDecimals));
    } else if (oldDecimals > (newDecimals)) {
      return amount.div(BigNumber.from(10).pow(oldDecimals - newDecimals));
      // return amount / (10 ** (oldDecimals - newDecimals));
    }
    return amount;
  }

  // weights order should match 'tokens' order
  async function verifyTokensRatio(weights) {
    assert((await router.getSupportedTokens()).length == weights.length);
    const ERROR_THRESHOLD = 0.6;
    const { total: totalUsd, balances: tokenBalancesUsd } = await getTokenBalances();
    let totalWeight = weights.reduce((e, acc) => acc + e);
    // console.log("Total weight: " + totalWeight);
    let totalWeightsSum = 0;
    for (let i = 0; i < weights.length; i++) {
      const percentWeight = weights[i] * 100 / totalWeight;
      // console.log("Percent weight: " + percentWeight);
      // console.log("Token balance USD: " + tokenBalancesUsd[i])
      // console.log("Total USD: " + totalUsd);
      const percentBalance = tokenBalancesUsd[i] * 100 / totalUsd;
      // console.log("Percent balance: " + percentBalance);
      expect(percentBalance).to.be.closeTo(percentWeight, ERROR_THRESHOLD);
      totalWeightsSum += percentBalance;
      // console.log("-- Cycle #" + i + " passed, starting next cycle #" + (i+1));
    }
    expect(totalWeightsSum).to.be.closeTo(100, 0.1);
  }

  async function verifyStrategiesRatio(weights) {
    assert((await router.getStrategiesCount()) == weights.length);
    const ERROR_THRESHOLD = 0.5;
    const { total, balances } = await getStrategiesBalances();
    console.log('balances', balances);
    let totalWeight = weights.reduce((e, acc) => acc + e);
    for (let i = 0; i < weights.length; i++) {
      const percentWeight = weights[i] * 100 / totalWeight;
      const percentBalance = balances[i] * 100 / total;
      expect(percentBalance).to.be.closeTo(percentWeight, ERROR_THRESHOLD);
    }
  }

  async function getTokenBalances() {
    let [total, balances] = await router.getBatchValueUsd();
    return { total, balances };
  }

  async function getStrategiesBalances() {
    let [strategies] = await router.getStrategies();
    let total = BigNumber.from(0);
    let balances = [];
    for (let i = 0; i < strategies.length; i++) {
      const stratAddr = strategies[i].strategyAddress;
      let strategy = await ethers.getContractAt("IStrategy", stratAddr);
      let balance = await toUniform(await strategy.totalTokens(), strategies[i].depositToken);
      total = total.add(BigNumber.from(balance));
      balances.push(balance)
    }
    return { total, balances };
  }

  async function createMockStrategy(depositToken, profit_percent) {
    const Farm = await ethers.getContractFactory("MockStrategy");
    let farm = await Farm.deploy(depositToken, profit_percent);
    await farm.deployed();
    return farm;
  }

});
