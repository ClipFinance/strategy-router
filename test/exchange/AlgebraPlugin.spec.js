const { expect } = require("chai");
const { parseEther, solidityPack } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupTokens } = require("../shared/commonSetup");
const {
  getCreate2DeployerAndProxyBytecode,
  provider,
  create2Deploy,
} = require("../utils");

describe("AlgebraPlugin", function () {
  let owner, nonOwner, algebraPlugin;

  // mock tokens with different decimals
  let usdc, usdt, busd, hay, thenaAddress;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt, parseHay;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    initialSnapshot = await provider.send("evm_snapshot");
    [owner, nonOwner] = await ethers.getSigners();

    thenaAddress = hre.networkVariables.the;

    // setup tokens
    ({ usdc, parseUsdc, busd, parseBusd, usdt, parseUsdt, hay, parseHay } =
      await setupTokens());

    const { create2Deployer } = await getCreate2DeployerAndProxyBytecode();
    // deploy the AlgebraPlugin contract
    ({ contract: algebraPlugin } = await create2Deploy({
      ContractName: "AlgebraPlugin",
      constructorArgs: [
        hre.networkVariables.thenaAlgebraRouter,
        hre.networkVariables.thenaAlgebraFactory,
      ],
      create2Deployer,
    }));
  });

  after(async () => {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("setMediatorTokenForPair", function () {
    it("should revert with identical mediator token", async function () {
      await expect(
        algebraPlugin.setMediatorTokenForPair(busd.address, [
          busd.address,
          usdt.address,
        ])
      ).to.be.revertedWithCustomError(
        algebraPlugin,
        "CanNotSetIdenticalMediatorToken"
      );

      await expect(
        algebraPlugin.setMediatorTokenForPair(usdt.address, [
          busd.address,
          usdt.address,
        ])
      ).to.be.revertedWithCustomError(
        algebraPlugin,
        "CanNotSetIdenticalMediatorToken"
      );
    });

    it("should be able to set mediator tokens for a pair", async function () {
      const pair = [busd.address, usdt.address];

      // expect that path before added mediator token only to path with BUSD and USDT tokens
      expect(await algebraPlugin.getPathForTokenPair(...pair)).to.be.equal(
        solidityPack(["address", "address"], [busd.address, usdt.address])
      );

      // set USDC as MediatorToken for BUSD and USDT pair
      await algebraPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that path after added mediator token equal to the correct path
      expect(await algebraPlugin.getPathForTokenPair(...pair)).to.be.equal(
        solidityPack(
          ["address", "address", "address"],
          [busd.address, usdc.address, usdt.address]
        )
      );
    });

    it("should set mediator token to zero address once it was not zero address", async function () {
      const pair = [busd.address, usdt.address];

      // set USDC as MediatorToken for BUSD and USDT pair
      await algebraPlugin.setMediatorTokenForPair(usdc.address, pair);

      // expect that path with mediator token
      expect(await algebraPlugin.getPathForTokenPair(...pair)).to.be.equal(
        solidityPack(
          ["address", "address", "address"],
          [busd.address, usdc.address, usdt.address]
        )
      );

      // set mediator token to zero address
      await algebraPlugin.setMediatorTokenForPair(
        ethers.constants.AddressZero,
        pair
      );

      // expect that pair has not mediator token in its path
      expect(await algebraPlugin.getPathForTokenPair(...pair)).to.be.equal(
        solidityPack(["address", "address"], [busd.address, usdt.address])
      );
    });
  });

  describe("swap", function () {
    it("should return 0 if amountIn is 0", async function () {
      expect(
        await algebraPlugin.callStatic.swap(
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
      const usdtAmountOut = parseUsdt("10");

      await usdc.transfer(algebraPlugin.address, usdcAmountIn);

      const newMaxSlippage = 666;
      let minAmountOut = usdtAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // expect that we received closely amount to usdtAmountOut with 0.05% slippage
      let amountReceivedUsdt = await algebraPlugin
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
      const pair = [hay.address, usdc.address];

      // Set USDT as mediator token for BUSD-USDC pair
      await algebraPlugin.setMediatorTokenForPair(usdt.address, pair);
      const usdcAmountIn = parseUsdc("10");
      const hayAmountOut = parseHay("10");

      // send tokens to nonOwner address and make approve
      await usdc.transfer(nonOwner.address, usdcAmountIn);
      await usdc.connect(nonOwner).approve(algebraPlugin.address, usdcAmountIn);

      const newMaxSlippage = 666;
      let minAmountOut = hayAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // expect that we received closely amount to hayAmountOut with 0.10% double hop swap slippage
      let amountReceivedHay = await algebraPlugin
        .connect(nonOwner)
        .callStatic.swap(
          usdcAmountIn,
          usdc.address,
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
      const usdcAmountIn = parseUsdc("10");
      const usdtAmountOut = parseUsdt("10");

      await usdc.transfer(algebraPlugin.address, usdcAmountIn);

      const newMaxSlippage = 10000;
      let minAmountOut = usdtAmountOut.mul(10000 - newMaxSlippage).div(10000);

      expect(
        await algebraPlugin.callStatic.swap(
          usdcAmountIn,
          usdc.address,
          usdt.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.closeTo(usdtAmountOut, usdtAmountOut.mul(5).div(10000));
    });

    it("should revert when received amount is below minAmountOut", async function () {
      const usdcAmountIn = parseUsdc("10");
      const usdtAmountOut = parseUsdt("11");

      await usdc.transfer(algebraPlugin.address, usdcAmountIn);

      const newMaxSlippage = 0;
      let minAmountOut = usdtAmountOut.mul(10000 - newMaxSlippage).div(10000);
      await expect(
        algebraPlugin.callStatic.swap(
          usdcAmountIn,
          usdc.address,
          usdt.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.revertedWith("Too little received");
    });
  });

  describe("getExchangeProtocolFee", function () {
    // basе protocol fees may vary for different pools and these values can be changed
    const BASE_FEE_USDC_USDT_POOL = parseEther("0.00001"); // 0.001%
    const BASE_FEES_HAY_USDT_POOL = parseEther("0.0001"); // 0.01%
    it("should get right pancakeswap protocol fee without mediator token", async function () {
      expect(
        await algebraPlugin.getExchangeProtocolFee(hay.address, usdt.address)
      ).to.be.equal(BASE_FEES_HAY_USDT_POOL);
      expect(
        await algebraPlugin.getExchangeProtocolFee(usdc.address, usdt.address)
      ).to.be.equal(BASE_FEE_USDC_USDT_POOL);
    });

    it("should get right pancakeswap protocol fee with mediator token", async function () {
      const MAX_FEE = parseEther("1"); // 100%
      // calculate fee percents 100% - (100% - feePercentAM) * (100% - feePercentMB) / 100% = 0.000109999% for this case
      const feeWithMediatorToken = MAX_FEE.sub(
        MAX_FEE.sub(BASE_FEE_USDC_USDT_POOL)
          .mul(MAX_FEE.sub(BASE_FEES_HAY_USDT_POOL))
          .div(MAX_FEE)
      );
      expect(
        await algebraPlugin.getExchangeProtocolFee(hay.address, usdc.address)
      ).to.be.equal(feeWithMediatorToken);
    });
  });

  describe("getRoutePrice", function () {
    it("should get non-zero price for THE-USDT and vice versa routes", async function () {
      const priceAB = await algebraPlugin.getRoutePrice(
        thenaAddress,
        usdt.address
      );
      const priceBA = await algebraPlugin.getRoutePrice(
        usdt.address,
        thenaAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);
      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get non-zero price for HAY-USDT and vice versa routes", async function () {
      const priceAB = await algebraPlugin.getRoutePrice(
        hay.address,
        usdt.address
      );
      const priceBA = await algebraPlugin.getRoutePrice(
        usdt.address,
        hay.address
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);
      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get price for THE-HAY and vice versa routes with mediator token", async function () {
      await algebraPlugin.setMediatorTokenForPair(usdt.address, [
        thenaAddress,
        hay.address,
      ]);

      const priceAB = await algebraPlugin.getRoutePrice(
        thenaAddress,
        hay.address
      );
      const priceBA = await algebraPlugin.getRoutePrice(
        hay.address,
        thenaAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);

      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });
  });
});
