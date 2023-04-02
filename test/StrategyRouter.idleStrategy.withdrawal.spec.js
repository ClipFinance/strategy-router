const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { parseUniform, applySlippageInBps, convertFromUsdToTokenAmount } = require("./utils");

describe("Test idle strategies participation in withdrawals", function () {
  async function loadState(feeBps = 25) {
    const [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    const { router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore();

    // deploy mock tokens
    const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(router);

    const { exchangePlugin: fakeExchangePlugin } = await setupFakeExchangePlugin(
      oracle,
      0, // 0% slippage,
      feeBps // fee %0.25
    );
    mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc('10000000'));
    mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt('10000000'));
    mintFakeToken(fakeExchangePlugin.address, busd, parseBusd('10000000'));

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd, fakeExchangePlugin);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("10000000"));
    await usdc.approve(router.address, parseUsdc("10000000"));
    await usdt.approve(router.address, parseUsdt("10000000"));

    const expectNoRemnants = async function (contract) {
      await expectNoRemnantsFn(contract, busd, usdc, usdt);
    };

    const deployStrategy = async function ({token, weight = 10_000, underFulfilledWithdrawalBps = 0}) {
      const strategy = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token,
        underFulfilledWithdrawalBps: underFulfilledWithdrawalBps,
        weight,
      });
      strategy.token = token;
      strategy.weight = weight;

      return strategy;
    };

    await router.addSupportedToken(busd);
    await deployStrategy({ token: busd });

    await router.addSupportedToken(usdt);
    await deployStrategy({ token: usdt });

    await router.addSupportedToken(usdc);
    await deployStrategy({ token: usdc });

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin,
      expectNoRemnants, deployStrategy
    }
  }

  async function loadStateWithZeroSwapFee()
  {
    return await loadState(0);
  }

  describe('When idle strategies are not empty', async function () {
    it('idle strategy for withdrawal token fully satisfies', async function () {
      const { router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('1000'));

      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.allocateToStrategies();

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('100'));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('100')
        ),
        100 // 1% slippage
      );

      console.log(shares);
      console.log(minExpectedWithdrawAmount);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalStrategyBalance, totalIdleStrategyBalance, } =
        await router.getStrategiesValue();

      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('100'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('900'),
        parseUniform('0.1'),
      );
    });
    it('idle native token + idle other strategies satisfy', async function () {
      const { router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('50'));
      await busd.transfer(busd.idleStrategy.address, parseBusd('50'));
      await usdc.transfer(usdc.idleStrategy.address, parseUsdc('1000'));

      await router.depositToBatch(busd.address, parseBusd("150"));
      await router.allocateToStrategies();

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('150'));
      console.log('shares', shares);
      console.log('await router.calculateSharesFromReceipts(receiptIds)', await router.calculateSharesFromReceipts(receiptIds));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('150')
        ),
        100 // 1% slippage
      );

      console.log(shares);
      console.log(minExpectedWithdrawAmount);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalStrategyBalance, totalIdleStrategyBalance, } =
        await router.getStrategiesValue();

      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('150'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('950'),
        parseUniform('0.1'),
      );
    });
    it('idle native token + idle other strategies partially satisfy', async function () {
      const { router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('50'));
      await busd.transfer(busd.idleStrategy.address, parseBusd('50'));
      await usdc.transfer(usdc.idleStrategy.address, parseUsdc('50'));

      await router.depositToBatch(busd.address, parseBusd("250"));
      await router.allocateToStrategies();

      console.log('cycle', await router.cycles(0));
      console.log('getStrategiesValue', await router.getStrategiesValue());

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('200'));
      console.log('shares', shares);
      console.log('await router.calculateSharesFromReceipts(receiptIds)', await router.calculateSharesFromReceipts(receiptIds));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('200')
        ),
        100 // 1% slippage
      );

      console.log(shares);
      console.log(minExpectedWithdrawAmount);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalStrategyBalance, totalIdleStrategyBalance, } =
        await router.getStrategiesValue();

      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('200'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('0'),
        parseUniform('0.1'),
      );
    });
  });

  it('withdraws all tokens from clip', async function () {

  });
  it('verifies funds withdrawn proportially', async function () {

  });
});
