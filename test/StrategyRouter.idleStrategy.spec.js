const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTestParams,
  deployFakeUnderFulfilledWithdrawalStrategy,
  setupFakeExchangePlugin,
  mintFakeToken,
} = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployProxyIdleStrategy, parseUniform } = require("./utils");

describe("Test StrategyRouter Idle API", function () {
  async function loadState(feeBps = 25) {
    const [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    const {
      router,
      oracle,
      exchange,
      admin,
      batch,
      receiptContract,
      sharesToken,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore();

    // deploy mock tokens
    const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode);

    const { exchangePlugin: fakeExchangePlugin } =
      await setupFakeExchangePlugin(
        oracle,
        0, // 0% slippage,
        feeBps // fee %0.25
      );
    mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc("10000000"));
    mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt("10000000"));
    mintFakeToken(fakeExchangePlugin.address, busd, parseBusd("10000000"));

    // setup params for testing
    await setupTestParams(
      router,
      oracle,
      exchange,
      admin,
      usdc,
      usdt,
      busd,
      fakeExchangePlugin
    );

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("10000000"));
    await usdc.approve(router.address, parseUsdc("10000000"));
    await usdt.approve(router.address, parseUsdt("10000000"));

    const expectNoRemnants = async function (contract) {
      await expectNoRemnantsFn(contract, busd, usdc, usdt);
    };

    const deployStrategy = async function ({
      token,
      weight = 10_000,
      underFulfilledWithdrawalBps = 0,
    }) {
      const strategy = await deployFakeUnderFulfilledWithdrawalStrategy({
        admin,
        batch,
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
      owner,
      nonReceiptOwner,
      router,
      oracle,
      exchange,
      admin,
      batch,
      receiptContract,
      sharesToken,
      usdc,
      usdt,
      busd,
      parseUsdc,
      parseBusd,
      parseUsdt,
      fakeExchangePlugin,
      expectNoRemnants,
      deployStrategy,
      create2Deployer,
      ProxyBytecode,
    };
  }

  async function loadStateWithZeroSwapFee() {
    return await loadState(0);
  }

  it("Correct initial state", async function () {
    const { router, usdc, busd } = await loadFixture(loadState);

    expect(await router.getIdleStrategies()).to.be.empty;
  });
  describe("#setIdleStrategy", async function () {
    it("fails when out of range", async function () {
      const { admin, router, usdc, busd } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await admin.addSupportedToken(usdc);

      await expect(
        admin.setIdleStrategy(1, busd.idleStrategy.address)
      ).to.be.revertedWithCustomError(router, "InvalidIndexForIdleStrategy");
    });
    it("fails when zero address provided", async function () {
      const { admin, router, usdc, busd } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await admin.addSupportedToken(usdc);

      await expect(
        admin.setIdleStrategy(0, ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(router, "InvalidIdleStrategy");
    });
    it("fails when idle strategy token mismatch with supported token on the index", async function () {
      const { admin, router, usdc, busd } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await admin.addSupportedToken(usdc);

      await expect(
        admin.setIdleStrategy(0, busd.idleStrategy.address)
      ).to.be.revertedWithCustomError(router, "InvalidIdleStrategy");
    });
    it("adds idle strategy correctly when no idle is set for a token", async function () {
      const { admin, router, usdc, owner } = await loadFixture(loadState);

      // only 1 token is supported, index 0
      await admin.setSupportedToken(
        usdc.address,
        true,
        usdc.idleStrategy.address
      );

      expect((await router.getIdleStrategies())[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
    });
    describe("replaces idle strategy correctly", async function () {
      it("no funds allocated", async function () {
        const {
          admin,
          router,
          batch,
          usdc,
          owner,
          create2Deployer,
          ProxyBytecode,
        } = await loadFixture(loadState);

        // only 1 token is supported, index 0
        await admin.addSupportedToken(usdc);

        expect(
          (await router.getIdleStrategies())[0].strategyAddress
        ).to.be.equal(usdc.idleStrategy.address);
        expect(await usdc.idleStrategy.owner()).to.be.equal(router.address);

        const newIdleStrategy = await deployProxyIdleStrategy(
          owner,
          batch,
          router,
          admin.address,
          usdc,
          "Dummy",
          create2Deployer,
          ProxyBytecode
        );

        // only 1 token is supported, index 0
        await admin.setIdleStrategy(0, newIdleStrategy.address);

        expect(
          (await router.getIdleStrategies())[0].strategyAddress
        ).to.be.equal(newIdleStrategy.address);

        expect(await usdc.idleStrategy.owner()).to.be.equal(admin.address);
      });
      it("with funds allocated", async function () {
        const {
          admin,
          batch,
          router,
          usdc,
          parseUsdc,
          owner,
          create2Deployer,
          ProxyBytecode,
        } = await loadFixture(loadState);

        // only 1 token is supported, index 0
        await admin.addSupportedToken(usdc);

        expect(
          (await router.getIdleStrategies())[0].strategyAddress
        ).to.be.equal(usdc.idleStrategy.address);
        expect(await usdc.idleStrategy.owner()).to.be.equal(
          router.address,
          "Owner mismatch"
        );

        expect(await usdc.balanceOf(usdc.idleStrategy.address)).to.be.equal(0);
        await usdc.transfer(usdc.idleStrategy.address, parseUsdc("10000"));

        const newIdleStrategy = await deployProxyIdleStrategy(
          owner,
          batch,
          router,
          admin.address,
          usdc,
          "Dummy",
          create2Deployer,
          ProxyBytecode
        );
        expect(await usdc.balanceOf(newIdleStrategy.address)).to.be.equal(0);

        // only 1 token is supported, index 0
        await admin.setIdleStrategy(0, newIdleStrategy.address);

        expect(
          (await router.getIdleStrategies())[0].strategyAddress
        ).to.be.equal(newIdleStrategy.address);
        expect(await usdc.idleStrategy.owner()).to.be.equal(
          admin.address,
          "Owner mismatch"
        );

        // check balances to ensure funds were moved
        expect(await usdc.balanceOf(usdc.idleStrategy.address)).to.be.equal(0);
        expect(await usdc.balanceOf(newIdleStrategy.address)).to.be.equal(
          parseUsdc("10000")
        );
      });
    });
  });
  // never called direclt, only indirectly on token removal
  describe("#_removeIdleStrategy", async function () {
    it("removes token from start correctly", async function () {
      const {
        admin,
        router,
        oracle,
        usdc,
        parseUsdc,
        busd,
        parseBusd,
        usdt,
        parseUsdt,
        deployStrategy,
        owner,
      } = await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdc.address, parseUsdc("1"));
      oracle.setPrice(busd.address, parseBusd("1"));
      oracle.setPrice(usdt.address, parseUsdt("1"));

      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length).to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesFormer[1].strategyAddress).to.be.equal(
        busd.idleStrategy.address
      );
      expect(idleStrategiesFormer[2].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );

      const strategy = await deployStrategy({
        token: busd,
      });

      await usdc.transfer(usdc.idleStrategy.address, parseUsdc("10000"));

      await admin.removeSupportedToken(usdc);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length).to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );
      expect(idleStrategiesLatter[1].strategyAddress).to.be.equal(
        busd.idleStrategy.address
      );

      expect(await usdc.balanceOf(usdc.idleStrategy.address)).to.be.equal(0);
      expect(await usdc.idleStrategy.owner()).to.be.equal(admin.address);

      expect(await strategy.totalTokens()).to.be.equal(parseBusd("10000"));
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(
        parseUniform("10000")
      );
    });
    it("removes token from middle correctly", async function () {
      const {
        admin,
        router,
        oracle,
        usdc,
        parseUsdc,
        busd,
        parseBusd,
        usdt,
        parseUsdt,
        deployStrategy,
        owner,
      } = await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdc.address, parseUsdc("1"));
      oracle.setPrice(busd.address, parseBusd("1"));
      oracle.setPrice(usdt.address, parseUsdt("1"));

      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length).to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesFormer[1].strategyAddress).to.be.equal(
        busd.idleStrategy.address
      );
      expect(idleStrategiesFormer[2].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );

      const strategy = await deployStrategy({
        token: usdc,
      });

      await busd.transfer(busd.idleStrategy.address, parseBusd("10000"));

      await admin.removeSupportedToken(busd);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length).to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesLatter[1].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );

      expect(await busd.balanceOf(busd.idleStrategy.address)).to.be.equal(0);
      expect(await busd.idleStrategy.owner()).to.be.equal(admin.address);

      expect(await strategy.totalTokens()).to.be.equal(parseUsdc("10000"));
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(
        parseUniform("10000")
      );
    });
    it("removes token from end correctly", async function () {
      const {
        admin,
        router,
        oracle,
        usdc,
        parseUsdc,
        busd,
        parseBusd,
        usdt,
        parseUsdt,
        deployStrategy,
        owner,
      } = await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdc.address, parseUsdc("1"));
      oracle.setPrice(busd.address, parseBusd("1"));
      oracle.setPrice(usdt.address, parseUsdt("1"));

      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length).to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesFormer[1].strategyAddress).to.be.equal(
        busd.idleStrategy.address
      );
      expect(idleStrategiesFormer[2].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );

      const strategy = await deployStrategy({
        token: busd,
      });

      await usdt.transfer(usdt.idleStrategy.address, parseUsdt("10000"));

      await admin.removeSupportedToken(usdt);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length).to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesLatter[1].strategyAddress).to.be.equal(
        busd.idleStrategy.address
      );

      expect(await usdt.balanceOf(usdt.idleStrategy.address)).to.be.equal(0);
      expect(await usdt.idleStrategy.owner()).to.be.equal(admin.address);

      expect(await strategy.totalTokens()).to.be.equal(parseBusd("10000"));
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(
        parseUniform("10000")
      );
    });
    it("removes token correctly when idle strategy is empty", async function () {
      const {
        admin,
        router,
        oracle,
        usdc,
        parseUsdc,
        busd,
        parseBusd,
        usdt,
        parseUsdt,
        deployStrategy,
        owner,
      } = await loadFixture(loadStateWithZeroSwapFee);

      oracle.setPrice(usdc.address, parseUsdc("1"));
      oracle.setPrice(busd.address, parseBusd("1"));
      oracle.setPrice(usdt.address, parseUsdt("1"));

      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      const idleStrategiesFormer = await router.getIdleStrategies();
      expect(idleStrategiesFormer.length).to.be.equal(3);
      expect(idleStrategiesFormer[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesFormer[1].strategyAddress).to.be.equal(
        busd.idleStrategy.address
      );
      expect(idleStrategiesFormer[2].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );

      const strategy = await deployStrategy({
        token: usdc,
      });

      // ensure idle strategy balance is empty
      expect(await busd.balanceOf(busd.idleStrategy.address)).to.be.equal(0);

      await admin.removeSupportedToken(busd);

      const idleStrategiesLatter = await router.getIdleStrategies();
      expect(idleStrategiesLatter.length).to.be.equal(2);
      expect(idleStrategiesLatter[0].strategyAddress).to.be.equal(
        usdc.idleStrategy.address
      );
      expect(idleStrategiesLatter[1].strategyAddress).to.be.equal(
        usdt.idleStrategy.address
      );

      expect(await busd.balanceOf(busd.idleStrategy.address)).to.be.equal(0);
      expect(await busd.idleStrategy.owner()).to.be.equal(admin.address);

      expect(await strategy.totalTokens()).to.be.equal(0);
      expect((await router.getStrategiesValue()).totalBalance).to.be.equal(0);
    });
  });
  describe("supported tokens managing also manages idle strategies", async function () {
    describe("adding supported tokens", async function () {
      it("zero address for idle strategy is not allowed", async function () {
        const { admin, usdc } = await loadFixture(loadStateWithZeroSwapFee);

        await expect(
          admin.setSupportedToken(
            usdc.address,
            true,
            ethers.constants.AddressZero
          )
        ).to.be.reverted;
      });
      it("idle strategy is added correctly", async function () {
        const { admin, router, usdc } = await loadFixture(
          loadStateWithZeroSwapFee
        );

        await admin.setSupportedToken(
          usdc.address,
          true,
          usdc.idleStrategy.address
        );

        const idleStrategies = await router.getIdleStrategies();

        expect(idleStrategies[0].strategyAddress).to.be.equal(
          usdc.idleStrategy.address
        );
      });
    });
    it("idle strategy is removed correctly when a token removed", async function () {
      const { admin, router, usdc } = await loadFixture(
        loadStateWithZeroSwapFee
      );

      await admin.setSupportedToken(
        usdc.address,
        true,
        usdc.idleStrategy.address
      );
      await admin.setSupportedToken(
        usdc.address,
        false,
        ethers.constants.AddressZero
      );

      const idleStrategies = await router.getIdleStrategies();

      expect(idleStrategies).to.be.empty;
    });
  });

  describe("behavior when idle strategy has threshold dust", async function () {
    it("should reverted during deposit dust threshold if moderator address is not set", async function () {
      const {
        admin,
        usdt,
        batch,
        parseUsdt,
        owner,
        router,
        create2Deployer,
        ProxyBytecode,
      } = await loadFixture(loadStateWithZeroSwapFee);

      const idleStrategy = await deployProxyIdleStrategy(
        owner,
        batch,
        router,
        ethers.constants.AddressZero,
        usdt,
        "Dummy",
        create2Deployer,
        ProxyBytecode
      );

      const dustAmount = parseUsdt("0.099");

      await usdt.transfer(idleStrategy.address, dustAmount);
      // Grant DEPOSITOR_ROLE to owner.address
      await idleStrategy
        .connect(owner)
        .grantRole(idleStrategy.DEPOSITOR_ROLE(), owner.address);

      await expect(idleStrategy.deposit(dustAmount)).to.be.revertedWith(
        "ERC20: transfer to the zero address"
      );
    });

    it("should deposit dust treshold to moderator address if moderator address is set", async function () {
      const {
        admin,
        busd,
        batch,
        parseBusd,
        owner,
        router,
        create2Deployer,
        ProxyBytecode,
      } = await loadFixture(loadStateWithZeroSwapFee);

      const idleStrategy = await deployProxyIdleStrategy(
        owner,
        batch,
        router,
        ethers.constants.AddressZero,
        busd,
        "Dummy",
        create2Deployer,
        ProxyBytecode,
        false // Is router admin?
      );

      await idleStrategy
        .connect(owner)
        .grantRole(idleStrategy.DEPOSITOR_ROLE(), owner.address);
      await idleStrategy.connect(owner).setModerator(admin.address);
      const dustAmount = parseBusd("0.099");

      const initialAdminBalance = await busd.balanceOf(admin.address);

      await busd.transfer(idleStrategy.address, dustAmount);

      // expect that total token is 0 if amount is less than dust treshold
      expect(await idleStrategy.totalTokens()).to.be.equal(0);

      await idleStrategy.deposit(dustAmount);

      expect(await busd.balanceOf(idleStrategy.address)).to.be.equal(0);

      expect(await busd.balanceOf(admin.address)).to.be.equal(
        initialAdminBalance.add(dustAmount)
      );
    });
  });
});
