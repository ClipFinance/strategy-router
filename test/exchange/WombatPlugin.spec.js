const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupTokens } = require("../shared/commonSetup");
const {
  getCreate2DeployerAndProxyBytecode,
  provider,
  create2Deploy,
} = require("../utils");

describe("WombatPlugin", function () {
  let owner, nonOwner, wombatPlugin;
  // mock tokens with different decimals
  let usdc, usdt, busd, hay;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt, parseHay;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  const { wombatMainPool, wombatHayPool, wombatRouter } = hre.networkVariables;

  before(async function () {
    initialSnapshot = await provider.send("evm_snapshot");
    [owner, nonOwner] = await ethers.getSigners();

    // setup tokens
    ({ usdc, parseUsdc, busd, parseBusd, usdt, parseUsdt, hay, parseHay } =
      await setupTokens());

    const { create2Deployer } = await getCreate2DeployerAndProxyBytecode();
    // deploy the WombatPlugin contract
    ({ contract: wombatPlugin } = await create2Deploy({
      ContractName: "WombatPlugin",
      constructorArgs: [wombatRouter],
      create2Deployer,
    }));
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  after(async () => {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("setPoolForPair", function () {
    it("should be able to set pool for a pair", async function () {
      const pair = [busd.address, usdt.address];

      // expect that getPathsForTokenPair before added pool reverted
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      await wombatPlugin.setPoolForPair(wombatMainPool, pair);

      // expect that paths equal to the correct values after added pool
      const [tokenPath, poolPath] = await wombatPlugin.getPathsForTokenPair(
        ...pair
      );
      expect(tokenPath).to.be.eql([busd.address, usdt.address]);
      expect(poolPath).to.be.eql([wombatMainPool]);
    });

    it("should set pool as zero address once it was not zero address", async function () {
      const pair = [busd.address, usdc.address];

      await wombatPlugin.setPoolForPair(wombatMainPool, pair);

      // expect that paths equal to the correct values after added pool
      const [tokenPath, poolPath] = await wombatPlugin.getPathsForTokenPair(
        ...pair
      );
      expect(tokenPath).to.be.eql([busd.address, usdc.address]);
      expect(poolPath).to.be.eql([wombatMainPool]);

      // set pool as zero address
      await wombatPlugin.setPoolForPair(ethers.constants.AddressZero, pair);

      // expect that getPathsForTokenPair reverted - it means that pool was set to zero address
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");
    });
  });

  describe("setMediatorTokenForPair", function () {
    it("should revert with identical mediator token", async function () {
      await expect(
        wombatPlugin.setMediatorTokenForPair(busd.address, [
          busd.address,
          usdt.address,
        ])
      ).to.be.revertedWithCustomError(
        wombatPlugin,
        "CanNotSetIdenticalMediatorToken"
      );

      await expect(
        wombatPlugin.setMediatorTokenForPair(usdt.address, [
          busd.address,
          usdt.address,
        ])
      ).to.be.revertedWithCustomError(
        wombatPlugin,
        "CanNotSetIdenticalMediatorToken"
      );
    });

    it("should be able to set and unset mediator tokens for a pair (pair pool is not set)", async function () {
      const pair = [busd.address, hay.address];

      // set pools for pairs
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        usdc.address,
        hay.address,
      ]);

      // expect that getPathsForTokenPair before added mediator token reverted
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      // set USDC as MediatorToken for BUSD/HAY pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that paths equal to the correct values after added mediator token
      const [tokenPath, poolPath] = await wombatPlugin.getPathsForTokenPair(
        ...pair
      );
      expect(tokenPath).to.be.eql([busd.address, usdc.address, hay.address]);
      expect(poolPath).to.be.eql([wombatMainPool, wombatHayPool]);

      // set mediator token to zero address
      await wombatPlugin.setMediatorTokenForPair(
        ethers.constants.AddressZero,
        pair
      );

      // expect that getPathsForTokenPair reverted - it means that mediator token was set to zero address
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");
    });

    it("should be able to set and unset mediator tokens for a pair (pair pool is set)", async function () {
      const pair = [busd.address, usdt.address];

      // set pools for pairs
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdt.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        usdc.address,
        usdt.address,
      ]);

      // expect that paths equal to values without mediator token
      const [tokenPathBefore, poolPathBefore] =
        await wombatPlugin.getPathsForTokenPair(...pair);
      expect(tokenPathBefore).to.be.eql([busd.address, usdt.address]);
      expect(poolPathBefore).to.be.eql([wombatMainPool]);

      // set USDC as MediatorToken for BUSD/USDT pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that paths equal to values with added mediator token
      const [tokenPath, poolPath] = await wombatPlugin.getPathsForTokenPair(
        ...pair
      );
      expect(tokenPath).to.be.eql([busd.address, usdc.address, usdt.address]);
      expect(poolPath).to.be.eql([wombatMainPool, wombatMainPool]);

      // set mediator token to zero address
      await wombatPlugin.setMediatorTokenForPair(
        ethers.constants.AddressZero,
        pair
      );

      // expect that paths equal to values without mediator token
      const [tokenPathAfter, poolPathAfter] =
        await wombatPlugin.getPathsForTokenPair(...pair);
      expect(tokenPathAfter).to.be.eql([busd.address, usdt.address]);
      expect(poolPathAfter).to.be.eql([wombatMainPool]);
    });
  });

  describe("getPathsForTokenPair", function () {
    it("should revert if one of pair of mediator token has not set pool (pair pool is not set)", async function () {
      const pair = [busd.address, usdt.address];

      // expect that getPathsForTokenPair reverted - we have not set pool for pair
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      // set mediator token for pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that getPathsForTokenPair reverted - we have not set pools for mediator token pairs
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      // set pool for one pair of mediator token
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);

      // expect that getPathsForTokenPair reverted - we have not set pool for second pair of mediator token
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      // set pool for second pair of mediator token
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        usdc.address,
        usdt.address,
      ]);

      // expect that paths equal to values with added mediator token
      const [tokenPath, poolPath] = await wombatPlugin.getPathsForTokenPair(
        ...pair
      );
      expect(tokenPath).to.be.eql([busd.address, usdc.address, usdt.address]);
      expect(poolPath).to.be.eql([wombatMainPool, wombatMainPool]);

      // set pool for first pair of mediator token to zero address
      await wombatPlugin.setPoolForPair(ethers.constants.AddressZero, [
        busd.address,
        usdc.address,
      ]);

      // expect that getPathsForTokenPair reverted - we have unset pool for first pair of mediator token
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");
    });

    it("should revert if one of pair of mediator token has not set pool (pair pool is set)", async function () {
      const pair = [usdc.address, usdt.address];

      // set pool for USDC/USDT pair
      await wombatPlugin.setPoolForPair(wombatMainPool, pair);

      // expect that paths equal to values without mediator token
      const [tokenPathInitial, poolPathInitial] =
        await wombatPlugin.getPathsForTokenPair(...pair);
      expect(tokenPathInitial).to.be.eql([usdc.address, usdt.address]);
      expect(poolPathInitial).to.be.eql([wombatMainPool]);

      // set HAY mediator token for USDC/USDT pair
      await wombatPlugin.setMediatorTokenForPair(hay.address, pair);

      // expect that getPathsForTokenPair reverted - we have not set pools for USDC/HAY mediator token pairs
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      // set pool for first USDC/HAY pair of mediator token
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        usdc.address,
        hay.address,
      ]);

      // expect that getPathsForTokenPair reverted - we have not set pool for second HAY/USDT pair of mediator token
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");

      // set pool for second HAY/USDT pair of mediator token
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        hay.address,
        usdt.address,
      ]);

      // expect that paths equal to values with added HAY mediator token
      const [tokenPathWithMediatorToken, poolPathWithMediatorToken] =
        await wombatPlugin.getPathsForTokenPair(...pair);
      expect(tokenPathWithMediatorToken).to.be.eql([
        usdc.address,
        hay.address,
        usdt.address,
      ]);
      expect(poolPathWithMediatorToken).to.be.eql([
        wombatHayPool,
        wombatHayPool,
      ]);

      // set pool for first USDC/HAY pair of mediator token to zero address
      await wombatPlugin.setPoolForPair(ethers.constants.AddressZero, [
        usdc.address,
        hay.address,
      ]);

      // expect that getPathsForTokenPair reverted - we have unset pool for first USDC/HAY pair of mediator token
      await expect(
        wombatPlugin.getPathsForTokenPair(...pair)
      ).to.be.revertedWithCustomError(wombatPlugin, "RouteNotFound");
    });

    it("should return correct paths order depending on pair", async function () {
      // set pool for BUSD/USDT pair
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdt.address,
      ]);

      // expect that paths orders equal to correct values
      const [tokenPathBusdUsdt, poolPathBusdUsdt] =
        await wombatPlugin.getPathsForTokenPair(busd.address, usdt.address);
      expect(tokenPathBusdUsdt).to.be.eql([busd.address, usdt.address]);
      expect(poolPathBusdUsdt).to.be.eql([wombatMainPool]);
      const [tokenPathUsdtBusd, poolPathUsdtBusd] =
        await wombatPlugin.getPathsForTokenPair(usdt.address, busd.address);
      expect(tokenPathUsdtBusd).to.be.eql([usdt.address, busd.address]);
      expect(poolPathUsdtBusd).to.be.eql([wombatMainPool]);
    });

    it("should return correct paths order depending on pair with mediator token", async function () {
      const pair = [busd.address, hay.address];

      // set pools for USDC mediator token pairs
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        usdc.address,
        hay.address,
      ]);

      // set USDC as MediatorToken for BUSD/HAY pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that paths orders equal to correct values
      const [tokenPathBusdUsdcHay, poolPathBusdUsdcHay] =
        await wombatPlugin.getPathsForTokenPair(busd.address, hay.address);
      expect(tokenPathBusdUsdcHay).to.be.eql([
        busd.address,
        usdc.address,
        hay.address,
      ]);
      expect(poolPathBusdUsdcHay).to.be.eql([wombatMainPool, wombatHayPool]);
      const [tokenPathHayUsdcBusd, poolPathHayUsdcBusd] =
        await wombatPlugin.getPathsForTokenPair(hay.address, busd.address);
      expect(tokenPathHayUsdcBusd).to.be.eql([
        hay.address,
        usdc.address,
        busd.address,
      ]);
      expect(poolPathHayUsdcBusd).to.be.eql([wombatHayPool, wombatMainPool]);
    });
  });

  describe("swap", function () {
    it("should return 0 if amountIn is 0", async function () {
      expect(
        await wombatPlugin.callStatic.swap(
          0,
          usdc.address,
          busd.address,
          nonOwner.address,
          0
        )
      ).to.be.equal(0);
    });

    it("should swap correct received amount closely to predicted amount out without mediator token", async function () {
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        usdt.address,
        usdc.address,
      ]);

      const usdcAmountIn = parseUsdc("10");
      const usdtAmountOut = parseUsdt("10");

      await usdc.transfer(wombatPlugin.address, usdcAmountIn);

      const newMaxSlippage = 666;
      let minAmountOut = usdtAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // expect that we received closely amount to usdtAmountOut with 0.05% slippage
      let amountReceivedUsdt = await wombatPlugin
        .connect(nonOwner)
        .callStatic.swap(
          usdcAmountIn,
          usdc.address,
          usdt.address,
          nonOwner.address,
          minAmountOut
        );
      expect(amountReceivedUsdt).to.be.closeTo(
        usdtAmountOut,
        usdtAmountOut.mul(5).div(10000)
      );
      expect(amountReceivedUsdt).to.be.greaterThanOrEqual(minAmountOut);
    });

    it("should swap correctly with mediator token", async function () {
      const pair = [busd.address, hay.address];

      // set pools for USDC mediator token pairs
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        usdc.address,
        hay.address,
      ]);

      // set USDC as MediatorToken for BUSD/HAY pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, pair);
      const busdAmountIn = parseBusd("10");
      const hayAmountOut = parseHay("10");

      // send tokens to wombatPlugin address
      await busd.transfer(wombatPlugin.address, busdAmountIn);

      const newMaxSlippage = 666;
      let minAmountOut = hayAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // expect that we received closely amount to hayAmountOut with 0.10% double hop swap slippage
      let amountReceivedHay = await wombatPlugin
        .connect(nonOwner)
        .callStatic.swap(
          busdAmountIn,
          busd.address,
          hay.address,
          nonOwner.address,
          minAmountOut
        );
      expect(amountReceivedHay).to.be.closeTo(
        hayAmountOut,
        hayAmountOut.mul(10).div(10000)
      );
      expect(amountReceivedHay).to.be.greaterThanOrEqual(minAmountOut);
    });

    it("should not revert when received amount is above minAmountOut", async function () {
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        usdt.address,
        usdc.address,
      ]);
      const usdcAmountIn = parseUsdc("10");
      const usdtAmountOut = parseUsdt("10");

      await usdc.transfer(wombatPlugin.address, usdcAmountIn);

      const newMaxSlippage = 10000;
      let minAmountOut = usdtAmountOut.mul(10000 - newMaxSlippage).div(10000);

      expect(
        await wombatPlugin.callStatic.swap(
          usdcAmountIn,
          usdc.address,
          usdt.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.closeTo(usdtAmountOut, usdtAmountOut.mul(5).div(10000));
    });

    it("should revert when received amount is below minAmountOut", async function () {
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        usdt.address,
        usdc.address,
      ]);
      const usdcAmountIn = parseUsdc("10");
      const usdtAmountOut = parseUsdt("11");

      await usdc.transfer(wombatPlugin.address, usdcAmountIn);

      const newMaxSlippage = 0;
      let minAmountOut = usdtAmountOut.mul(10000 - newMaxSlippage).div(10000);
      await expect(
        wombatPlugin.callStatic.swap(
          usdcAmountIn,
          usdc.address,
          usdt.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.revertedWith("amountOut too low");
    });
  });

  describe("getExchangeProtocolFee", function () {
    const wombatHayPoolHaircutRate = parseEther("0.00002"); // 0.002%
    const wombatMainPoolHaircutRate = parseEther("0.00002"); // 0.002%
    it("should get right wombat protocol fee without mediator token", async function () {
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        hay.address,
        usdt.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        usdc.address,
        usdt.address,
      ]);

      expect(
        await wombatPlugin.getExchangeProtocolFee(hay.address, usdt.address)
      ).to.be.equal(wombatHayPoolHaircutRate);
      expect(
        await wombatPlugin.getExchangeProtocolFee(usdc.address, usdt.address)
      ).to.be.equal(wombatMainPoolHaircutRate);
    });

    it("should get right wombat protocol fee with mediator token", async function () {
      const pair = [busd.address, hay.address];

      // set pools for USDC mediator token pairs
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        usdc.address,
        hay.address,
      ]);

      // set USDC as MediatorToken for BUSD/HAY pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, pair);

      const MAX_FEE = parseEther("1"); // 100%
      // calculate fee percents 100% - (100% - feePercentAM) * (100% - feePercentMB) / 100% = 0.000109999% for this case
      const feeWithMediatorToken = MAX_FEE.sub(
        MAX_FEE.sub(wombatHayPoolHaircutRate)
          .mul(MAX_FEE.sub(wombatMainPoolHaircutRate))
          .div(MAX_FEE)
      );
      expect(await wombatPlugin.getExchangeProtocolFee(...pair)).to.be.equal(
        feeWithMediatorToken
      );
    });
  });

  describe("getRoutePrice", function () {
    before(async function () {
      // set pools for USDC mediator token pairs
      await wombatPlugin.setPoolForPair(wombatMainPool, [
        busd.address,
        usdc.address,
      ]);
      await wombatPlugin.setPoolForPair(wombatHayPool, [
        usdc.address,
        hay.address,
      ]);

      // set USDC as MediatorToken for BUSD/HAY pair
      await wombatPlugin.setMediatorTokenForPair(usdc.address, [
        busd.address,
        hay.address,
      ]);
    });

    it("should get non-zero price for BUSD/USDC and vice versa routes", async function () {
      const pair = [busd.address, usdc.address];

      const priceAB = await wombatPlugin.getRoutePrice(...pair);
      const priceBA = await wombatPlugin.getRoutePrice(...pair.reverse());

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);

      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get non-zero price for USDC-HAY and vice versa routes", async function () {
      const pair = [usdc.address, hay.address];

      const priceAB = await wombatPlugin.getRoutePrice(...pair);
      const priceBA = await wombatPlugin.getRoutePrice(...pair.reverse());

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);

      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get non-zero price for BUSD/HAY and vice versa routes with mediator token", async function () {
      const pair = [busd.address, hay.address];

      const priceAB = await wombatPlugin.getRoutePrice(...pair);
      const priceBA = await wombatPlugin.getRoutePrice(...pair.reverse());

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);

      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });
  });
});
