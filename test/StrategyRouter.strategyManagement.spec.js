const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken,
  setupFakeUnderFulfilledWithdrawalStrategy
} = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { BigNumber, FixedNumber } = require("ethers");
const { deploy } = require("./utils");
const { constants } = require("@openzeppelin/test-helpers");

function expectPercentValueEqualsTo(actualPercentUniform, expectedPercent) {
  expect(actualPercentUniform).to.be.equal(
    BigNumber.from(expectedPercent).mul(
      BigNumber.from(10).pow(16)
    )
  );
}

describe("Test StrategyRouter manages strategies correctly", function () {
  async function loadStateNoStrategies() {
    // deploy core contracts
    const { router } = await setupCore();

    // deploy mock tokens
    const { usdc } = await setupFakeTokens();

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true, constants.ZERO_ADDRESS);

    const strategy1 = await setupFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc
    });
    const strategy2 = await setupFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc
    });
    const strategy3 = await setupFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc
    });
    const strategy4 = await setupFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc
    });

    return {
      router,
      strategy1, strategy2, strategy3, strategy4
    }
  }

  async function loadStateWithTwoStrategies() {
    const {
      router,
      strategy1, strategy2, strategy3, strategy4
    } = await loadFixture(loadStateNoStrategies);

    await router.addStrategy(
      strategy1.address,
      strategy1.token.address,
      1000,
    );
    await router.addStrategy(
      strategy2.address,
      strategy2.token.address,
      3000,
    );

    return {
      router,
      strategy1, strategy2, strategy3, strategy4
    };
  }

  describe('Test StrategyRouter tracks correct total strategy weight during strategy management', async function () {
    describe('clean state', async function() {
      it('checks initial weight is 0', async function() {
        const {
          router,
        } = await loadFixture(loadStateNoStrategies);

        expect(await router.allStrategiesWeightSum()).to.be.equal(0);
      });
      it('checks adding strategies to initial state updates total weight correctly', async function() {
        const {
          router,
          strategy1, strategy2,
        } = await loadFixture(loadStateNoStrategies);

        await router.addStrategy(
          strategy1.address,
          strategy1.token.address,
          1000,
        );

        expect(await router.allStrategiesWeightSum()).to.be.equal(1000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          100,
        );

        await router.addStrategy(
          strategy2.address,
          strategy2.token.address,
          3000,
        );

        expect(await router.allStrategiesWeightSum()).to.be.equal(4000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          25,
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(1),
          75,
        );
      });
      it('throws on out of range requests', async function () {
        const {
          router,
        } = await loadFixture(loadStateNoStrategies);

        await expect(router.getStrategyPercentWeight(0)).to.be.reverted;
      });
    });
    describe('preloaded state', async function () {
      it('updates strategy', async function () {
        const {
          router,
        } = await loadFixture(loadStateWithTwoStrategies);

        await router.updateStrategy(1, 4000);

        expect(await router.allStrategiesWeightSum()).to.be.equal(5000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          20,
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(1),
          80,
        );
      });
      it('removes strategy', async function () {
        const {
          router,
        } = await loadFixture(loadStateWithTwoStrategies);

        await router.removeStrategy(0);

        expect(await router.allStrategiesWeightSum()).to.be.equal(3000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          100,
        );
      });
      it('chain of modifications', async function () {
        const {
          router,
          strategy3, strategy4
        } = await loadFixture(loadStateWithTwoStrategies);

        await router.addStrategy(
          strategy3.address,
          strategy3.token.address,
          3000,
        );
        await router.addStrategy(
          strategy4.address,
          strategy4.token.address,
          3000,
        );
        await router.updateStrategy(1, 4000);
        await router.removeStrategy(0);

        expect(await router.allStrategiesWeightSum()).to.be.equal(10_000);
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(0),
          30,
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(1),
          40,
        );
        expectPercentValueEqualsTo(
          await router.getStrategyPercentWeight(2),
          30,
        );
      });
      it('throws on out of range requests', async function () {
        const {
          router,
        } = await loadFixture(loadStateWithTwoStrategies);

        await expect(router.getStrategyPercentWeight(2)).to.be.reverted;
      });
    });
  });
});