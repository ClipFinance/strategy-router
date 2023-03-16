const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = require("ethers/lib/utils");

describe("UniswapPlugin", function () {
  let owner, nonOwner, uniswapPlugin, uniswapRouter;
  let usdc, usdt, busd;
  // helper functions to parse amounts of tokens
  let parseUsdc, parseUsdt, parseBusd;

  before(async function () {

    [owner, nonOwner] = await ethers.getSigners();

    // prepare contracts and tokens
    uniswapRouter = await ethers.getContractAt("IUniswapV2Router02", hre.networkVariables.uniswapRouter);

    usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
    const usdcDecimals = await usdc.decimals();
    parseUsdc = (args) => parseUnits(args, usdcDecimals);

    usdt = await ethers.getContractAt("ERC20", hre.networkVariables.usdt);
    const usdtDecimals = await usdt.decimals();
    parseUsdt = (args) => parseUnits(args, usdtDecimals);

    busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
    const busdDecimals = await busd.decimals();
    parseBusd = (args) => parseUnits(args, busdDecimals);

    // deploy the UniswapPlugin contract
    const UniswapPlugin = await ethers.getContractFactory("UniswapPlugin");
    uniswapPlugin = await UniswapPlugin.deploy();
    await uniswapPlugin.deployed();

    // swap USDC tokens to owner
    const timestamp = (await ethers.provider.getBlock()).timestamp + 1;
    await uniswapRouter.swapExactETHForTokens(
      parseUsdc("1000"),
      [hre.networkVariables.wbnb, usdc.address],
      owner.address,
      timestamp,
      { value: parseUnits("5") }
    );

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
    it("should swap correct received amount closely to predicted amount out", async function () {
      const usdcAmoutIn = parseUsdc("10");
      // predict amount out
      const busdAmountOut = await uniswapPlugin.getAmountOut(usdcAmoutIn, usdc.address, busd.address);

      // make approve and perform swap
      await usdc.transfer(uniswapPlugin.address, usdcAmoutIn);
      await uniswapPlugin.swap(usdcAmoutIn, usdc.address, busd.address, nonOwner.address);

      const busdAmountReceived = await busd.balanceOf(nonOwner.address);

      // expect that busdAmountReceived closely to busdAmountOut with slippage 0.5%
      expect(busdAmountReceived).to.be.closeTo(busdAmountOut, parseBusd("0.05"));
    });
  });

  describe("getAmountOut", function () {

    it("should get closely amount out of swap", async function () {
      const usdcAmoutIn = parseUsdc("10");

      const busdAmountOut = await uniswapPlugin.getAmountOut(usdcAmoutIn, usdc.address, busd.address);
      // expect that busdAmountOut closely to slippage 0.5%
      expect(busdAmountOut).to.be.closeTo(parseBusd("10"), parseBusd("0.05"));
    });

  });
});