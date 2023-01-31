const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy,
  deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken
} = require("./shared/commonSetup");
const { BLOCKS_MONTH, skipTimeAndBlocks, MONTH_SECONDS } = require("./utils");
const { loadFixture } = require("ethereum-waffle");


function loadState(strategyDeploymentFn) {
  return (async function() {
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
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);
    await router.setSupportedToken(usdt.address, true);

    // add fake strategies
    await strategyDeploymentFn({ router, busd, usdc, usdt });

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1000"));
    await router.allocateToStrategies();

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin
    };
  });
}

describe("Test AfterCompound event", function() {

  describe("Test AfterCompound event emitting", function() {

    it("should fire AfterCompound event after allocateToStrategies with exact values", async function() {
      const {
        router, sharesToken, busd, parseBusd
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(0)
        )
      );

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
      const {
        router, sharesToken,
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(0)
        )
      );

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
      const {
        router, sharesToken,
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(0)
        )
      );

      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.compoundAll();

      const totalTvlAfterCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesAfterCompound = await sharesToken.totalSupply();

      expect(totalTvlBeforeCompound).to.be.eq(totalTvlAfterCompound);
      expect(totalSharesBeforeCompound).to.be.eq(totalSharesAfterCompound);
    });

    it("TVL reduced with compoundAll", async function() {
      const {
        router, sharesToken,
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(1000, false)
        )
      );

      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.compoundAll();

      const totalTvlAfterCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesAfterCompound = await sharesToken.totalSupply();

      expect(totalTvlBeforeCompound).to.be.gt(totalTvlAfterCompound);
      expect(totalSharesBeforeCompound).to.be.eq(totalSharesAfterCompound);
    });

    it("TVL reduced with allocateToStrategies", async function() {
      const {
        router, sharesToken,
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(10000, false)
        )
      );

      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.depositToBatch(busd.address, parseBusd("0.01"));
      await router.allocateToStrategies();

      const totalTvlAfterCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesAfterCompound = await sharesToken.totalSupply();

      expect(totalTvlBeforeCompound).to.be.gt(totalTvlAfterCompound);
      expect(totalSharesBeforeCompound).to.be.lt(totalSharesAfterCompound);
    });

    it("TVL grown with compoundAll", async function() {
      const {
        router, sharesToken,
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(1000)
        )
      );

      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.compoundAll();

      const totalTvlAfterCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesAfterCompound = await sharesToken.totalSupply();

      expect(totalTvlBeforeCompound).to.be.lt(totalTvlAfterCompound);
      expect(totalSharesBeforeCompound).to.be.eq(totalSharesAfterCompound);
    });

    it("TVL grown with allocateToStrategies", async function() {
      const {
        router, sharesToken,
      } = await loadFixture(
        loadState(
          deployMultipleStrategies(1000)
        )
      );

      const totalTvlBeforeCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesBeforeCompound = await sharesToken.totalSupply();

      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();

      const totalTvlAfterCompound = (await router.getStrategiesValue()).totalBalance;
      const totalSharesAfterCompound = await sharesToken.totalSupply();

      expect(totalTvlBeforeCompound).to.be.lt(totalTvlAfterCompound);
      expect(totalSharesBeforeCompound).to.be.lt(totalSharesAfterCompound);
    });
  });
});

function deployMultipleStrategies(
  profitPercent, tvlGrow = true
) {
  return async function({ router, usdc, usdt, busd }) {
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: busd,
      profitPercent,
      underFulfilledWithdrawalBps: 0,
      tvlGrow
    });
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc,
      underFulfilledWithdrawalBps: 0,
      tvlGrow
    });
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdt,
      underFulfilledWithdrawalBps: 0,
      tvlGrow
    });
  };
}