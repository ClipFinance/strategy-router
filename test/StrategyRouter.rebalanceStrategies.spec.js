const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { BigNumber, FixedNumber } = require("ethers");

async function expectStrategyHoldsExactBalances(
  strategy,
  expectedBalanceFullUnits,
  deviationPercent = 1
) {
  const expectedBalance = BigNumber
    .from(
      FixedNumber
        .from(expectedBalanceFullUnits)
        .mulUnsafe(
          FixedNumber.from(
            BigNumber.from(10).pow(strategy.token.decimalNumber)
          )
        )
        .toFormat({decimals: 0})
        .toString()
    );

  const expectedBalanceDeviation = expectedBalance
    .mul(deviationPercent)
    .div(100);

  const strategyTokenBalance = await strategy.token.balanceOf(strategy.address);

  expect(
    strategyTokenBalance,
    `Strategy has balance ${strategyTokenBalance}`
    + ` while was expected ${expectedBalance} +/- ${expectedBalanceDeviation}`,
  ).to.be.closeTo(
    expectedBalance,
    expectedBalanceDeviation,
  );
}

describe("Test StrategyRouter.rebalanceStrategies in algorithm-specific manner", function () {
  async function loadState(feeBps = 25) {
    const [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    const { router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore();

    // deploy mock tokens
    const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens();

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

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);
    await router.setSupportedToken(usdt.address, true);

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

  describe('nothing to rebalance', async function () {
    it('rebalanceStrategies called right after allocateToStrategies', async function() {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy,
        fakeExchangePlugin
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdc,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
      });
      const strategy3 = await deployStrategy({
        token: busd,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.depositToBatch(usdt.address, parseUsdt("100"));
      await router.depositToBatch(busd.address, parseBusd("100"));
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const strategy1DepositCountInitial = await strategy1.depositCount();
      const strategy1WithdrawCountInitial = await strategy1.withdrawCount();

      const strategy2DepositCountInitial = await strategy2.depositCount();
      const strategy2WithdrawCountInitial = await strategy2.withdrawCount();

      const strategy3DepositCountInitial = await strategy3.depositCount();
      const strategy3WithdrawCountInitial = await strategy3.withdrawCount();

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      const strategy1DepositCountLast = await strategy1.depositCount();
      const strategy1WithdrawCountLast = await strategy1.withdrawCount();

      const strategy2DepositCountLast = await strategy2.depositCount();
      const strategy2WithdrawCountLast = await strategy2.withdrawCount();

      const strategy3DepositCountLast = await strategy3.depositCount();
      const strategy3WithdrawCountLast = await strategy3.withdrawCount();

      expect(strategy1DepositCountLast - strategy1DepositCountInitial).to.be.equal(0);
      expect(strategy1WithdrawCountLast - strategy1WithdrawCountInitial).to.be.equal(0);

      expect(strategy2DepositCountLast - strategy2DepositCountInitial).to.be.equal(0);
      expect(strategy2WithdrawCountLast - strategy2WithdrawCountInitial).to.be.equal(0);

      expect(strategy3DepositCountLast - strategy3DepositCountInitial).to.be.equal(0);
      expect(strategy3WithdrawCountLast - strategy3WithdrawCountInitial).to.be.equal(0);
    });
  });
  describe('current token balance vs desired strategy balance branches handling', async function () {
    describe('current token balance > desired strategy balance, delta below THRESHOLD', async function () {
      it('no swap branch', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
          weight: 10000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        // should be eligible for 4.95 USDC of 5 USDC  on rebalancing
        // 5 - 4.95 = 0.05 < threshold => all 5 USDC to be allocated to strategy2
        const strategy2 = await deployStrategy({
          token: usdc,
          weight: 9900,
        });
        // should be eligible for 0.05 USDC of 5 USDC  on rebalancing < threshold
        const strategy3 = await deployStrategy({
          token: usdc,
          weight: 100,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, 5, 0);
        await expectStrategyHoldsExactBalances(strategy2, 5, 0);
        await expectStrategyHoldsExactBalances(strategy3, 0, 0);
      });
      it('swap branch', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadStateWithZeroSwapFee);

        // 1 BUSD = 1 USDC
        await oracle.setPrice(busd.address, parseBusd("1"));
        await oracle.setPrice(usdc.address, parseUsdc("1"));

        const strategy1 = await deployStrategy({
          token: usdc,
          weight: 10000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        // should be eligible for 4.95 BUSD of 5 BUSD  on rebalancing
        // 5 - 4.95 = 0.05 < threshold => all 5 BUSD to be allocated to strategy2
        const strategy2 = await deployStrategy({
          token: busd,
          weight: 9900,
        });
        // should be eligible for 0.05 BUSD of 5 BUSD  on rebalancing < threshold
        const strategy3 = await deployStrategy({
          token: busd,
          weight: 100,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, 5, 0);
        await expectStrategyHoldsExactBalances(strategy2, 5, 0);
        await expectStrategyHoldsExactBalances(strategy3, 0, 0);
      });
    });
    describe('current token balance > desired strategy balance, delta above THRESHOLD', async function () {
      it('no swap branch', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
          weight: 10000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        // should be eligible for 4.75 USDC of 5 USDC  on rebalancing
        // 5 - 4.75 = 0.25 > threshold => 4.75 USDC to be allocated to strategy2
        const strategy2 = await deployStrategy({
          token: usdc,
          weight: 9000,
        });
        // should be eligible for 0.25 USDC of 5 USDC on rebalancing
        // 0.25 BUSD > threshold => 0.25 USDC to be allocated to strategy3
        const strategy3 = await deployStrategy({
          token: usdc,
          weight: 1000,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, 5, 0);
        await expectStrategyHoldsExactBalances(strategy2, '4.5', 0);
        await expectStrategyHoldsExactBalances(strategy3, '0.5', 0);
      });
      it('swap branch', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadStateWithZeroSwapFee);

        // 1 BUSD = 1 USDC
        await oracle.setPrice(busd.address, parseBusd("1"));
        await oracle.setPrice(usdc.address, parseUsdc("1"));

        const strategy1 = await deployStrategy({
          token: usdc,
          weight: 10000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        // should be eligible for 4.75 BUSD of 5 BUSD  on rebalancing
        // 5 - 4.75 = 0.25 > threshold => 4.75 BUSD to be allocated to strategy2
        const strategy2 = await deployStrategy({
          token: busd,
          weight: 9000,
        });
        // should be eligible for 0.25 BUSD of 50 BUSD on rebalancing
        // 0.25 BUSD > threshold => 0.25 BUSD to be allocated to strategy3
        const strategy3 = await deployStrategy({
          token: busd,
          weight: 1000,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, 5, 0);
        await expectStrategyHoldsExactBalances(strategy2, '4.5', 0);
        await expectStrategyHoldsExactBalances(strategy3, '0.5', 0);
      });
    });
    describe('current token balance < desired strategy balance', async function () {
      it('no swap branch', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadStateWithZeroSwapFee);

        // 1 BUSD = 1 USDC
        await oracle.setPrice(busd.address, parseBusd("1"));
        await oracle.setPrice(usdc.address, parseUsdc("1"));

        const strategy1 = await deployStrategy({
          token: usdc,
          weight: 5000,
        });
        const strategy2 = await deployStrategy({
          token: busd,
          weight: 5000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        // should be eligible for 5 USDC
        // 2.5 USDC and 2.5 BUSD withdrawn
        const strategy3 = await deployStrategy({
          token: usdc,
          weight: 10000,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, '2.5', 0);
        await expectStrategyHoldsExactBalances(strategy2, '2.5', 0);
        await expectStrategyHoldsExactBalances(strategy3, '5', 0);
      });
      it('swap branch', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadStateWithZeroSwapFee);

        // 1 BUSD = 1 USDC = 1 USDT
        await oracle.setPrice(busd.address, parseBusd("1"));
        await oracle.setPrice(usdc.address, parseUsdc("1"));
        await oracle.setPrice(usdt.address, parseUsdt("1"));

        const strategy1 = await deployStrategy({
          token: usdc,
          weight: 5000,
        });
        const strategy2 = await deployStrategy({
          token: busd,
          weight: 5000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        // should be eligible for 5 USDT
        // 2.5 USDC and 2.5 BUSD withdrawn
        const strategy3 = await deployStrategy({
          token: usdt,
          weight: 10000,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, '2.5', 0);
        await expectStrategyHoldsExactBalances(strategy2, '2.5', 0);
        await expectStrategyHoldsExactBalances(strategy3, '5', 0);
      });
    });
  });
  describe('no remnants', async function () {
    it('general case', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      const strategy1 = await deployStrategy({
        token: usdc,
      });
      const strategy2 = await deployStrategy({
        token: busd,
      });

      await router.depositToBatch(usdc.address, parseUsdc("50"));
      await router.depositToBatch(busd.address, parseBusd("50"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const strategy3 = await deployStrategy({
        token: usdt,
      });

      await usdt.transfer(router.address, parseUsdt('20'));

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      expect(await usdc.balanceOf(router.address)).to.be.equal(0);
      expect(await busd.balanceOf(router.address)).to.be.equal(0);
      expect(await usdt.balanceOf(router.address)).to.be.equal(0);

      await expectStrategyHoldsExactBalances(strategy1, 40);
      await expectStrategyHoldsExactBalances(strategy2, 40);
      await expectStrategyHoldsExactBalances(strategy3, 40);
    });
    describe('asadasdas', async function () {
      it('no swap happens', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadStateWithZeroSwapFee);

        const strategy1 = await deployStrategy({
          token: usdc,
        });
        const strategy2 = await deployStrategy({
          token: usdc,
        });
        const strategy3 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("60"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        await usdc.transfer(router.address, parseUsdc('100'));

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        expect(await usdc.balanceOf(router.address)).to.be.equal(0);
        expect(await busd.balanceOf(router.address)).to.be.equal(0);
        expect(await usdt.balanceOf(router.address)).to.be.equal(0);

        await expectStrategyHoldsExactBalances(strategy1, '53.33');
        await expectStrategyHoldsExactBalances(strategy2, '53.33');
        await expectStrategyHoldsExactBalances(strategy3, '53.33');
      });
      it('swap happens', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadStateWithZeroSwapFee);

        const strategy1 = await deployStrategy({
          token: usdc,
        });
        const strategy2 = await deployStrategy({
          token: usdc,
        });
        const strategy3 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("60"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        await usdt.transfer(router.address, parseUsdt('100'));

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        expect(await usdc.balanceOf(router.address)).to.be.equal(0);
        expect(await busd.balanceOf(router.address)).to.be.equal(0);
        expect(await usdt.balanceOf(router.address)).to.be.equal(0);

        await expectStrategyHoldsExactBalances(strategy1, '53.33');
        await expectStrategyHoldsExactBalances(strategy2, '53.33');
        await expectStrategyHoldsExactBalances(strategy3, '53.33');
      });
    });
    it('too small value are not withdraws');
    it('too small value withdrawn due to underflow on a strategy');
    // 2 cases when remnants not exterminated from Router balance
    // skip until Idle strategies implemented
    // all remnants will be dispersed to idle strategies
    it.skip('when router token balances below THRESHOLD', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      const strategy1 = await deployStrategy({
        token: usdc,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await usdc.transfer(router.address, parseUsdc('0.05'));
      await busd.transfer(router.address, parseBusd('0.05'));
      await usdt.transfer(router.address, parseUsdt('0.05'));

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      expect(await usdc.balanceOf(router.address)).to.be.equal(0);
      expect(await busd.balanceOf(router.address)).to.be.equal(0);
      expect(await usdt.balanceOf(router.address)).to.be.equal(0);

      await expectStrategyHoldsExactBalances(strategy1, 100, 0);
    });
    // skip until Idle strategies implemented
    // all remnants will be dispersed to idle strategies
    it.skip('when router token balances below THRESHOLD due to underflowal withdraws on strategies', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      // 1 BUSD = 1 USDT = 1 USDC
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const strategy1 = await deployStrategy({
        token: usdc,
        underFulfilledWithdrawalBps: 9990,
      });
      const strategy2 = await deployStrategy({
        token: busd,
        underFulfilledWithdrawalBps: 9990,
      });
      const strategy3 = await deployStrategy({
        token: usdt,
        underFulfilledWithdrawalBps: 9990,
      });

      await router.depositToBatch(usdc.address, parseUsdc("30"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(await usdc.balanceOf(router.address)).to.be.equal(0);
      expect(await busd.balanceOf(router.address)).to.be.equal(0);
      expect(await usdt.balanceOf(router.address)).to.be.equal(0);

      // after rebalance expected balance here is 300 / 4 = 75
      // but due to underflow the actual balanace will be 0
      const strategy4 = await deployStrategy({
        token: usdt
      });

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      await expectStrategyHoldsExactBalances(strategy4, 0, 0);

      expect(await usdc.balanceOf(router.address)).to.be.equal(0);
      expect(await busd.balanceOf(router.address)).to.be.equal(0);
      expect(await usdt.balanceOf(router.address)).to.be.equal(0);
    });
  });
  describe('optimisations', async function () {
    describe('swap optimisations', async function () {
      it('no swaps are made when there is a native token', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
        });
        const strategy2 = await deployStrategy({
          token: usdt,
        });
        const strategy3 = await deployStrategy({
          token: busd,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await router.depositToBatch(usdt.address, parseUsdt("100"));
        await router.depositToBatch(busd.address, parseBusd("100"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy4 = await deployStrategy({
          token: busd,
        });
        const strategy5 = await deployStrategy({
          token: usdc,
        });
        const strategy6 = await deployStrategy({
          token: usdt,
        });
        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(0);
      });
      it('only necessary swaps are made', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy,
          fakeExchangePlugin
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
        });
        const strategy2 = await deployStrategy({
          token: usdt,
        });
        const strategy3 = await deployStrategy({
          token: usdt,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await router.depositToBatch(usdt.address, parseUsdt("200"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy4 = await deployStrategy({
          token: usdt,
        });
        const strategy5 = await deployStrategy({
          token: busd,
        });
        const strategy6 = await deployStrategy({
          token: usdc,
        });
        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(1);
      });
    });
    describe('deposit called min amount of times', async function () {
      it('token and strategy match', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy1DepositCountInitial = await strategy1.depositCount();

        const strategy2 = await deployStrategy({
          token: usdc,
        });
        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        const strategy1DepositCountLast = await strategy1.depositCount();
        const strategy2DepositCountLast = await strategy2.depositCount();

        expect(strategy1DepositCountLast - strategy1DepositCountInitial)
          .to.be.equal(0);
        expect(strategy2DepositCountLast).to.be.equal(1);
      });
      it('token and strategy doesnt match', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy1DepositCountInitial = await strategy1.depositCount();

        const strategy2 = await deployStrategy({
          token: busd,
        });
        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        const strategy1DepositCountLast = await strategy1.depositCount();
        const strategy2DepositCountLast = await strategy2.depositCount();

        expect(strategy1DepositCountLast - strategy1DepositCountInitial)
          .to.be.equal(0);
        expect(strategy2DepositCountLast).to.be.equal(1);
      });
      it('complicated case', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: busd,
        });
        const strategy2 = await deployStrategy({
          token: busd,
        });
        const strategy3 = await deployStrategy({
          token: usdc,
        });
        const strategy4 = await deployStrategy({
          token: usdt,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy1DepositCountInitial = await strategy1.depositCount();
        const strategy2DepositCountInitial = await strategy2.depositCount();
        const strategy3DepositCountInitial = await strategy3.depositCount();
        const strategy4DepositCountInitial = await strategy4.depositCount();

        const strategy5 = await deployStrategy({
          token: busd,
        });
        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        const strategy1DepositCountLast = await strategy1.depositCount();
        const strategy2DepositCountLast = await strategy2.depositCount();
        const strategy3DepositCountLast = await strategy3.depositCount();
        const strategy4DepositCountLast = await strategy4.depositCount();
        const strategy5DepositCountLast = await strategy5.depositCount();

        expect(strategy1DepositCountLast - strategy1DepositCountInitial).to.be.equal(0);
        expect(strategy2DepositCountLast - strategy2DepositCountInitial).to.be.equal(0);
        expect(strategy3DepositCountLast - strategy3DepositCountInitial).to.be.equal(0);
        expect(strategy4DepositCountLast - strategy4DepositCountInitial).to.be.equal(0);
        expect(strategy5DepositCountLast).to.be.equal(1);
      });
    });
    describe('withdraw', async function () {
      it('withdraw called min amount of times', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy2 = await deployStrategy({
          token: usdc,
        });
        const strategy3 = await deployStrategy({
          token: usdc,
        });
        const strategy4 = await deployStrategy({
          token: busd,
        });
        const strategy5 = await deployStrategy({
          token: busd,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        expect(await strategy1.withdrawCount()).to.be.equal(1);
        expect(await strategy2.withdrawCount()).to.be.equal(0);
        expect(await strategy3.withdrawCount()).to.be.equal(0);
        expect(await strategy4.withdrawCount()).to.be.equal(0);
        expect(await strategy5.withdrawCount()).to.be.equal(0);
      });
      it('withdraw is not called if required balance on router', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy2 = await deployStrategy({
          token: usdc,
        });
        await usdc.transfer(router.address, parseUsdc('100'));

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        expect(await strategy1.withdrawCount()).to.be.equal(0);
        expect(await strategy2.withdrawCount()).to.be.equal(0);
      });
    });
  });
  describe('below threshold token balances are not taken into account', async function () {
    it('default below threshold balances', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      // 1 BUSD = 1 USDT
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const strategy1 = await deployStrategy({
        token: usdc,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await busd.transfer(router.address, parseBusd("0.05"));
      await usdt.transfer(router.address, parseUsdt("0.05"));

      const strategy2 = await deployStrategy({
        token: usdc,
      });

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      // total re-allocated balance is 100 USDC
      // 0.05 BUSD and 0.05 USDT are ignored
      expect(await usdc.balanceOf(strategy1.address)).to.be.equal(parseUsdc("50.05"));
      expect(await usdc.balanceOf(strategy2.address)).to.be.equal(parseUsdc("49.95"));
    });
    it('default below threshold balances and below threshold withdrawal', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      // 1 BUSD = 1 USDT
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const strategy1 = await deployStrategy({
        token: usdc,
        // out of 49.95 to be withdrawn only 0.04995 will actually be withdrawn
        underFulfilledWithdrawalBps: 9990
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await usdc.transfer(router.address, parseUsdc("0.05"));

      const strategy2 = await deployStrategy({
        token: usdc,
      });

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      // total is less than 100 USDC cause of severe underflow on withdrawal
      expect(await usdc.balanceOf(strategy1.address)).to.be.equal(parseUsdc("99.950025"));
      expect(await usdc.balanceOf(strategy2.address)).to.be.equal(parseUsdc("0"));
    });
    it('default below threshold balances and below threshold withdrawal, native tokens allocated', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      // 1 BUSD = 1 USDT = 1 USDC
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const strategy1 = await deployStrategy({
        token: usdc,
        // out of 49.95 to be withdrawn only 0.04995 will actually be withdrawn
        underFulfilledWithdrawalBps: 9990
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await busd.transfer(router.address, parseBusd("10"));

      const strategy2 = await deployStrategy({
        token: usdc,
      });

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      // total is less than 100 USDC cause of severe underflow on withdrawal
      expect(await usdc.balanceOf(strategy1.address)).to.be.equal(parseUsdc("99.955"));
      expect(await usdc.balanceOf(strategy2.address)).to.be.equal(parseUsdc("10"));
    });
  });
  describe('test funds on the contract are taken into account', async function () {
    it('rebalances funds on router', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdc,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await usdc.transfer(router.address, parseUsdc('100'));
      await busd.transfer(router.address, parseBusd('100'));
      await usdt.transfer(router.address, parseUsdt('100'));

      await router.rebalanceStrategies();
      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      await expectStrategyHoldsExactBalances(strategy1, 400);
    });
  });
  describe('THRESHOLD compliance testing', async function () {
    it('rebalancing doesnt happen if weight changes below threshold', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdc,
        weight: 10000,
      });
      const strategy2 = await deployStrategy({
        token: usdc,
        weight: 10000,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await router.updateStrategy(0, 10010);
      await router.updateStrategy(0, 9990);

      await router.rebalanceStrategies();
      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      await expectStrategyHoldsExactBalances(strategy1, 50, 0);
      await expectStrategyHoldsExactBalances(strategy2, 50, 0);
    });
  });
  describe('weight manipulation when differs from default weights', async function () {
    it('', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      // 1 BUSD = 1 USDT = 1 USDC
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));

      const strategy1 = await deployStrategy({
        token: usdc,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      // here weight of each strategy is 33.33%
      // but unallocated funds will be split 50%-50% between strategy 2 and 3
      // strategy 1 stays untouched
      const strategy2 = await deployStrategy({
        token: usdc,
      });
      const strategy3 = await deployStrategy({
        token: busd,
      });

      await usdc.transfer(router.address, parseUsdc("50"));
      await usdt.transfer(router.address, parseUsdt("150"));

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      expect(await strategy1.withdrawCount()).to.be.equal(0);

      await expectStrategyHoldsExactBalances(strategy1, 100, 0);
      await expectStrategyHoldsExactBalances(strategy2, 100, 0);
      await expectStrategyHoldsExactBalances(strategy3, 100, 0);
    });
  });
  describe('exchange rate change doesnt affect calculations', async function () {
    describe('absolute token number is used for allocation calculations even on high volatility', async function () {
      it('no swap happens', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadStateWithZeroSwapFee);

        // 1 BUSD = 2 USDT = 4 USDC
        await oracle.setPrice(busd.address, parseBusd("2"));
        await oracle.setPrice(usdt.address, parseUsdt("1"));
        await oracle.setPrice(usdc.address, parseUsdc("0.5"));

        const strategy1 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy2 = await deployStrategy({
          token: busd,
        });
        const strategy3 = await deployStrategy({
          token: usdt,
        });

        await usdt.transfer(router.address, parseUsdt("100"));
        await busd.transfer(router.address, parseBusd("100"));

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, 100, 0);
        await expectStrategyHoldsExactBalances(strategy2, 100, 0);
        await expectStrategyHoldsExactBalances(strategy3, 100, 0);
      });
      it('swap happens', async function () {
        const {
          router, oracle,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          batch,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadStateWithZeroSwapFee);

        // 1 BUSD = 2 USDT = 4 USDC
        await oracle.setPrice(busd.address, parseBusd("2"));
        await oracle.setPrice(usdt.address, parseUsdt("1"));
        await oracle.setPrice(usdc.address, parseUsdc("0.5"));

        const strategy1 = await deployStrategy({
          token: usdc,
        });

        await router.depositToBatch(usdc.address, parseUsdc("300"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        const strategy2 = await deployStrategy({
          token: busd,
        });
        const strategy3 = await deployStrategy({
          token: usdt,
        });

        await expect(router.rebalanceStrategies()).not.to.be.reverted;

        await expectStrategyHoldsExactBalances(strategy1, 100, 0);
        await expectStrategyHoldsExactBalances(strategy2, 25, 0);
        await expectStrategyHoldsExactBalances(strategy3, 50, 0);
      });
    });
    it('changed rates dont trigger rebalance', async function () {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroSwapFee);

      // 1 BUSD = 1 USDT = 1 USDC
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));

      const strategy1 = await deployStrategy({
        token: usdc,
      });
      const strategy2 = await deployStrategy({
        token: busd,
      });
      const strategy3 = await deployStrategy({
        token: usdt,
      });

      await router.depositToBatch(usdc.address, parseUsdc("300"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const strategy1DepositCountInitial = await strategy1.depositCount();
      const strategy1WithdrawCountInitial = await strategy1.withdrawCount();

      const strategy2DepositCountInitial = await strategy2.depositCount();
      const strategy2WithdrawCountInitial = await strategy2.withdrawCount();

      const strategy3DepositCountInitial = await strategy3.depositCount();
      const strategy3WithdrawCountInitial = await strategy3.withdrawCount();

      // 1 BUSD = 2 USDT = 4 USDC
      await oracle.setPrice(busd.address, parseBusd("2"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));
      await oracle.setPrice(usdc.address, parseUsdc("0.5"));

      await expect(router.rebalanceStrategies()).not.to.be.reverted;

      await expectStrategyHoldsExactBalances(strategy1, 100, 0);
      await expectStrategyHoldsExactBalances(strategy2, 100, 0);
      await expectStrategyHoldsExactBalances(strategy3, 100, 0);

      const strategy1DepositCountLast = await strategy1.depositCount();
      const strategy1WithdrawCountLast = await strategy1.withdrawCount();

      const strategy2DepositCountLast = await strategy2.depositCount();
      const strategy2WithdrawCountLast = await strategy2.withdrawCount();

      const strategy3DepositCountLast = await strategy3.depositCount();
      const strategy3WithdrawCountLast = await strategy3.withdrawCount();

      expect(strategy1DepositCountLast - strategy1DepositCountInitial).to.be.equal(0);
      expect(strategy1WithdrawCountLast - strategy1WithdrawCountInitial).to.be.equal(0);

      expect(strategy2DepositCountLast - strategy2DepositCountInitial).to.be.equal(0);
      expect(strategy2WithdrawCountLast - strategy2WithdrawCountInitial).to.be.equal(0);

      expect(strategy3DepositCountLast - strategy3DepositCountInitial).to.be.equal(0);
      expect(strategy3WithdrawCountLast - strategy3WithdrawCountInitial).to.be.equal(0);
    });
  });
  describe('edge cases', async function () {
    it('money only on router');
    it('money only on strategies');
    it('money only on both router and strategies');
  })
});