const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const {
  setupFakeTokens,
  setupTokensLiquidityOnPancake,
} = require("../shared/commonSetup");
const {
  create2Deploy,
  provider,
  getCreate2DeployerAndProxyBytecode,
} = require("../utils");

describe("UniswapPlugin", function () {
  let owner, nonOwner, uniswapPlugin, uniswapRouter;

  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    initialSnapshot = await provider.send("evm_snapshot");
    [owner, nonOwner] = await ethers.getSigners();

    // prepare contracts and tokens
    uniswapRouter = await ethers.getContractAt(
      "IUniswapV2Router02",
      hre.networkVariables.uniswapRouter
    );

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(false));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    const { create2Deployer } = await getCreate2DeployerAndProxyBytecode();
    // deploy the UniswapPlugin contract
    ({ contract: uniswapPlugin } = await create2Deploy({
      ContractName: "UniswapPlugin",
      constructorArgs: [uniswapRouter.address],
      create2Deployer,
    }));
  });

  after(async () => {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("setMediatorTokenForPair", function () {
    it("should revert with identical mediator token", async function () {
      await expect(
        uniswapPlugin.setMediatorTokenForPair(busd.address, [
          busd.address,
          usdt.address,
        ])
      ).to.be.revertedWithCustomError(
        uniswapPlugin,
        "CanNotSetIdenticalMediatorToken"
      );

      await expect(
        uniswapPlugin.setMediatorTokenForPair(usdt.address, [
          busd.address,
          usdt.address,
        ])
      ).to.be.revertedWithCustomError(
        uniswapPlugin,
        "CanNotSetIdenticalMediatorToken"
      );
    });

    it("should be able to set mediator tokens for a pair", async function () {
      const pair = [busd.address, usdt.address];

      // expect that path before added mediator token only to path with BUSD and USDT tokens
      expect(await uniswapPlugin.getPathForTokenPair(...pair)).to.eql([
        busd.address,
        usdt.address,
      ]);

      // set USDC as MediatorToken for BUSD and USDT pair
      await uniswapPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that path after added mediator token equal to the correct path
      expect(await uniswapPlugin.getPathForTokenPair(...pair)).to.eql([
        busd.address,
        usdc.address,
        usdt.address,
      ]);
    });

    it("should set mediator token to zero address once it was not zero address", async function () {
      const pair = [busd.address, usdt.address];

      // set USDC as MediatorToken for BUSD and USDT pair
      await uniswapPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that path with mediator token
      expect(await uniswapPlugin.getPathForTokenPair(...pair)).to.eql([
        busd.address,
        usdc.address,
        usdt.address,
      ]);

      // set mediator token to zero address
      await uniswapPlugin.setMediatorTokenForPair(
        ethers.constants.AddressZero,
        pair
      );

      // expect that pair has not mediator token in its path
      expect(await uniswapPlugin.getPathForTokenPair(...pair)).to.eql([
        busd.address,
        usdt.address,
      ]);
    });
  });

  describe("swap", function () {
    it("should return 0 if amountIn is 0", async function () {
      expect(
        await uniswapPlugin.callStatic.swap(
          0,
          usdc.address,
          busd.address,
          nonOwner.address,
          0
        )
      ).to.be.equal(0);
    });

    it("should swap correct received amount closely to predicted amount out without mediator token", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      await usdc.transfer(uniswapPlugin.address, usdcAmountIn);

      const newMaxSlippage = 666;
      let minAmountOut = busdAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // expect that we received closely amount to busdAmountOut with 0.26% slippage
      let amountReceivedBUSD = await uniswapPlugin
        .connect(nonOwner)
        .callStatic.swap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          minAmountOut
        );
      expect(amountReceivedBUSD).to.be.closeTo(
        busdAmountOut,
        busdAmountOut.mul(26).div(10000)
      );
      expect(amountReceivedBUSD).to.be.greaterThanOrEqual(minAmountOut);
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

      const newMaxSlippage = 666;
      let minAmountOut = busdAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // expect that we received closely amount to busdAmountOut with 0.52% double hop swap slippage
      let amountReceivedBUSD = await uniswapPlugin
        .connect(nonOwner)
        .callStatic.swap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          minAmountOut
        );
      expect(amountReceivedBUSD).to.be.closeTo(
        busdAmountOut,
        busdAmountOut.mul(52).div(10000)
      );
      expect(amountReceivedBUSD).to.be.greaterThanOrEqual(minAmountOut);

      // Remove mediator token to be sure in getAmountOut test with it
      await uniswapPlugin.setMediatorTokenForPair(
        ethers.constants.AddressZero,
        pair
      );
    });

    it("should not revert when received amount is above minAmountOut", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      await usdc.transfer(uniswapPlugin.address, usdcAmountIn);

      const newMaxSlippage = 10000;
      let minAmountOut = busdAmountOut.mul(10000 - newMaxSlippage).div(10000);

      expect(
        await uniswapPlugin.callStatic.swap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.closeTo(busdAmountOut, busdAmountOut.mul(52).div(10000));
    });

    it("should revert when received amount is below minAmountOut", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      await usdc.transfer(uniswapPlugin.address, usdcAmountIn);

      const newMaxSlippage = 0;
      let minAmountOut = busdAmountOut.mul(10000 - newMaxSlippage).div(10000);
      await expect(
        uniswapPlugin.callStatic.swap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.revertedWith("PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT");
    });
  });

  describe("getExchangeProtocolFee", function () {
    it("should get right pancakeswap protocol fee ", async function () {
      // pancakeswap protocol fee is 0.25% or 0.0025 with 18 decimals
      expect(
        await uniswapPlugin.getExchangeProtocolFee(busd.address, usdc.address)
      ).to.be.equal(parseEther("0.0025"));
    });
  });

  describe("getRoutePrice", function () {
    // get real addresses of tokens
    const usdtAddress = hre.networkVariables.usdt;
    const busdAddress = hre.networkVariables.busd;
    const stgAddress = hre.networkVariables.stg;

    before(async function () {
      // Set BUSD as mediator token for STG-USDT pair
      await uniswapPlugin.setMediatorTokenForPair(busdAddress, [
        stgAddress,
        usdtAddress,
      ]);
    });

    it("should get non-zero price for STG-BUSD and vice versa routes", async function () {
      const priceAB = await uniswapPlugin.getRoutePrice(
        stgAddress,
        busdAddress
      );
      const priceBA = await uniswapPlugin.getRoutePrice(
        busdAddress,
        stgAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);
      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get non-zero price for BUSD-USDT and vice versa routes", async function () {
      const priceAB = await uniswapPlugin.getRoutePrice(
        busdAddress,
        usdtAddress
      );
      const priceBA = await uniswapPlugin.getRoutePrice(
        usdtAddress,
        busdAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);
      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get price for STG-USDT and vice versa routes with mediator token", async function () {
      const priceAB = await uniswapPlugin.getRoutePrice(
        stgAddress,
        usdtAddress
      );
      const priceBA = await uniswapPlugin.getRoutePrice(
        usdtAddress,
        stgAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);

      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });
  });
});
