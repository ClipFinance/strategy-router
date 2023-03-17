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
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

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
    it("should revert with 0 amountIn", async function () {
      await expect(
        uniswapPlugin.swap(0, usdc.address, busd.address, nonOwner.address)
      ).to.be.revertedWithCustomError(uniswapPlugin, "InsufficientInputAmount");
    });

    it("should swap correct received amount closely to predicted amount out without mediator token", async function () {
      const usdcAmoutIn = parseUsdc("10");
      // predict amount out
      const busdAmountOut = await uniswapPlugin.getAmountOut(usdcAmoutIn, usdc.address, busd.address);

      // make approve and perform swap
      await usdc.transfer(uniswapPlugin.address, usdcAmoutIn);
      const busdAmountReceived = await uniswapPlugin.callStatic.swap(usdcAmoutIn, usdc.address, busd.address, nonOwner.address);

      // expect that busdAmountReceived equal to busdAmountOut
      expect(busdAmountReceived).to.be.equal(busdAmountOut);
    });

    it("should swap correctly with mediator token", async function () {
      const pair = [busd.address, usdc.address];

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setMediatorTokenForPair(usdt.address, pair);
      const usdcAmountIn = parseUsdc("10");

      // Predict amount out with mediator token
      const amountOutBusd = await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address);

      // Swap with mediator token and predict amount out
      await usdc.transfer(nonOwner.address, usdcAmountIn);
      await usdc.connect(nonOwner).approve(uniswapPlugin.address, usdcAmountIn);
      const amountReceivedBusd = await uniswapPlugin.connect(nonOwner).callStatic.swap(usdcAmountIn, usdc.address, busd.address, nonOwner.address);

      // Expect the amount out to be equal to the predicted amount out
      expect(amountReceivedBusd).to.be.equal(amountOutBusd);

      // Remove mediator token
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

    it("should revert with 0 amountIn", async function () {
      await expect(
        uniswapPlugin.getAmountOut(0, usdc.address, busd.address)
      ).to.be.revertedWithCustomError(uniswapPlugin, "InsufficientInputAmount");
    });

    it("should get closely amount out of swap without mediator token", async function () {
      const usdcAmountIn = parseUsdc("10");

      const busdAmountOut = await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address);
      // expect that busdAmountOut closely to slippage 0.26%
      expect(busdAmountOut).to.be.closeTo(parseBusd("10"), parseBusd("10").mul(26).div(10000));
    });

    it("should get closely amount out of swap with mediator token", async function () {
      const pair = [busd.address, usdc.address];
      const usdcAmountIn = parseUsdc("10");

      const busdAmountOutWithoutMediatorToken = await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address);

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setMediatorTokenForPair(usdt.address, pair);

      const busdAmountOutWithMediatorToken = await uniswapPlugin.getAmountOut(usdcAmountIn, usdc.address, busd.address);

      // expect that busdAmountOut with mediator token closely to busdAmountOut without mediator token slippage 0.26%
      expect(busdAmountOutWithMediatorToken).to.be.closeTo(
        busdAmountOutWithoutMediatorToken,
        busdAmountOutWithoutMediatorToken.mul(26).div(10000));
    });

  });
});