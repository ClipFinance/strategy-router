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

  describe('remnants', async function () {
    it('too small value are not withdraws');
    it('too small value withdrawn due to underflow on a strategy');
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

      expect(await usdc.balanceOf(strategy1.address)).to.be.equal(parseUsdc("99.950025"));
      expect(await usdc.balanceOf(strategy2.address)).to.be.equal(parseUsdc("0"));
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
  describe('weight updates are correctly handled', async function () {
  });
  describe('edge cases', async function () {
    it('money only on router');
    it('money only on strategies');
    it('money only on both router and strategies');
  })
});