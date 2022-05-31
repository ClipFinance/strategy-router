const { expect, should, use, assert } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { commonSetup } = require("./shared/commonSetup");
const { getTokens, getBUSD, getUSDC, getUSDT, parseBusd, parseUsdt, parseUsdc } = require("./utils");

describe("Test rebalance functions", function () {

  before(async function () {
    snapshotId0 = await provider.send("evm_snapshot");
    await commonSetup();
    usdt = await getUSDT();
    await router.setCycleDuration(1);
  });

  after(async function () {
    await provider.send("evm_revert", [snapshotId0]);
  });

  it("Approve router", async function () {
    await usdt.approve(router.address, parseUsdt("1000000"));
    await busd.approve(router.address, parseEther("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
  });

  it("evm_snapshot", async function () {
      snapshotId = await provider.send("evm_snapshot");
  });

  describe("Test rebalanceBatching function", function () {

    beforeEach(async () => {
      // console.log("bef each");
      await provider.send("evm_revert", [snapshotId]);
      snapshotId = await provider.send("evm_snapshot");
    });

    it("usdt strategy, router supports only usdt, should revert", async function () {

      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      // await expect(router.rebalanceBatching()).to.be.revertedWith("NothingToRebalance()");
    });

    it("usdt strategy, router supports multiple arbitrary tokens", async function () {

      await router.setSupportedStablecoin(usdt.address, true);
      await router.setSupportedStablecoin(busd.address, true);
      await router.setSupportedStablecoin(usdc.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));
      await router.depositToBatch(busd.address, parseUsdt("1"));
      await router.depositToBatch(usdc.address, parseUsdt("1"));

      await verifyTokensRatio([1, 1, 1]);

      let ret = await router.callStatic.rebalanceBatching();
      let gas = (await (await router.rebalanceBatching()).wait()).gasUsed;
      // console.log("gasUsed", gas);
      // console.log("ret", ret);
      // console.log("getTokenBalances", await getTokenBalances());

      await verifyTokensRatio([1, 0, 0]);

    });

    it("two usdt strategies, router supports only usdt", async function () {

      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm2.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));

      let ret = await router.callStatic.rebalanceBatching();
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatching()).wait()).gasUsed;
      // console.log("gasUsed", gas);
      // console.log("ret", ret);
      // console.log("getTokenBalances", await getTokenBalances());


    });

    it("two usdt strategies, router supports usdt,busd,usdc", async function () {

      await router.setSupportedStablecoin(usdt.address, true);
      await router.setSupportedStablecoin(busd.address, true);
      await router.setSupportedStablecoin(usdc.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm2.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));
      await router.depositToBatch(busd.address, parseUsdt("1"));
      await router.depositToBatch(usdc.address, parseUsdt("1"));
      // console.log(await router.viewBatchingValue());

      await verifyTokensRatio([1, 1, 1]);

      let ret = await router.callStatic.rebalanceBatching();
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatching()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyTokensRatio([1, 0, 0]);

    });

    it("usdt and busd strategies, router supports usdt,busd", async function () {

      await router.setSupportedStablecoin(usdt.address, true);
      await router.setSupportedStablecoin(busd.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseUsdt("1"));

      await verifyTokensRatio([2, 1]);

      let ret = await router.callStatic.rebalanceBatching();
      // console.log(ret);
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatching()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyTokensRatio([1, 1]);

    });

    it("usdt and busd strategies, router supports usdt,busd,usdc", async function () {

      await router.setSupportedStablecoin(busd.address, true);
      await router.setSupportedStablecoin(usdc.address, true);
      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseUsdt("1"));
      await router.depositToBatch(usdc.address, parseUsdt("5"));

      await verifyTokensRatio([1, 5, 2]);

      let ret = await router.callStatic.rebalanceBatching();
      // console.log(ret);
      await verifyRatioOfReturnedData([1, 1], ret);

      let gas = (await (await router.rebalanceBatching()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyTokensRatio([1, 0, 1]);

    });

    it("'dust' token balances should not be swapped on dexes", async function () {

      await router.setSupportedStablecoin(busd.address, true);
      await router.setSupportedStablecoin(usdc.address, true);
      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, 2);
      await router.depositToBatch(busd.address, 2);
      await router.depositToBatch(usdc.address, parseUsdc("1"));

      let ret = await router.callStatic.rebalanceBatching();
      await expect(ret.balances[0]).to.be.closeTo(
        parseUsdt("1"),
        parseUsdt("0.01")
      );

      let gas = (await (await router.rebalanceBatching()).wait()).gasUsed;

      await verifyTokensRatio([0, 0, 1]);

    });
  });

  describe("Test rebalanceStrategies function", function () {
    beforeEach(async () => {
      await provider.send("evm_revert", [snapshotId]);
      snapshotId = await provider.send("evm_snapshot");
    });

    it("one strategy rebalance should revert", async function () {

      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await expect(router.rebalanceStrategies()).to.be.revertedWith("NothingToRebalance()");
    });

    it("two usdt strategies", async function () {

      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm2.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("1"));
      await router.depositToStrategies();
      await router.updateStrategy(0, 10000);
      
      await verifyStrategiesRatio([1,1]);
      let ret = await router.callStatic.rebalanceStrategies();

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;

      await verifyStrategiesRatio([2,1]);

    });

    it("usdt and busd strategies", async function () {

      await router.setSupportedStablecoin(usdt.address, true);
      await router.setSupportedStablecoin(busd.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseUsdt("1"));
      await router.depositToStrategies();

      await router.updateStrategy(0, 10000);
      
      await verifyStrategiesRatio([1,1]);

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyStrategiesRatio([2, 1]);

    });


    it("usdt,usdt and busd strategies", async function () {

      await router.setSupportedStablecoin(usdt.address, true);
      await router.setSupportedStablecoin(busd.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      let farm3 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm3.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, parseUsdt("2"));
      await router.depositToBatch(busd.address, parseUsdt("1"));
      await router.depositToStrategies();

      await router.updateStrategy(0, 10000);
      await router.updateStrategy(2, 10000);

      await verifyStrategiesRatio([1, 1, 1]);

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;
      // console.log("gasUsed", gas);

      await verifyStrategiesRatio([2, 1, 2]);

    });

    it("'dust' amounts should be ignored and not swapped on dex", async function () {

      await router.setSupportedStablecoin(busd.address, true);
      await router.setSupportedStablecoin(usdc.address, true);
      await router.setSupportedStablecoin(usdt.address, true);

      let farm = await createMockStrategy(usdt.address, 10000);
      let farm2 = await createMockStrategy(busd.address, 10000);
      let farm3 = await createMockStrategy(usdt.address, 10000);
      await router.addStrategy(farm2.address, busd.address, 5000);
      await router.addStrategy(farm.address, usdt.address, 5000);
      await router.addStrategy(farm3.address, usdt.address, 5000);

      await router.depositToBatch(usdt.address, 2);
      await router.depositToBatch(busd.address, 2);
      await router.depositToBatch(usdc.address, parseUsdc("1"));

      await router.depositToStrategies();

      await router.updateStrategy(0, 10000);
      await router.updateStrategy(1, 10001);
      await router.updateStrategy(2, 10001); // notice 1 in the end

      await verifyStrategiesRatio([1, 1, 1]);

      let gas = (await (await router.rebalanceStrategies()).wait()).gasUsed;
      // console.log("gasUsed", gas);
      
      await verifyStrategiesRatio([1, 1, 1]);

    });
  });


});

