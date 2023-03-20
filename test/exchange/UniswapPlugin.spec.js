const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupFakeTokens, setupTokensLiquidityOnPancake } = require("../shared/commonSetup");

describe("UniswapPlugin", function () {
  let owner, nonOwner, uniswapPlugin, uniswapRouter;

  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;

  before(async function () {

    [owner, nonOwner] = await ethers.getSigners();

    // prepare contracts and tokens
    uniswapRouter = await ethers.getContractAt("IUniswapV2Router02", hre.networkVariables.uniswapRouter);

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(false));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // deploy the UniswapPlugin contract
    const UniswapPlugin = await ethers.getContractFactory("UniswapPlugin");
    uniswapPlugin = await UniswapPlugin.deploy();
    await uniswapPlugin.deployed();

  });

  describe("setUniswapRouter", function () {

    it("should be able to set the Uniswap router", async function () {
        // expext that uniswapRouter equal to zero address
        expect(await uniswapPlugin.uniswapRouter()).to.equal(ethers.constants.AddressZero);

        // set uniswapRouter to uniswapPlugin
        await uniswapPlugin.setUniswapRouter(uniswapRouter.address);

        // expect that uniswapRouter from uniswapPlugin is equal to the specified uniswapRouter.
        expect(await uniswapPlugin.uniswapRouter()).to.equal(uniswapRouter.address);
    });

  });

  describe("setMediatorTokenForPair", function () {
    it ("should revert with identical mediator token", async function () {
      await expect(
        uniswapPlugin.setMediatorTokenForPair(busd.address, [busd.address, usdt.address])
      ).to.be.revertedWithCustomError(uniswapPlugin, "CanNotSetIdenticalMediatorToken");

      await expect(
        uniswapPlugin.setMediatorTokenForPair(usdt.address, [busd.address, usdt.address])
      ).to.be.revertedWithCustomError(uniswapPlugin, "CanNotSetIdenticalMediatorToken");
    });

    it("should be able to set mediator tokens for a pair", async function () {

      const pair = [busd.address, usdt.address];
      // expect that path before added mediator token only to path with BUSD and USDT tokens
      const pathBeforeAddedMediatorToken = await uniswapPlugin.getPathForTokenPair(...pair);
      expect(pathBeforeAddedMediatorToken).to.eql([busd.address, usdt.address]);

      // set USDC as MediatorToken for BUSD and USDT pair
      await uniswapPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that path after added mediator token equal to the correct path
      const pathAfterAddedMediatorToken = await uniswapPlugin.getPathForTokenPair(...pair);
      expect(pathAfterAddedMediatorToken).to.eql([busd.address, usdc.address, usdt.address]);

      // remove USDC MediatorToken from BUSD and USDT pair
      await uniswapPlugin.setMediatorTokenForPair(ethers.constants.AddressZero, pair);

      // expect that path after removed mediator token equal to the correct path
      const pathAfterRemovedMediatorToken = await uniswapPlugin.getPathForTokenPair(...pair);
      expect(pathAfterRemovedMediatorToken).to.eql([busd.address, usdt.address]);

    });
  });

  describe("swap", function () {
    it("should return 0 if amountIn is 0", async function () {
      expect(
        await uniswapPlugin.callStatic.swap(0, usdc.address, busd.address, nonOwner.address)
      ).to.be.equal(0);
    });

    it("should swap correct received amount closely to predicted amount out without mediator token", async function () {
      const usdcAmoutIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // make approve
      await usdc.transfer(uniswapPlugin.address, usdcAmoutIn);

      // expect that we received closely amount to busdAmountOut with 0.26% slippage
      expect(
        await uniswapPlugin.callStatic.swap(usdcAmoutIn, usdc.address, busd.address, nonOwner.address)
      ).to.be.closeTo(busdAmountOut, busdAmountOut.mul(26).div(10000));
    });

    it("should swap correctly with mediator token", async function () {
      const pair = [busd.address, usdc.address];

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setMediatorTokenForPair(usdt.address, pair);
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // send tokens to nonOwner address and make approve
      await usdc.transfer(nonOwner.address, usdcAmountIn);
      await usdc.connect(nonOwner).approve(uniswapPlugin.address, usdcAmountIn);

      // expect that we received closely amount to busdAmountOut with 0.52% double hop swap slippage
      expect(
        await uniswapPlugin.connect(nonOwner).callStatic.swap(usdcAmountIn, usdc.address, busd.address, nonOwner.address)
      ).to.be.closeTo(busdAmountOut, busdAmountOut.mul(52).div(10000));

      // Remove mediator token to be sure in getAmountOut test with it
      await uniswapPlugin.setMediatorTokenForPair(ethers.constants.AddressZero, pair);
    });

  });

  describe("getExchangeProtocolFee", function () {
    it("should get right pancakeswap protocol fee ", async function () {
      // pancakeswap protocol fee is 0.25% or 0.0025 with 18 decimals
      expect(await uniswapPlugin.getExchangeProtocolFee(busd.address, usdc.address)).to.be.equal(parseEther("0.0025"));
    });
  })

  describe("getAmountOut", function () {

    it("should return 0 if amountIn is 0", async function () {
      expect(
        await uniswapPlugin.getAmountOut(0, usdc.address, busd.address)
      ).to.be.equal(0);
    });

    it("should get closely amount out of swap without mediator token", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // expect that busdAmountOut closely to slippage 0.26%
      expect(
        await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address)
      ).to.be.closeTo(busdAmountOut, busdAmountOut.mul(26).div(10000));
    });

    it("should get closely amount out of swap with mediator token", async function () {
      const pair = [busd.address, usdc.address];
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // expect that getAmountOut without mediator token to be closely with slippage 0.26%
      expect(await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address)).to.be.closeTo(
        busdAmountOut,
        busdAmountOut.mul(26).div(10000)
      );

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setMediatorTokenForPair(usdt.address, pair);

      // expect that busdAmountOut with mediator token to be closely with slippage 0.52%
      expect(await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address)).to.be.closeTo(
        busdAmountOut,
        busdAmountOut.mul(52).div(10000)
      );
    });

  });
});