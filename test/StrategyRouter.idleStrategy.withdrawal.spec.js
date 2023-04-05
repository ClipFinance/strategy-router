const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken,
  setupFakeUnderFulfilledWithdrawalIdleStrategy
} = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { parseUniform, applySlippageInBps, convertFromUsdToTokenAmount } = require("./utils");

describe("Test withdrawal algorithm specifics", function () {
  async function loadCleanState(feeBps = 25) {
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

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin, deployStrategy
    }
  }

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
      fakeExchangePlugin, deployStrategy
    }
  }

  async function loadStateWithZeroSwapFee()
  {
    return await loadState(0);
  }

  describe('When idle strategies are not empty', async function () {
    it('idle strategy for withdrawal token fully satisfies', async function () {
      const { owner, router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('1000'));

      await router.depositToBatch(busd.address, parseBusd("150"));
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

      const previousBalance = await usdt.balanceOf(owner.address);
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
        parseUniform('900'),
        parseUniform('0.1'),
      );

      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('100'),
        parseUsdt('0.1'),
      );
    });
    it('idle native token + idle other strategies satisfy', async function () {
      const { owner, router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('50'));
      await busd.transfer(busd.idleStrategy.address, parseBusd('50'));
      await usdc.transfer(usdc.idleStrategy.address, parseUsdc('1000'));

      await router.depositToBatch(busd.address, parseBusd("200"));
      await router.allocateToStrategies();

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('150'));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('150')
        ),
        100 // 1% slippage
      );

      const previousBalance = await usdt.balanceOf(owner.address);
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
        parseUniform('950'),
        parseUniform('0.1'),
      );

      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('150'),
        parseUsdt('0.1'),
      );
    });
    it('idle native token + idle other strategies partially satisfy', async function () {
      const { owner, router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('50'));
      await busd.transfer(busd.idleStrategy.address, parseBusd('50'));
      await usdc.transfer(usdc.idleStrategy.address, parseUsdc('50'));

      await router.depositToBatch(busd.address, parseBusd("250"));
      await router.allocateToStrategies();

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('200'));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('200')
        ),
        100 // 1% slippage
      );

      const previousBalance = await usdt.balanceOf(owner.address);
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

      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('200'),
        parseUsdt('0.1'),
      );
    });
  });

  it('withdraws all tokens from clip', async function () {
    const { owner, router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
      await loadFixture(loadStateWithZeroSwapFee);

    oracle.setPrice(usdt.address, parseUsdt('1'));
    oracle.setPrice(busd.address, parseBusd('1'));
    oracle.setPrice(usdc.address, parseUsdc('1'));

    // all shares for owner
    await router.depositToBatch(busd.address, parseBusd("250"));
    await router.allocateToStrategies();

    // some balances on idle strategies
    await usdt.transfer(usdt.idleStrategy.address, parseUsdt('50'));
    await busd.transfer(busd.idleStrategy.address, parseBusd('50'));
    await usdc.transfer(usdc.idleStrategy.address, parseUsdc('50'));

    const receiptIds = [0];
    const shares = await router.calculateSharesFromReceipts(receiptIds);
    const sharesValueUsd = await router.calculateSharesUsdValue(shares);
    const minExpectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(
        oracle,
        busd,
        sharesValueUsd
      ),
      100 // 1% slippage
    );

    const previousBalance = await busd.balanceOf(owner.address);
    await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

    const { totalBalance, totalStrategyBalance, totalIdleStrategyBalance, } =
      await router.getStrategiesValue();

    expect(totalBalance).to.be.closeTo(
      parseUniform('0'),
      parseUniform('0.1'),
    );
    expect(totalStrategyBalance).to.be.closeTo(
      parseUniform('0'),
      parseUniform('0.1'),
    );
    expect(totalIdleStrategyBalance).to.be.closeTo(
      parseUniform('0'),
      parseUniform('0.1'),
    );

    expect(
      (await busd.balanceOf(owner.address)).sub(previousBalance)
    ).to.be.closeTo(
      parseBusd('400'),
      parseBusd('0.1'),
    );
  });
  describe('verifies funds withdrawn proportionally', async function () {
    it('when idle strategies are not empty', async function () {
      const { owner, router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      // some balances on idle strategies
      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('50'));
      await busd.transfer(busd.idleStrategy.address, parseBusd('50'));
      await usdc.transfer(usdc.idleStrategy.address, parseUsdc('50'));

      // all shares for owner
      await router.depositToBatch(busd.address, parseBusd("300"));
      await router.allocateToStrategies();

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('200'));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('200')
        ),
        100 // 1% slippage
      );

      const previousBalance = await usdt.balanceOf(owner.address);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances } =
        await router.getStrategiesValue();

      expect(totalBalance).to.be.closeTo(
        parseUniform('250'),
        parseUniform('0.1'),
      );
      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('250'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('0'),
        parseUniform('0.1'),
      );

      expect(balances[0]).to.be.closeTo(
        parseUniform('83.33'),
        parseUniform('0.1'),
      );
      expect(balances[1]).to.be.closeTo(
        parseUniform('83.33'),
        parseUniform('0.1'),
      );
      expect(balances[2]).to.be.closeTo(
        parseUniform('83.33'),
        parseUniform('0.1'),
      );

      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('200'),
        parseUsdt('0.1'),
      );
    });
    it('when idle strategies are empty', async function () {
      const { owner, router, oracle, usdt, parseUsdt, busd, parseBusd, usdc, parseUsdc, } =
        await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      // all shares for owner
      await router.depositToBatch(busd.address, parseBusd("300"));
      await router.allocateToStrategies();

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('200'));
      const minExpectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdt,
          parseUniform('200')
        ),
        100 // 1% slippage
      );

      const previousBalance = await usdt.balanceOf(owner.address);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances } =
        await router.getStrategiesValue();

      expect(totalBalance).to.be.closeTo(
        parseUniform('100'),
        parseUniform('0.1'),
      );
      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('100'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('0'),
        parseUniform('0.1'),
      );

      expect(balances[0]).to.be.closeTo(
        parseUniform('33.33'),
        parseUniform('0.1'),
      );
      expect(balances[1]).to.be.closeTo(
        parseUniform('33.33'),
        parseUniform('0.1'),
      );
      expect(balances[2]).to.be.closeTo(
        parseUniform('33.33'),
        parseUniform('0.1'),
      );

      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('200'),
        parseUsdt('0.1'),
      );
    });
  });
  describe('withdrawer pays for slippage on withdrawal rather than ongoing holders', async function () {
    it('when withdrawal served by withdrawal token idle strategy', async function () {
      const {
        owner, router, oracle,
        usdt, parseUsdt, busd,
        parseBusd, usdc, parseUsdc,
        deployStrategy
      } =
        await loadFixture(function loadCleanStateWithSwapFee () {
          return loadCleanState(0); // 0% swap fee
        });

      const idleStrategy = await setupFakeUnderFulfilledWithdrawalIdleStrategy({
        token: busd,
        underFulfilledWithdrawalBps: 5000, // 50% underflow
      });
      router.setSupportedToken(busd.address, true, idleStrategy.address);

      await deployStrategy({token: busd});

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      // all shares for owner
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.allocateToStrategies();

      await busd.transfer(idleStrategy.address, parseBusd('200'));

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('100'));
      const minExpectedWithdrawAmount = 0; // turn off slippage protection

      const previousBalance = await busd.balanceOf(owner.address);
      await router.withdrawFromStrategies(
        receiptIds,
        busd.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances } =
        await router.getStrategiesValue();

      expect(totalBalance).to.be.closeTo(
        parseUniform('250'),
        parseUniform('0.1'),
      );
      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('100'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('150'),
        parseUniform('0.1'),
      );

      // withdrawn 50 BUSD only from 100 BUSD requested
      // 50% underflow on strategy withdrawal
      expect(
        (await busd.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseBusd('50'),
        parseBusd('0.1'),
      );
    });
    it('when withdrawal served by non-withdrawal token idle strategy', async function () {
      const {
        owner, router, oracle,
        usdt, parseUsdt, busd,
        parseBusd, usdc, parseUsdc,
        deployStrategy
      } =
        await loadFixture(function loadCleanStateWithSwapFee () {
          return loadCleanState(5000); // 50% swap fee
        });

      const idleStrategy = await setupFakeUnderFulfilledWithdrawalIdleStrategy({
        token: busd,
        underFulfilledWithdrawalBps: 5000, // 50% underflow
      });
      router.setSupportedToken(busd.address, true, idleStrategy.address);

      router.addSupportedToken(usdt);

      await deployStrategy({token: busd});

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      // all shares for owner
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.allocateToStrategies();

      await busd.transfer(idleStrategy.address, parseBusd('200'));

      const receiptIds = [0];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('100'));
      const minExpectedWithdrawAmount = 0; // turn off slippage protection

      const previousBalance = await usdt.balanceOf(owner.address);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances } =
        await router.getStrategiesValue();

      expect(totalBalance).to.be.closeTo(
        parseUniform('250'),
        parseUniform('0.1'),
      );
      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('100'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('150'),
        parseUniform('0.1'),
      );

      // withdrawn 25 USDT only from 100 USDT requested
      // 50% underflow on strategy withdrawal
      // 50% swap fee
      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('25'),
        parseUsdt('0.1'),
      );
    });
    it('when withdrawal served by active strategies', async function () {
      const {
        owner, router, oracle,
        usdt, parseUsdt, busd,
        parseBusd, usdc, parseUsdc,
        deployStrategy
      } =
        await loadFixture(function loadCleanStateWithSwapFee () {
          return loadCleanState(5000); // 50% swap fee
        });

      router.addSupportedToken(busd);
      router.addSupportedToken(usdt);

      await deployStrategy({
        token: busd,
        underFulfilledWithdrawalBps: 5000, // 50% underflow
      });
      await deployStrategy({
        token: usdt,
        underFulfilledWithdrawalBps: 5000, // 50% underflow
      });

      oracle.setPrice(usdt.address, parseUsdt('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdc.address, parseUsdc('1'));

      // all shares for owner
      // deposit both BUSD and USDT to avoid swaps + swap fees
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.depositToBatch(usdt.address, parseUsdt("100"));
      await router.allocateToStrategies();

      const receiptIds = [0, 1,];
      const shares = await router.calculateSharesAmountFromUsdAmount(parseUniform('100'));
      const minExpectedWithdrawAmount = 0; // turn off slippage protection

      const previousBalance = await usdt.balanceOf(owner.address);
      await router.withdrawFromStrategies(
        receiptIds,
        usdt.address,
        shares,
        minExpectedWithdrawAmount
      );

      const { totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances } =
        await router.getStrategiesValue();

      expect(totalBalance).to.be.closeTo(
        parseUniform('150'),
        parseUniform('0.1'),
      );
      expect(totalStrategyBalance).to.be.closeTo(
        parseUniform('150'),
        parseUniform('0.1'),
      );
      expect(totalIdleStrategyBalance).to.be.closeTo(
        parseUniform('0'),
        parseUniform('0.1'),
      );

      // withdrawn 37.5 USDT only from 100 USDT requested
      // 50% underflow + 50% swap fee on BUSD strategy withdrawal
      // 50% underflow on USDT strategy withdrawal
      expect(
        (await usdt.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.closeTo(
        parseUsdt('37.5'),
        parseUsdt('0.1'),
      );
    });
  });
});
