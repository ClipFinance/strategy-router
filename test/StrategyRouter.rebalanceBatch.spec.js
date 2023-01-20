const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("ethereum-waffle");

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
    // await router.setSupportedToken(usdt.address, true);

    // add fake strategies
    await deployFakeUnderFulfilledWithdrawalStrategy({
      router,
      token: usdc,
      underFulfilledWithdrawalBps: 0,
    });
    // await deployFakeUnderFulfilledWithdrawalStrategy({
    //   router,
    //   token: usdc,
    //   underFulfilledWithdrawalBps: 0,
    // });

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

      // set 1 USDC = 0.95 BUSD
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("0.95"));

      // to sell[busd] = 100
      // to buy[usdc] = 100
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.allocateToStrategies();

      const strategies = await router.getStrategies();
      const strategyBalanceUsdc = await usdc.balanceOf(strategies[0][0]);
      
      expect(strategyBalanceUsdc).to.be.closeTo(parseUsdc('105'), parseUsdc('0.5'));
    });
    it('test before audit fix failure');
  });
});