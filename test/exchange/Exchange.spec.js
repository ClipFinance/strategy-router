const { expect } = require("chai");
const { parseUnits } = require("ethers/lib/utils");
const { ethers, artifacts } = require("hardhat");
const { provider } = require("../utils");
const {
  setupCore,
  setupFakeTokens,
  setupTestParams,
  setupTokensLiquidityOnPancake,
  deployFakeStrategy,
} = require("../shared/commonSetup");
const { BigNumber } = require("ethers");
const { smock } = require("@defi-wonderland/smock");

describe("Test Exchange", function () {
  let owner, nonOwner, stubPlugin, stubPlugin2;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, admin, exchangeNonOwner;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;
  let LIMIT_PRECISION;

  before(async function () {
    [owner, nonOwner, stubPlugin, stubPlugin2] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({
      router,
      exchange,
      admin,
      batch,
      oracle,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore());
    exchangeNonOwner = exchange.connect(nonOwner);
    LIMIT_PRECISION = await exchange.LIMIT_PRECISION();

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, admin, usdc, usdt, busd);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(busd);
    await admin.addSupportedToken(usdt);

    // add fake strategies
    await deployFakeStrategy({ batch, router, admin, token: busd });
    await deployFakeStrategy({ batch, router, admin, token: usdc });
    await deployFakeStrategy({ batch, router, admin, token: usdt });

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1"), "");
    await router.allocateToStrategies();
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

  // init smart contract with managers list
  describe("setRoute", function () {
    it("should be onlyOwner", async function () {
      await expect(
        exchangeNonOwner.setRoute(
          [usdc.address],
          [usdc.address],
          [usdc.address]
        )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
    it("should store default route", async function () {
      await exchange.setRoute(
        [usdc.address],
        [busd.address],
        [stubPlugin.address]
      );
      let [token0, token1] = BigNumber.from(usdc.address).lt(
        BigNumber.from(busd.address)
      )
        ? [usdc.address, busd.address]
        : [busd.address, usdc.address];
      let route = await exchange.routes(token0, token1);
      expect(route.defaultRoute).to.be.equal(stubPlugin.address);
    });
  });
  describe("setRouteEx", function () {
    it("should be onlyOwner", async function () {
      let routeParams = {
        defaultRoute: usdc.address,
        limit: 0,
        secondRoute: usdc.address,
        customSlippageInBps: 0,
      };
      await expect(
        exchangeNonOwner.setRouteEx(
          [usdc.address],
          [usdc.address],
          [routeParams]
        )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert when customSlippageInBps is above max", async function () {
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: stubPlugin.address,
        limit: limit,
        secondRoute: stubPlugin2.address,
        customSlippageInBps: 10001,
      };
      await expect(
        exchange.setRouteEx([usdc.address], [busd.address], [routeParams])
      ).to.be.revertedWithCustomError(exchange, "SlippageValueIsAboveMaxBps");
    });
    it("should store all RouteParams", async function () {
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: stubPlugin.address,
        limit: limit,
        secondRoute: stubPlugin2.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);
      let [token0, token1] = BigNumber.from(usdc.address).lt(
        BigNumber.from(busd.address)
      )
        ? [usdc.address, busd.address]
        : [busd.address, usdc.address];
      let route = await exchange.routes(token0, token1);
      expect(route.defaultRoute).to.be.equal(routeParams.defaultRoute);
      expect(route.limit).to.be.equal(routeParams.limit);
      expect(route.secondRoute).to.be.equal(routeParams.secondRoute);
    });
  });
  describe("getPlugin", function () {
    it("should revert when plugin not set", async function () {
      await expect(
        exchangeNonOwner.getPlugin(0, usdc.address, usdc.address)
      ).to.be.revertedWithCustomError(exchangeNonOwner, "RouteNotFound");
    });
    it("should return correct plugin based on input amount", async function () {
      // setup route
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: stubPlugin.address,
        limit: limit,
        secondRoute: stubPlugin2.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      // get plugin
      let plugin = await exchangeNonOwner.getPlugin(
        0,
        usdc.address,
        busd.address
      );
      expect(plugin).to.be.equal(routeParams.defaultRoute);
      // exceed limit input amount
      plugin = await exchangeNonOwner.getPlugin(
        routeParams.limit,
        busd.address,
        usdc.address
      );
      expect(plugin).to.be.equal(routeParams.secondRoute);
    });
  });
  describe("getExchangeProtocolFee", function () {
    it("should revert when plugin not set", async function () {
      await expect(
        exchangeNonOwner.getExchangeProtocolFee(0, usdc.address, usdc.address)
      ).to.be.revertedWithCustomError(exchangeNonOwner, "RouteNotFound");
    });
    it("should query correct plugin for fee based on input amount", async function () {
      // setup mocks
      let mockPlugin = await getMockPlugin();
      let fee = 100;
      await mockPlugin.getExchangeProtocolFee.returns(fee);

      let mockPlugin2 = await getMockPlugin();
      let fee2 = 333;
      await mockPlugin2.getExchangeProtocolFee.returns(fee2);

      // setup route
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: mockPlugin.address,
        limit: limit,
        secondRoute: mockPlugin2.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      // get fee
      let feeReturned = await exchangeNonOwner.getExchangeProtocolFee(
        0,
        usdc.address,
        busd.address
      );
      expect(feeReturned).to.be.equal(fee);
      // exceed limit input amount
      feeReturned = await exchangeNonOwner.getExchangeProtocolFee(
        parseUsdc("100.1"),
        usdc.address,
        busd.address
      );
      expect(feeReturned).to.be.equal(fee2);
    });
  });
  describe("swap", function () {
    it("should revert when plugin not set", async function () {
      await expect(
        exchangeNonOwner.swap(0, usdc.address, usdc.address, owner.address)
      ).to.be.revertedWithCustomError(exchangeNonOwner, "RouteNotFound");
    });
    it("should revert when received 0", async function () {
      // setup mocks
      let mockPlugin = await getMockPlugin();
      let swapReturns = 0;
      await mockPlugin.swap.returns(swapReturns);

      // setup route
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: mockPlugin.address,
        limit: limit,
        secondRoute: stubPlugin.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      // do swap
      await expect(
        exchangeNonOwner.swap(0, usdc.address, busd.address, owner.address)
      ).to.be.revertedWithCustomError(exchangeNonOwner, "RoutedSwapFailed");
    });
    it("should swap on correct plugin based on input amount", async function () {
      // setup mocks
      let mockPlugin = await getMockPlugin();
      let swapReturns = 1337;
      await mockPlugin.swap.returns(swapReturns);

      let mockPlugin2 = await getMockPlugin();
      let swapReturns2 = 666;
      await mockPlugin2.swap.returns(swapReturns2);

      // setup route
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: mockPlugin.address,
        limit: limit,
        secondRoute: mockPlugin2.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      // do swap
      let received = await exchangeNonOwner.callStatic.swap(
        0,
        usdc.address,
        busd.address,
        owner.address
      );
      expect(received).to.be.equal(swapReturns);

      // exceed limit input amount
      await usdc.transfer(exchangeNonOwner.address, parseUsdc("100.1"));
      received = await exchangeNonOwner.callStatic.swap(
        parseUsdc("100.1"),
        usdc.address,
        busd.address,
        owner.address
      );
      expect(received).to.be.equal(swapReturns2);
    });
  });
  describe("setMaxStablecoinSlippageInBps", function () {
    it("non owner should not be able to set the max slippage", async function () {
      const newMaxSlippage = 25;
      await expect(
        exchange.connect(nonOwner).setMaxStablecoinSlippageInBps(newMaxSlippage)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("owner should be able to set the max slippage", async function () {
      const newMaxSlippage = 25;
      await exchange.setMaxStablecoinSlippageInBps(newMaxSlippage);

      expect(await exchange.maxStablecoinSlippageInBps()).to.equal(
        newMaxSlippage
      );
    });

    it("should be able to change value after it is already changed", async function () {
      let newMaxSlippage = 25;
      await exchange.setMaxStablecoinSlippageInBps(newMaxSlippage);
      expect(await exchange.maxStablecoinSlippageInBps()).to.equal(
        newMaxSlippage
      );

      newMaxSlippage = 333;
      await exchange.setMaxStablecoinSlippageInBps(newMaxSlippage);
      expect(await exchange.maxStablecoinSlippageInBps()).to.equal(
        newMaxSlippage
      );
    });

    it("shouldn't be able to set above hardcoded limit", async function () {
      let newMaxSlippage = await exchange.MAX_STABLECOIN_SLIPPAGE_IN_BPS();
      newMaxSlippage = newMaxSlippage.add(100);
      await expect(
        exchange.setMaxStablecoinSlippageInBps(newMaxSlippage)
      ).to.be.revertedWithCustomError(exchange, "SlippageValueIsAboveMaxBps");
    });
  });

  describe("stablecoinSwap", function () {
    it("should revert when plugin not set", async function () {
      const { tokenPriceUsdc, tokenPriceBusd } = await getTokenPriceObjects();
      await expect(
        exchangeNonOwner.stablecoinSwap(
          0,
          usdc.address,
          usdc.address,
          owner.address,
          tokenPriceUsdc,
          tokenPriceBusd
        )
      ).to.be.revertedWithCustomError(exchangeNonOwner, "RouteNotFound");
    });
    it("should revert when received 0", async function () {
      // setup mocks
      let mockPlugin = await getMockPlugin();
      let swapReturns = 0;
      await mockPlugin.swap.returns(swapReturns);

      // setup route
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: mockPlugin.address,
        limit: limit,
        secondRoute: stubPlugin.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      // do swap
      const { tokenPriceUsdc, tokenPriceBusd } = await getTokenPriceObjects();
      await expect(
        exchangeNonOwner.stablecoinSwap(
          0,
          usdc.address,
          busd.address,
          owner.address,
          tokenPriceUsdc,
          tokenPriceBusd
        )
      ).to.be.revertedWithCustomError(exchangeNonOwner, "RoutedSwapFailed");
    });
    it("should swap on correct plugin based on input amount", async function () {
      // setup mocks
      let mockPlugin = await getMockPlugin();
      let swapReturns = 1337;
      await mockPlugin.swap.returns(swapReturns);

      let mockPlugin2 = await getMockPlugin();
      let swapReturns2 = 666;
      await mockPlugin2.swap.returns(swapReturns2);

      // setup route
      let limit = LIMIT_PRECISION.mul(100);
      let routeParams = {
        defaultRoute: mockPlugin.address,
        limit: limit,
        secondRoute: mockPlugin2.address,
        customSlippageInBps: 0,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      // do swap
      const { tokenPriceUsdc, tokenPriceBusd } = await getTokenPriceObjects();
      let received = await exchangeNonOwner.callStatic.stablecoinSwap(
        0,
        usdc.address,
        busd.address,
        owner.address,
        tokenPriceUsdc,
        tokenPriceBusd
      );
      expect(received).to.be.equal(swapReturns);

      // exceed limit input amount
      await usdc.transfer(exchangeNonOwner.address, parseUsdc("100.1"));
      received = await exchangeNonOwner.callStatic.stablecoinSwap(
        parseUsdc("100.1"),
        usdc.address,
        busd.address,
        owner.address,
        tokenPriceUsdc,
        tokenPriceBusd
      );
      expect(received).to.be.equal(swapReturns2);
    });

    it("should use token prices to calculate expected to receive amount", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      await usdc.transfer(exchange.address, usdcAmountIn);

      let newMaxSlippage = 500;
      await exchange.setMaxStablecoinSlippageInBps(newMaxSlippage);
      let { tokenPriceUsdc, tokenPriceBusd } = await getTokenPriceObjects({
        usdcPrice: "2",
        busdPrice: "0.5",
      });
      await expect(
        exchange.callStatic.stablecoinSwap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          tokenPriceUsdc,
          tokenPriceBusd
        )
      ).to.be.revertedWith("PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT");

      newMaxSlippage = 500;
      await exchange.setMaxStablecoinSlippageInBps(newMaxSlippage);
      ({ tokenPriceUsdc, tokenPriceBusd } = await getTokenPriceObjects({
        usdcPrice: "1.02",
        busdPrice: "0.98",
      }));
      expect(
        await exchange.callStatic.stablecoinSwap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          tokenPriceUsdc,
          tokenPriceBusd
        )
      ).to.be.closeTo(busdAmountOut, busdAmountOut.mul(52).div(10000));
    });
  });

  describe("#getSlippageInBps", function () {
    it("should return max maxStablecoinSlippageInBps when customSlippageInBps is not set or is 0", async function () {
      const maxStablecoinSlippageInBps =
        await exchange.maxStablecoinSlippageInBps();
      const slippageInBps = await exchange.getSlippageInBps(
        usdc.address,
        busd.address
      );
      expect(slippageInBps).to.be.equal(maxStablecoinSlippageInBps);
    });

    it("should return customSlippageInBps when it is set", async function () {
      const customSlippageInBps = 100;
      // setup route
      const routeParams = {
        defaultRoute: stubPlugin.address,
        limit: 0,
        secondRoute: stubPlugin2.address,
        customSlippageInBps,
      };
      await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

      const slippageInBps = await exchange.getSlippageInBps(
        usdc.address,
        busd.address
      );
      expect(slippageInBps).to.be.equal(customSlippageInBps);
    });
  });

  async function getMockPlugin() {
    const abi = (await artifacts.readArtifact("IExchangePlugin")).abi;
    const mock = await smock.fake(abi);
    return mock;
  }

  async function getTokenPriceObjects({
    usdcPrice = "1",
    usdtPrice = "1",
    busdPrice = "1",
  } = {}) {
    const tokenPriceUsdc = {
      price: parseUsdc(usdcPrice),
      priceDecimals: await usdc.decimals(),
      token: usdc.address,
    };
    const tokenPriceUsdt = {
      price: parseUsdt(usdtPrice),
      priceDecimals: await usdt.decimals(),
      token: usdt.address,
    };
    const tokenPriceBusd = {
      price: parseBusd(busdPrice),
      priceDecimals: await busd.decimals(),
      token: busd.address,
    };
    return { tokenPriceUsdc, tokenPriceUsdt, tokenPriceBusd };
  }
});
