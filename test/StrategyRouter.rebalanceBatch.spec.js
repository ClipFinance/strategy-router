const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("ethereum-waffle");
const { BigNumber } = require("ethers");

describe("Test StrategyRouter.withdrawFromStrategies reverts", function () {
  async function loadState(rateCoefBps = 0) {
    const [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    const { router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore();

    // deploy mock tokens
    const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens();

    const { exchangePlugin: fakeExchangePlugin } = await setupFakeExchangePlugin(
      oracle,
      0, // 0% slippage,
      25 // fee %0.25
    );
    mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc('10000000'));
    mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt('10000000'));
    mintFakeToken(fakeExchangePlugin.address, busd, parseBusd('10000000'));

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

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin
    }
  }

  describe("when withdraw from a single strategy", async function () {
    it('receive more tokens than sold', async function() {
      const { router, oracle, busd, parseBusd, usdc, parseUsdc, batch } = await loadFixture(loadState);
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
      });

      // set 1 USDC = 0.95 BUSD
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("0.95"));

      await router.depositToBatch(busd.address, parseBusd("100"));

      // to sell[busd] = 100
      // to buy[usdc] = 100
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const strategies = await router.getStrategies();
      const strategyBalanceUsdc = await usdc.balanceOf(strategies[0][0]);

      expect(strategyBalanceUsdc).to.be.closeTo(parseUsdc('105'), parseUsdc('0.5'));
    });
    it('no leftovers on Batch after rebalance', async function() {
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
      } = await loadFixture(loadState);
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
      });

      // set 1 USDC = 0.95 BUSD
      // set 1 USDC = 0.95 USDT
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));
      await oracle.setPrice(usdc.address, parseUsdc("0.95"));

      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.depositToBatch(usdt.address, parseUsdt("100"));

      // to sell[busd] = 100
      // to sell[usdt] = 100
      // to buy[usdc] = 200
      // after the first iteration USDC really bought is 100 / 0.95 = 105.2631
      // BUT buy[usdc] MUST be 200-100 = 100 to avoid leftovers
      await router.allocateToStrategies();

      expect(
        await busd.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
      expect(
        await usdt.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
    });
    it('no remnants on strategy supported tokens', async function () {
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
      } = await loadFixture(loadState);

      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 9950,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 50,
      });

      await router.depositToBatch(busd.address, parseBusd("10"));

      // 1 BUSD = 1 USDC
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(
        await busd.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
      expect(
        await usdt.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
    });
    it('busd busd', async function () {
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
      } = await loadFixture(loadState);

      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 9950,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 50,
      });

      await router.depositToBatch(busd.address, parseBusd("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(
        await busd.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
    });
    it('3 strategies, 3 deposit tokens, 1 strategy with super low weight', async function() {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
      } = await loadFixture(loadState);

      const strategyUsdc = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 4975,
      });
      const strategyBusd = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 4975,
      });
      const strategyUsdt = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 50,
      });

      await router.depositToBatch(usdt.address, parseUsdt("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(
        await usdt.balanceOf(batch.address)
      ).to.be.equal(BigNumber.from(0));

      expect(
        await usdc.balanceOf(strategyUsdc.address)
      ).to.be.closeTo(parseUsdc("5"), parseUsdc("0.1"));
      expect(
        await busd.balanceOf(strategyBusd.address)
      ).to.be.closeTo(parseBusd("5"), parseBusd("0.1"));
      expect(
        await usdt.balanceOf(strategyUsdt.address)
      ).to.be.closeTo(parseUsdt("0"), parseUsdt("0"));
    });
    it(
      'add slight math overflow check when desired balance greater than token balance, token is the same',
      async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 50_000_000_100,
        });
        await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 49_999_999_900,
        });

        await router.depositToBatch(usdt.address, parseUsdt("10"));
        await router.depositToBatch(busd.address, parseBusd("10"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.equal(BigNumber.from(0));
        expect(
          await busd.balanceOf(batch.address)
        ).to.be.equal(BigNumber.from(0));
      }
    );
    it('2 small weight strategies, 1 normal weight, test for dust', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
      } = await loadFixture(loadState);

      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 50,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 50,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 9900,
      });

      await router.depositToBatch(busd.address, parseBusd("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(
        await busd.balanceOf(batch.address)
      ).to.be.equal(BigNumber.from(0));
    });
    it('test no swap occurs', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
      } = await loadFixture(loadState);

      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.depositToBatch(busd.address, parseBusd("100"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(
        await usdc.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
      expect(
        await busd.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

      expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(0);
    });
    it('test before audit fix failure');
    it('test unoptimal orders of tokens and strategies');
    it('ensure tokenBalanceUniform > desiredBalanceUniform branches is checked');
    it('ensure all branches are tested');
    it('check no remnants on batch more extensively');
  });
});