async function verifyRatioOfReturnedData(weights, data) {
  assert(Number(await router.viewStrategiesCount()) == weights.length);
  const { totalDeposit, balances } = data;
  // console.log(totalDeposit, balances);
  let totalWeight = weights.reduce((e, acc) => acc + e);
  const ERROR_THRESHOLD = 0.3;
  for (let i = 0; i < weights.length; i++) {
    const percentWeight = weights[i] * 100 / totalWeight;
    const percentBalance = balances[i] * 100 / totalDeposit;
    // console.log(percentBalance, percentWeight);
    expect(percentBalance).to.be.closeTo(percentWeight, ERROR_THRESHOLD);
  }
}

// weights order should match 'stablecoins' order
async function verifyTokensRatio(weights) {
  assert((await router.viewStablecoins()).length == weights.length);
  const ERROR_THRESHOLD = 0.3;
  const { total, balances } = await getTokenBalances();
  let totalWeight = weights.reduce((e, acc) => acc + e);
  for (let i = 0; i < weights.length; i++) {
    const percentWeight = weights[i] * 100 / totalWeight;
    const percentBalance = balances[i] * 100 / total;
    // console.log(percentBalance, percentWeight);
    expect(percentBalance).to.be.closeTo(percentWeight, ERROR_THRESHOLD);
  }
}

async function verifyStrategiesRatio(weights) {
  assert((await router.viewStrategiesCount()) == weights.length);
  const ERROR_THRESHOLD = 0.3;
  const { total, balances } = await getStrategiesBalances();
  // console.log(total, balances);
  let totalWeight = weights.reduce((e, acc) => acc + e);
  for (let i = 0; i < weights.length; i++) {
    const percentWeight = weights[i] * 100 / totalWeight;
    const percentBalance = balances[i] * 100 / total;
    // console.log(percentBalance, percentWeight);
    expect(percentBalance).to.be.closeTo(percentWeight, ERROR_THRESHOLD);
  }
}

async function getTokenBalances() {
  let stables = await router.viewStablecoins();
  let total = BigNumber.from(0);
  let balances = [];
  for (let i = 0; i < stables.length; i++) {
    const tokenAddr = stables[i];
    let token = await ethers.getContractAt("ERC20", tokenAddr);
    let balance = await token.balanceOf(batching.address);
    total = total.add(BigNumber.from(balance));
    balances.push(balance)
  }
  return { total, balances };
}

async function getStrategiesBalances() {
  let strategies = await router.viewStrategies();
  let total = BigNumber.from(0);
  let balances = [];
  for (let i = 0; i < strategies.length; i++) {
    const stratAddr = strategies[i].strategyAddress;
    let strategy = await ethers.getContractAt("IStrategy", stratAddr);
    let balance = await strategy.totalTokens();
    total = total.add(BigNumber.from(balance));
    balances.push(balance)
  }
  return { total, balances };
}

async function createMockStrategy(asset, profit_percent) {
  const Farm = await ethers.getContractFactory("MockStrategy");
  let farm = await Farm.deploy(asset, profit_percent);
  await farm.deployed();
  return farm;
}