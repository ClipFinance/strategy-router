const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployProxyIdleStrategy, parseUniform } = require("./utils");

describe("Test StrategyRouter Idle API", function () {
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

  it('Correct initial state', async function () {
    const { router, usdc, busd } = await loadFixture(loadState);

    expect(await router.getIdleStrategies())
      .to.be.empty
    ;
  });
  describe('#setIdleStrategy', async function () {
    it('fails when out of range', async function () {
      const { router, usdc, busd } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await router.addSupportedToken(usdc);

      await expect(router.setIdleStrategy(1, busd.idleStrategy.address))
        .to
        .be
        .revertedWithCustomError(router, 'InvalidIndexForIdleStrategy');
    });
    it('fails when zero address provided', async function () {
      const { router, usdc, busd } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await router.addSupportedToken(usdc);

      await expect(router.setIdleStrategy(0, ethers.constants.AddressZero))
        .to
        .be
        .revertedWithCustomError(router, 'InvalidIdleStrategy');
    });
    it('fails when idle strategy token mismatch with supported token on the index', async function () {
      const { router, usdc, busd } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await router.addSupportedToken(usdc);

      await expect(router.setIdleStrategy(0, busd.idleStrategy.address))
        .to
        .be
        .revertedWithCustomError(router, 'InvalidIdleStrategy');
    });
    it('adds idle strategy correctly when no idle is set for a token', async function () {
      const { router, usdc, owner, } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await router.setSupportedToken(usdc.address, true, usdc.idleStrategy.address);

      expect((await router.idleStrategies(0)).strategyAddress)
        .to
        .be
        .equal(usdc.idleStrategy.address);
    });
    describe('replaces idle strategy correctly', async function () {
      it('no funds allocated', async function () {
        const { router, usdc, owner } = await loadFixture(loadState);

        // only 1 token is supported, index 0
        await router.addSupportedToken(usdc);

        expect((await router.idleStrategies(0)).strategyAddress)
          .to
          .be
          .equal(usdc.idleStrategy.address);
        expect((await usdc.idleStrategy.owner()))
          .to
          .be
          .equal(router.address);

        const newIdleStrategy = await deployProxyIdleStrategy(owner, router, usdc);

        // only 1 token is supported, index 0
        await router.setIdleStrategy(0, newIdleStrategy.address);

        expect((await router.idleStrategies(0)).strategyAddress)
          .to
          .be
          .equal(newIdleStrategy.address);

        expect((await usdc.idleStrategy.owner()))
          .to
          .be
          .equal(owner.address);
      });
      it('with funds allocated', async function () {
        const { router, usdc, parseUsdc, owner } = await loadFixture(loadState);

        // only 1 token is supported, index 0
        await router.addSupportedToken(usdc);

        expect((await router.idleStrategies(0)).strategyAddress)
          .to
          .be
          .equal(usdc.idleStrategy.address);
        expect((await usdc.idleStrategy.owner()))
          .to
          .be
          .equal(router.address, 'Owner mismatch');

        expect(await usdc.balanceOf(usdc.idleStrategy.address))
          .to
          .be
          .equal(0);
        await usdc.transfer(usdc.idleStrategy.address, parseUsdc('10000'));

        const newIdleStrategy = await deployProxyIdleStrategy(owner, router, usdc);
        expect(await usdc.balanceOf(newIdleStrategy.address))
          .to
          .be
          .equal(0);

        // only 1 token is supported, index 0
        await router.setIdleStrategy(0, newIdleStrategy.address);

        expect((await router.idleStrategies(0)).strategyAddress)
          .to
          .be
          .equal(newIdleStrategy.address);
        expect((await usdc.idleStrategy.owner()))
          .to
          .be
          .equal(owner.address, 'Owner mismatch');

        // check balances to ensure funds were moved
        expect(await usdc.balanceOf(usdc.idleStrategy.address))
          .to
          .be
          .equal(0);
        expect(await usdc.balanceOf(newIdleStrategy.address))
          .to
          .be
          .equal(parseUsdc('10000'));
      });
    });
  });
  // never called direclt, only indirectly on token removal
  describe('#_removeIdleStrategy', async function () {
    it('removes token from start correctly', async function () {
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

      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length)
        .to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesFormer[1].strategyAddress)
        .to.be.equal(busd.idleStrategy.address);
      expect(idleStrategiesFormer[2].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);

      const strategy = await deployStrategy({
        token: busd,
      });

      await usdc.transfer(usdc.idleStrategy.address, parseUsdc('10000'));

      await router.removeSupportedToken(usdc);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length)
        .to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);
      expect(idleStrategiesLatter[1].strategyAddress)
        .to.be.equal(busd.idleStrategy.address);

      expect(await usdc.balanceOf(usdc.idleStrategy.address))
        .to.be.equal(0);
      expect(await usdc.idleStrategy.owner())
        .to.be.equal(owner.address);

      expect(await strategy.totalTokens()).to.be.equal(parseBusd('10000'));
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(parseUniform('10000'));
    });
    it('removes token from middle correctly', async function () {
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

      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length)
        .to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesFormer[1].strategyAddress)
        .to.be.equal(busd.idleStrategy.address);
      expect(idleStrategiesFormer[2].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);

      const strategy = await deployStrategy({
        token: usdc,
      });

      await busd.transfer(busd.idleStrategy.address, parseBusd('10000'));

      await router.removeSupportedToken(busd);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length)
        .to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesLatter[1].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);

      expect(await busd.balanceOf(busd.idleStrategy.address))
        .to.be.equal(0);
      expect(await busd.idleStrategy.owner())
        .to.be.equal(owner.address);

      expect(await strategy.totalTokens()).to.be.equal(parseUsdc('10000'));
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(parseUniform('10000'));
    });
    it('removes token from end correctly', async function () {
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

      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length)
        .to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesFormer[1].strategyAddress)
        .to.be.equal(busd.idleStrategy.address);
      expect(idleStrategiesFormer[2].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);

      const strategy = await deployStrategy({
        token: busd,
      });

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt('10000'));

      await router.removeSupportedToken(usdt);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length)
        .to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesLatter[1].strategyAddress)
        .to.be.equal(busd.idleStrategy.address);

      expect(await usdt.balanceOf(usdt.idleStrategy.address))
        .to.be.equal(0);
      expect(await usdt.idleStrategy.owner())
        .to.be.equal(owner.address);

      expect(await strategy.totalTokens()).to.be.equal(parseBusd('10000'));
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(parseUniform('10000'));
    });
    it('removes token correctly when idle strategy is empty', async function () {
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

      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length)
        .to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesFormer[1].strategyAddress)
        .to.be.equal(busd.idleStrategy.address);
      expect(idleStrategiesFormer[2].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);

      const strategy = await deployStrategy({
        token: usdc,
      });

      // ensure idle strategy balance is empty
      expect(
        await busd.balanceOf(busd.idleStrategy.address)
      ).to.be.equal(0);

      await router.removeSupportedToken(busd);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length)
        .to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress)
        .to.be.equal(usdc.idleStrategy.address);
      expect(idleStrategiesLatter[1].strategyAddress)
        .to.be.equal(usdt.idleStrategy.address);

      expect(await busd.balanceOf(busd.idleStrategy.address))
        .to.be.equal(0);
      expect(await busd.idleStrategy.owner())
        .to.be.equal(owner.address);

      expect(await strategy.totalTokens()).to.be.equal(0);
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(0);
    });
  });
  describe('#getStrategiesValue', async function () {
    it('returns correct value when no idle strategies exist', async function () {
      const {
        router,
      } = await loadFixture(loadStateWithZeroSwapFee);

      const { totalBalance, balances, idleBalances } = await router.getStrategiesValue();

      expect(totalBalance).to.be.equal(0);
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

      usdc.transfer(usdc.idleStrategy.address, parseUsdc('10000'));
      usdt.transfer(usdt.idleStrategy.address, parseUsdt('1000000'));

      const { totalBalance, balances, idleBalances } = await router.getStrategiesValue();

      expect(totalBalance).to.be.equal(parseUniform((1_010_000).toString()));
      expect(balances).to.be.empty;
      expect(idleBalances[0]).to.be.equal(parseUniform((10_000).toString()));
      expect(idleBalances[1]).to.be.equal(parseUniform((0).toString()));
      expect(idleBalances[2]).to.be.equal(parseUniform((1_000_000).toString()));
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

      usdc.transfer(usdc.idleStrategy.address, parseUsdc('10000'));
      usdt.transfer(usdt.idleStrategy.address, parseUsdt('1000000'));

      await deployStrategy({ token: busd });
      await deployStrategy({ token: busd });
      await deployStrategy({ token: usdt });

      await router.depositToBatch(usdc.address, parseUsdc('15000'));

      await router.allocateToStrategies();

      const { totalBalance, balances, idleBalances } = await router.getStrategiesValue();

      expect(totalBalance).to.be.equal(parseUniform((1_025_000).toString()));
      expect(balances[0]).to.be.equal(parseUniform((5_000).toString()));
      expect(balances[1]).to.be.equal(parseUniform((5_000).toString()));
      expect(balances[2]).to.be.equal(parseUniform((5_000).toString()));
      expect(idleBalances[0]).to.be.equal(parseUniform((10_000).toString()));
      expect(idleBalances[1]).to.be.equal(parseUniform((0).toString()));
      expect(idleBalances[2]).to.be.equal(parseUniform((1_000_000).toString()));
    });
  });
  describe('supported tokens managing also manages idle strategies', async function () {
    describe('adding supported tokens', async function () {
      it('zero address for idle strategy is not allowed', async function () {
        const {
          router,
          usdc,
        } = await loadFixture(loadStateWithZeroSwapFee);

        await expect(
          router.setSupportedToken(usdc.address, true, ethers.constants.AddressZero)
        ).to.be.reverted;
      });
      it('idle strategy is added correctly', async function () {
        const {
          router,
          usdc,
        } = await loadFixture(loadStateWithZeroSwapFee);

        await router.setSupportedToken(usdc.address, true, usdc.idleStrategy.address);

        const idleStrategies = await router.getIdleStrategies();

        expect(idleStrategies[0].strategyAddress).to.be.equal(usdc.idleStrategy.address);
      });
    });
    it('idle strategy is removed correctly when a token removed', async function () {
      const {
        router,
        usdc,
      } = await loadFixture(loadStateWithZeroSwapFee);

      await router.setSupportedToken(usdc.address, true, usdc.idleStrategy.address);
      await router.setSupportedToken(usdc.address, false, ethers.constants.AddressZero);

      const idleStrategies = await router.getIdleStrategies();

      expect(idleStrategies).to.be.empty;
    });
  });
});