const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy,
  deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken
} = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { constants } = require("@openzeppelin/test-helpers");

function loadState(profitPercent, isRewardPositive = true) {
   async function state() {
    [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

    const { exchangePlugin: fakeExchangePlugin } = await setupFakeExchangePlugin(
      oracle,
      0, // X% slippage,
      25 // fee %0.25
    );
    mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc("10000000"));
    mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt("10000000"));
    mintFakeToken(fakeExchangePlugin.address, busd, parseBusd("10000000"));

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd, fakeExchangePlugin);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true, constants.ZERO_ADDRESS);
    await router.setSupportedToken(busd.address, true, constants.ZERO_ADDRESS);
    await router.setSupportedToken(usdt.address, true, constants.ZERO_ADDRESS);

    // add fake strategies
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: busd,
      profitPercent,
      underFulfilledWithdrawalBps: 0,
      isRewardPositive
    });
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc,
      underFulfilledWithdrawalBps: 0,
      isRewardPositive
    });
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdt,
      underFulfilledWithdrawalBps: 0,
      isRewardPositive
    });

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1000"));
    await router.allocateToStrategies();

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin
    };
  }
  return state
}

describe("Test AfterCompound event", function() {

  describe("Test AfterCompound event emitting", function() {

    it("should fire AfterCompound event after allocateToStrategies with exact values", async function() {
      const state = loadState(0);
      const { router, sharesToken, busd, parseBusd } = await loadFixture(state);

      const cycleIdBeforeAllocation = await router.currentCycleId();
      const totalTvlBeforeAllocation = (await router.getStrategiesValue()).totalBalance;
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
      const { router, sharesToken } = await loadFixture(loadState(0));

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

    it("TVL didnt grow with compoundAll", async function() {
      const { router, sharesToken, } = await loadFixture(loadState(0));

      const cycleId = await router.currentCycleId();
      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await expect(router.compoundAll())
        .to
        .emit(router, "AfterCompound")
        .withArgs(cycleId, totalTvlBeforeCompound, totalSharesBeforeCompound);
    });

    it("TVL didnt grow with allocateToStrategies", async function() {
      const { router, sharesToken, } = await loadFixture(loadState(0));

      const cycleId = await router.currentCycleId();
      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.depositToBatch(busd.address, parseBusd("0.01"));

      await expect(router.allocateToStrategies())
        .to
        .emit(router, "AfterCompound")
        .withArgs(cycleId, totalTvlBeforeCompound, totalSharesBeforeCompound);
    });

    it("TVL reduced with compoundAll", async function() {
      const { router, sharesToken, } = await loadFixture(loadState(1000, false));

      const cycleId = await router.currentCycleId();
      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      const checkTvl = (tvl) => {
        return tvl.lt(totalTvlBeforeCompound)
      }

      await expect(router.compoundAll())
        .to
        .emit(router, "AfterCompound")
        .withArgs(cycleId, checkTvl, totalSharesBeforeCompound);
    });

    it("TVL reduced with allocateToStrategies", async function() {
      const { router, sharesToken, } = await loadFixture(loadState(10000, false));

      const cycleId = await router.currentCycleId();
      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.depositToBatch(busd.address, parseBusd("0.01"));

      const checkTvl = (tvl) => {
        return tvl.lt(totalTvlBeforeCompound)
      }

      await expect(router.allocateToStrategies())
        .to
        .emit(router, "AfterCompound")
        .withArgs(cycleId, checkTvl, totalSharesBeforeCompound);
    });

    it("TVL grown with compoundAll", async function() {
      const { router, sharesToken, } = await loadFixture(loadState(1000));

      const cycleId = await router.currentCycleId();
      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      const checkTvl = (tvl) => {
        return tvl.gt(totalTvlBeforeCompound)
      }

      await expect(router.compoundAll())
        .to
        .emit(router, "AfterCompound")
        .withArgs(cycleId, checkTvl, totalSharesBeforeCompound);
    });

    it("TVL grown with allocateToStrategies", async function() {
      const { router, sharesToken } = await loadFixture(loadState(1000));

      const cycleId = await router.currentCycleId();
      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.depositToBatch(busd.address, parseBusd("0.01"));

      const checkTvl = (tvl) => {
        return tvl.gt(totalTvlBeforeCompound)
      }

      await expect(router.allocateToStrategies())
        .to
        .emit(router, "AfterCompound")
        .withArgs(cycleId, checkTvl, totalSharesBeforeCompound);
    });
  });
});
