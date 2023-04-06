const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployProxyIdleStrategy, parseUniform } = require("./utils");

describe("Test StrategyRouter Strategy Data API", function () {
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
    mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc(10_000_000));
    mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt(10_000_000));
    mintFakeToken(fakeExchangePlugin.address, busd, parseBusd(10_000_000));

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd, fakeExchangePlugin);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd(10_000_000));
    await usdc.approve(router.address, parseUsdc(10_000_000));
    await usdt.approve(router.address, parseUsdt(10_000_000));

    const expectNoRemnants = async function(contract) {
      await expectNoRemnantsFn(contract, busd, usdc, usdt);
    };

    const deployStrategy = async function({ token, weight = 10_000, underFulfilledWithdrawalBps = 0 }) {
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

  async function loadStateWithZeroSwapFee() {
    return await loadState(0);
  }

  describe('#getStrategiesValue', async function () {
    it('returns correct value when no idle strategies exist', async function () {
      const {
        router,
      } = await loadFixture(loadStateWithZeroSwapFee);

      const {
        totalBalance,
        totalStrategyBalance,
        totalIdleStrategyBalance,
        balances,
        idleBalances
      } = await router.getStrategiesValue();

      expect(totalBalance).to.be.equal(0);
      expect(totalStrategyBalance).to.be.equal(0);
      expect(totalIdleStrategyBalance).to.be.equal(0);
      expect(balances).to.be.empty;
      expect(idleBalances).to.be.empty;
    });
    it('returns correct value when no active strategies exist', async function () {
      const {
        router, oracle,
        usdc, parseUsdc,
        busd, parseBusd,
        usdt, parseUsdt,
        owner,
      } = await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdc.address, parseUsdc('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdt.address, parseUsdt('1'));

      router.addSupportedToken(usdc);
      router.addSupportedToken(busd);
      router.addSupportedToken(usdt);

      usdc.transfer(usdc.idleStrategy.address, parseUsdc(10_000));
      usdt.transfer(usdt.idleStrategy.address, parseUsdt(1_000_000));

      const {
        totalBalance,
        totalStrategyBalance,
        totalIdleStrategyBalance,
        balances,
        idleBalances
      } = await router.getStrategiesValue();

      expect(totalBalance).to.be.equal(parseUniform(1_010_000));
      expect(totalStrategyBalance).to.be.equal(0);
      expect(totalIdleStrategyBalance).to.be.equal(parseUniform(1_010_000));
      expect(balances).to.be.empty;
      expect(idleBalances[0]).to.be.equal(parseUniform(10_000));
      expect(idleBalances[1]).to.be.equal(0);
      expect(idleBalances[2]).to.be.equal(parseUniform(1_000_000));
    });
    it('returns correct value when active strategies exist', async function () {
      const {
        router, oracle,
        usdc, parseUsdc,
        busd, parseBusd,
        usdt, parseUsdt,
        deployStrategy,
        owner,
      } = await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdc.address, parseUsdc('1'));
      oracle.setPrice(busd.address, parseBusd('1'));
      oracle.setPrice(usdt.address, parseUsdt('1'));

      router.addSupportedToken(usdc);
      router.addSupportedToken(busd);
      router.addSupportedToken(usdt);

      usdc.transfer(usdc.idleStrategy.address, parseUsdc(10_000));
      usdt.transfer(usdt.idleStrategy.address, parseUsdt(1_000_000));

      await deployStrategy({ token: busd });
      await deployStrategy({ token: busd });
      await deployStrategy({ token: usdt });

      await router.depositToBatch(usdc.address, parseUsdc(15_000));

      await router.allocateToStrategies();

      const {
        totalBalance,
        totalStrategyBalance,
        totalIdleStrategyBalance,
        balances,
        idleBalances
      } = await router.getStrategiesValue();

      expect(totalBalance).to.be.equal(parseUniform(1_025_000));
      expect(totalStrategyBalance).to.be.equal(parseUniform(15_000));
      expect(totalIdleStrategyBalance).to.be.equal(parseUniform(1_010_000));
      expect(balances[0]).to.be.equal(parseUniform(5_000));
      expect(balances[1]).to.be.equal(parseUniform(5_000));
      expect(balances[2]).to.be.equal(parseUniform(5_000));
      expect(idleBalances[0]).to.be.equal(parseUniform(10_000));
      expect(idleBalances[1]).to.be.equal(parseUniform(0));
      expect(idleBalances[2]).to.be.equal(parseUniform(1_000_000));
    });
  });
});