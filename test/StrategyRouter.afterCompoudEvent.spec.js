const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy,
  deployFakeUnderFulfilledWithdrawalStrategy
} = require("./shared/commonSetup");
const { BLOCKS_MONTH, skipTimeAndBlocks, MONTH_SECONDS } = require("./utils");

describe("Test AfterCompound event", function() {

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

  before(async function() {

    [owner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts`
    ({ router, oracle, exchange, sharesToken } = await setupCore());

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

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);
    await router.setSupportedToken(usdt.address, true);
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


  describe("Test AfterCompound event emitting", function() {
    let snapshot;

    before(async () => {
      snapshot = await provider.send("evm_snapshot");
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: busd });
      await deployFakeStrategy({ router, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();
    });

    after(async () => {
      await provider.send("evm_revert", [snapshot]);
    })

    it("should fire AfterCompound event after allocateToStrategies with exact values", async function() {
      const cycleIdBeforeAllocation = await router.currentCycleId();
      const totalTvlBeforeAllocation = (await router.getStrategiesValue())[0];
      const totalSharesBeforeAllocation = await sharesToken.totalSupply();

      await router.depositToBatch(busd.address, parseBusd("100"));

      await expect(router.allocateToStrategies())
        .to
        .emit(router, "AfterCompound")
        .withArgs(
          cycleIdBeforeAllocation,
          totalTvlBeforeAllocation,
          totalSharesBeforeAllocation
        );
    });

    it("should fire AfterCompound event after compoundAll with exact values", async function() {
      const cycleId = await router.currentCycleId();
      const totalTvl = (await router.getStrategiesValue()).totalBalance;
      const totalShares = await sharesToken.totalSupply();

      await expect(router.compoundAll())
        .to
        .emit(router, "AfterCompound")
        .withArgs(
          cycleId,
          totalTvl,
          totalShares
        );
    });
  });

  describe("Check if the actual compound happened", function() {

    it("TVL didnt grow", async function() {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        profitPercent: 0,
        underFulfilledWithdrawalBps: 0
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        profitPercent: 0,
        underFulfilledWithdrawalBps: 0
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdt,
        profitPercent: 0,
        underFulfilledWithdrawalBps: 0
      });

      await router.depositToBatch(busd.address, parseBusd("10000"));
      await router.allocateToStrategies();

      const events = [];

      const firstCompound = await router.compoundAll();
      const firstCompoundReceipt = await firstCompound.wait();
      events.push(firstCompoundReceipt.events[0]);

      await skipTimeAndBlocks(MONTH_SECONDS, BLOCKS_MONTH);

      const secondCompound = await router.compoundAll();
      const secondCompoundReceipt = await secondCompound.wait();
      events.push(secondCompoundReceipt.events[0]);

      await skipTimeAndBlocks(MONTH_SECONDS, BLOCKS_MONTH);

      const thirdCompound = await router.compoundAll();
      const thirdCompoundReceipt = await thirdCompound.wait();
      events.push(thirdCompoundReceipt.events[0]);

      const [firstPeriod, secondPeriod] = await calculateAprApyFromEvents(events);

      expect(firstPeriod.apr).to.be.equal(secondPeriod.apr)
      expect(firstPeriod.apy).to.be.equal(secondPeriod.apy)
    });

    it("TVL reduced", async function() {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        profitPercent: 1000,
        underFulfilledWithdrawalBps: 0,
        tvlGrow: false,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        profitPercent: 1000,
        underFulfilledWithdrawalBps: 0,
        tvlGrow: false,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdt,
        profitPercent: 1000,
        underFulfilledWithdrawalBps: 0,
        tvlGrow: false,
      });

      await router.depositToBatch(busd.address, parseBusd("10000"));
      await router.allocateToStrategies();

      const events = [];

      const firstCompound = await router.compoundAll();
      const firstCompoundReceipt = await firstCompound.wait();
      events.push(firstCompoundReceipt.events[0]);

      await skipTimeAndBlocks(MONTH_SECONDS, BLOCKS_MONTH);

      const secondCompound = await router.compoundAll();
      const secondCompoundReceipt = await secondCompound.wait();
      events.push(secondCompoundReceipt.events[0]);

      await skipTimeAndBlocks(MONTH_SECONDS, BLOCKS_MONTH);

      const thirdCompound = await router.compoundAll();
      const thirdCompoundReceipt = await thirdCompound.wait();
      events.push(thirdCompoundReceipt.events[0]);

      const [firstPeriod, secondPeriod] = await calculateAprApyFromEvents(events);

      expect(firstPeriod.apr).to.be.greaterThan(secondPeriod.apr)
      expect(firstPeriod.apy).to.be.greaterThan(secondPeriod.apy)
    });

    it("TVL grown", async function() {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        profitPercent: 1000,
        underFulfilledWithdrawalBps: 0
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        profitPercent: 1000,
        underFulfilledWithdrawalBps: 0
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdt,
        profitPercent: 1000,
        underFulfilledWithdrawalBps: 0
      });

      await router.depositToBatch(busd.address, parseBusd("10000"));
      await router.allocateToStrategies();

      const events = [];

      const firstCompound = await router.compoundAll();
      const firstCompoundReceipt = await firstCompound.wait();
      events.push(firstCompoundReceipt.events[0]);

      await skipTimeAndBlocks(MONTH_SECONDS, BLOCKS_MONTH);

      const secondCompound = await router.compoundAll();
      const secondCompoundReceipt = await secondCompound.wait();
      events.push(secondCompoundReceipt.events[0]);

      await skipTimeAndBlocks(MONTH_SECONDS, BLOCKS_MONTH);

      const thirdCompound = await router.compoundAll();
      const thirdCompoundReceipt = await thirdCompound.wait();
      events.push(thirdCompoundReceipt.events[0]);

      const [firstPeriod, secondPeriod] = await calculateAprApyFromEvents(events);

      expect(firstPeriod.apr).to.be.lessThan(secondPeriod.apr)
      expect(firstPeriod.apy).to.be.lessThan(secondPeriod.apy)
    });
  });
});

const calculateAprApyFromEvents = async (events) => {

  const res = [];

  for (let i = 0; i < events.length - 1; i++) {
    const tvlInUsd = events[i].args.currentTvlInUsd;
    const totalShares = events[i].args.totalShares;
    const timestamp = (await provider.getBlock(events[i].blockNumber)).timestamp;

    const nextTvlInUsd = events[i + 1].args.currentTvlInUsd;
    const nextTotalShares = events[i + 1].args.totalShares;
    const nextTimestamp = (await provider.getBlock(events[i + 1].blockNumber)).timestamp;

    const pps = tvlInUsd.mul(100).div(totalShares).toNumber() / 100;
    const nextPps = nextTvlInUsd.mul(100).div(nextTotalShares).toNumber() / 100;
    const prf = Math.abs((nextPps - pps) / pps * 100);
    const apr = prf * MONTH_SECONDS / (nextTimestamp - timestamp);
    const apy = prf ** (MONTH_SECONDS  / (nextTimestamp - timestamp));

    res.push({ apr, apy });
  }

  return res;
};