const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupFakeUnderFulfilledWithdrawalStrategy,
} = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { BigNumber } = require("ethers");

function expectPercentValueEqualsTo(actualPercentUniform, expectedPercent) {
  expect(actualPercentUniform).to.be.equal(
    BigNumber.from(expectedPercent).mul(BigNumber.from(10).pow(16))
  );
}

describe("Test StrategyRouter manages strategies correctly", function () {
  async function loadStateNoStrategies() {
    // deploy core contracts
    const { admin, router, oracle, batch, create2Deployer, ProxyBytecode } =
      await setupCore();
    await router.setFeesCollectionAddress(admin.address);

    // deploy mock tokens
    const { usdc, parseUsdc, busd, parseBusd, usdt, parseUsdt } =
      await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode);

    await oracle.setPrice(usdc.address, parseUsdc("1"));
    await oracle.setPrice(busd.address, parseBusd("1"));
    await oracle.setPrice(usdt.address, parseUsdt("1"));
    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(busd);
    await admin.addSupportedToken(usdt);

    const strategy1 = await setupFakeUnderFulfilledWithdrawalStrategy({
      batch,
      router,
      token: usdc,
    });
    const strategy2 = await setupFakeUnderFulfilledWithdrawalStrategy({
      batch,
      router,
      token: usdc,
    });
    const strategy3 = await setupFakeUnderFulfilledWithdrawalStrategy({
      batch,
      router,
      token: usdc,
    });
    const strategy4 = await setupFakeUnderFulfilledWithdrawalStrategy({
      batch,
      router,
      token: usdc,
    });

    return {
      admin,
      router,
      batch,
      strategy1,
      strategy2,
      strategy3,
      strategy4,
      usdc,
      busd,
      usdt,
    };
  }

  async function loadStateWithTwoStrategies() {
    const { admin, router, strategy1, strategy2, strategy3, strategy4 } =
      await loadFixture(loadStateNoStrategies);

    await admin.addStrategy(strategy1.address, 1000);
    await admin.addStrategy(strategy2.address, 3000);

    return {
      admin,
      router,
      strategy1,
      strategy2,
      strategy3,
      strategy4,
    };
  }

  async function loadAllStrategiesWeightSum(router) {
    const weight = ethers.BigNumber.from(
      await ethers.provider.getStorageAt(router.address, 112)
    );

    return weight;
  }

  describe("Test StrategyRouter tracks correct total strategy weight during strategy management", function () {
    describe("clean state", function () {
      it("checks initial weight is 0", async function () {
        const { router } = await loadFixture(loadStateNoStrategies);
        expect(await loadAllStrategiesWeightSum(router)).to.be.equal(0);
      });
      it("checks adding strategies to initial state updates total weight correctly", async function () {
        const { admin, router, strategy1, strategy2 } = await loadFixture(
          loadStateNoStrategies
        );

        await admin.addStrategy(strategy1.address, 1000);

        expect(await loadAllStrategiesWeightSum(router)).to.be.equal(1000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          100
        );

        await admin.addStrategy(strategy2.address, 3000);

        expect(await loadAllStrategiesWeightSum(router)).to.be.equal(4000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          25
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(1),
          75
        );
      });
      it("throws on out of range requests", async function () {
        const { router } = await loadFixture(loadStateNoStrategies);

        await expect(router.getStrategyPercentWeight(0)).to.be.reverted;
      });
    });
    describe("preloaded state", function () {
      it("updates strategy", async function () {
        const { admin, router } = await loadFixture(loadStateWithTwoStrategies);

        await admin.updateStrategy(1, 4000);

        expect(await loadAllStrategiesWeightSum(router)).to.be.equal(5000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          20
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(1),
          80
        );
      });
      it("removes strategy", async function () {
        const { admin, router } = await loadFixture(loadStateWithTwoStrategies);

        await admin.removeStrategy(0);

        expect(await loadAllStrategiesWeightSum(router)).to.be.equal(3000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          100
        );
      });
      it("chain of modifications", async function () {
        const { admin, router, strategy3, strategy4 } = await loadFixture(
          loadStateWithTwoStrategies
        );

        await admin.addStrategy(strategy3.address, 3000);
        await admin.addStrategy(strategy4.address, 3000);
        await admin.updateStrategy(1, 4000);
        await admin.removeStrategy(0);

        expect(await loadAllStrategiesWeightSum(router)).to.be.equal(10_000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          30
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(1),
          40
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(2),
          30
        );
      });
      it("throws on out of range requests", async function () {
        const { router } = await loadFixture(loadStateWithTwoStrategies);

        await expect(router.getStrategyPercentWeight(2)).to.be.reverted;
      });
    });
  });
  describe("Test StrategyRouter assigns correct supported token index", function () {
    it("on adding of the strategy", async function () {
      const { admin, router, batch, usdc, busd, usdt } = await loadFixture(
        loadStateNoStrategies
      );

      const strategyUsdc1 = await setupFakeUnderFulfilledWithdrawalStrategy({
        batch,
        router,
        token: usdc,
      });
      await admin.addStrategy(strategyUsdc1.address, 10_000);

      const strategyBusd1 = await setupFakeUnderFulfilledWithdrawalStrategy({
        batch,
        router,
        token: busd,
      });
      await admin.addStrategy(strategyBusd1.address, 10_000);

      const strategyUsdt1 = await setupFakeUnderFulfilledWithdrawalStrategy({
        batch,
        router,
        token: usdt,
      });
      await admin.addStrategy(strategyUsdt1.address, 10_000);

      const strategyUsdt2 = await setupFakeUnderFulfilledWithdrawalStrategy({
        batch,
        router,
        token: usdt,
      });
      await admin.addStrategy(strategyUsdt2.address, 10_000);

      const strategyBusd2 = await setupFakeUnderFulfilledWithdrawalStrategy({
        batch,
        router,
        token: busd,
      });
      admin.addStrategy(strategyBusd2.address, 10_000);

      const strategyUsdc2 = await setupFakeUnderFulfilledWithdrawalStrategy({
        batch,
        router,
        token: usdc,
      });
      await admin.addStrategy(strategyUsdc2.address, 10_000);
      const getStrategiesInfo = await router.getStrategies();

      // usdc1
      expect(
        getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
      ).to.be.equal(0);
      // busd1
      expect(
        getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
      ).to.be.equal(1);
      // usdt1
      expect(
        getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
      ).to.be.equal(2);
      // usdt2
      expect(
        getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
      ).to.be.equal(2);
      // busd2
      expect(
        getStrategiesInfo[0][4].depositTokenInSupportedTokensIndex
      ).to.be.equal(1);
      // usdc2
      expect(
        getStrategiesInfo[0][5].depositTokenInSupportedTokensIndex
      ).to.be.equal(0);
    });
    describe("on removal of supported token", function () {
      it("from begging", async function () {
        const { admin, router, batch, usdc, busd, usdt } = await loadFixture(
          loadStateNoStrategies
        );

        const strategyBusd1 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: busd,
        });
        await admin.addStrategy(strategyBusd1.address, 10_000);

        const strategyUsdt1 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdt,
        });
        await admin.addStrategy(strategyUsdt1.address, 10_000);

        const strategyUsdt2 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdt,
        });
        await admin.addStrategy(strategyUsdt2.address, 10_000);

        const strategyBusd2 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: busd,
        });
        admin.addStrategy(strategyBusd2.address, 10_000);

        var getStrategiesInfo = await router.getStrategies();
        // busd1
        expect(
          getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // usdt1
        expect(
          getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
        ).to.be.equal(2);
        // usdt2
        expect(
          getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
        ).to.be.equal(2);
        // busd2
        expect(
          getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);

        // that moves usdt from index 2 to index 0
        await admin.removeSupportedToken(usdc);
        getStrategiesInfo = await router.getStrategies();
        // busd1
        expect(
          getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // usdt1
        expect(
          getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
        // usdt2
        expect(
          getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
        // busd2
        expect(
          getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
      });
      it("from middle", async function () {
        const { admin, router, batch, usdc, busd, usdt } = await loadFixture(
          loadStateNoStrategies
        );

        const strategyUsdc1 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdc,
        });
        await admin.addStrategy(strategyUsdc1.address, 10_000);

        const strategyUsdt1 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdt,
        });
        await admin.addStrategy(strategyUsdt1.address, 10_000);

        const strategyUsdt2 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdt,
        });
        await admin.addStrategy(strategyUsdt2.address, 10_000);

        const strategyUsdc2 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdc,
        });
        admin.addStrategy(strategyUsdc2.address, 10_000);

        var getStrategiesInfo = await router.getStrategies();

        // busd1
        expect(
          getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
        // usdt1
        expect(
          getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
        ).to.be.equal(2);
        // usdt2
        expect(
          getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
        ).to.be.equal(2);
        // busd2
        expect(
          getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);

        // that moves usdt from index 2 to index 1
        await admin.removeSupportedToken(busd);

        getStrategiesInfo = await router.getStrategies();

        // busd1
        expect(
          getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
        // usdt1
        expect(
          getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // usdt2
        expect(
          getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // busd2
        expect(
          getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
      });
      it("from end", async function () {
        const { admin, router, batch, usdc, busd, usdt } = await loadFixture(
          loadStateNoStrategies
        );

        const strategyUsdc1 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdc,
        });
        await admin.addStrategy(strategyUsdc1.address, 10_000);

        const strategyBusd1 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: busd,
        });
        await admin.addStrategy(strategyBusd1.address, 10_000);

        const strategyBusd2 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: busd,
        });
        await admin.addStrategy(strategyBusd2.address, 10_000);

        const strategyUsdc2 = await setupFakeUnderFulfilledWithdrawalStrategy({
          batch,
          router,
          token: usdc,
        });
        await admin.addStrategy(strategyUsdc2.address, 10_000);

        var getStrategiesInfo = await router.getStrategies();
        // busd1
        expect(
          getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
        // usdt1
        expect(
          getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // usdt2
        expect(
          getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // busd2
        expect(
          getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);

        // that just removes usdt from tail
        await admin.removeSupportedToken(usdt);
        getStrategiesInfo = await router.getStrategies();
        // busd1
        expect(
          getStrategiesInfo[0][0].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
        // usdt1
        expect(
          getStrategiesInfo[0][1].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // usdt2
        expect(
          getStrategiesInfo[0][2].depositTokenInSupportedTokensIndex
        ).to.be.equal(1);
        // busd2
        expect(
          getStrategiesInfo[0][3].depositTokenInSupportedTokensIndex
        ).to.be.equal(0);
      });
    });
  });
});
