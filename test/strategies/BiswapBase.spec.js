const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { utils } = require("ethers");
const {
  setupCore,
  setupFakeTokens,
  setupFakeToken,
  setupTokensLiquidityOnPancake,
  setupTestParams,
  deployFakeStrategy,
  deployBiswapStrategy,
} = require("../shared/commonSetup");
const { forkToken, mintForkedToken } = require("../shared/forkHelper");
const { provider, deploy } = require("../utils");

describe.only("Test BiswapBase", function () {
  let owner, nonReceiptOwner;
  // mock tokens with different decimals
  let tokenA, tokenB, bsw;
  // helper functions to parse amounts of mock tokens
  let parseTokenA, parseTokenB, parseBsw;
  // Mock lp token
  let mockLpToken;
  // core contracts
  let router, oracle, exchange, batch, receiptContract, sharesToken;
  // biswap strategy
  let biswapStrategy, mockBiswapStrategy;
  // pancake plugin
  let pancakePlugin;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  const BISWAP_POOL_ID = 4;
  const USDT_USDC_LP_ADDR = "0x1483767E665B3591677Fd49F724bf7430C18Bf83";

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batch, receiptContract, sharesToken } =
      await setupCore());

    const usdtInfo = await forkToken(hre.networkVariables.usdt);
    tokenA = usdtInfo.token;
    parseTokenA = usdtInfo.parseToken;

    const usdcInfo = await forkToken(hre.networkVariables.usdc);
    tokenB = usdcInfo.token;
    parseTokenB = usdcInfo.parseToken;

    const bswInfo = await forkToken(hre.networkVariables.bsw);
    bsw = bswInfo.token;
    parseBsw = bswInfo.parseToken;

    mockLpToken = await deploy("MockLPToken", tokenA.address, tokenB.address);

    biswapStrategy = await deployBiswapStrategy({
      router: router.address,
      poolId: BISWAP_POOL_ID,
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      lpToken: USDT_USDC_LP_ADDR,
      oracle: oracle.address,
      upgrader: owner.address,
    });

    mockBiswapStrategy = await deployBiswapStrategy({
      router: router.address,
      poolId: BISWAP_POOL_ID,
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      lpToken: mockLpToken.address,
      oracle: oracle.address,
      upgrader: owner.address,
    });

    pancakePlugin = await deploy("UniswapPlugin");

    await exchange.setRoute(
      [tokenA.address, bsw.address, bsw.address],
      [tokenB.address, tokenB.address, tokenA.address],
      [pancakePlugin.address, pancakePlugin.address, pancakePlugin.address]
    );

    await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter);

    const tokenAPrice = utils.parseUnits("1", 8);
    const tokenBPrice = utils.parseUnits("1", 8);
    await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 8);
    await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 8);
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

  describe("constructor & initialize", function () {
    it("check initial values", async function () {
      expect(await biswapStrategy.tokenA()).to.be.eq(tokenA.address);
      expect(await biswapStrategy.tokenB()).to.be.eq(tokenB.address);
      expect(await biswapStrategy.lpToken()).to.be.eq(USDT_USDC_LP_ADDR);
      expect(await biswapStrategy.strategyRouter()).to.be.eq(router.address);
      expect(await biswapStrategy.oracle()).to.be.eq(oracle.address);
      expect(await biswapStrategy.poolId()).to.be.eq(BISWAP_POOL_ID);

      expect(await biswapStrategy.depositToken()).to.be.eq(tokenA.address);
    });
  });

  describe("#getOraclePrice", function () {
    it("get oracle price with same decimals", async function () {
      const tokenAPrice = utils.parseUnits("2", 8);
      const tokenBPrice = utils.parseUnits("1", 8);
      await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 8);
      await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 8);

      expect(
        await biswapStrategy.getOraclePrice(tokenA.address, tokenB.address)
      ).to.be.eq(utils.parseEther("0.5"));
    });

    it("get oracle price with different same decimals(A decimals < B decimals)", async function () {
      const tokenAPrice = utils.parseUnits("2", 8);
      const tokenBPrice = utils.parseUnits("1", 10);
      await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 8);
      await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 10);

      expect(
        await biswapStrategy.getOraclePrice(tokenA.address, tokenB.address)
      ).to.be.eq(utils.parseEther("0.5"));
    });

    it("get oracle price with different same decimals(A decimals > B decimals)", async function () {
      const tokenAPrice = utils.parseUnits("2", 18);
      const tokenBPrice = utils.parseUnits("1", 10);
      await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 18);
      await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 10);

      expect(
        await biswapStrategy.getOraclePrice(tokenA.address, tokenB.address)
      ).to.be.eq(utils.parseEther("0.5"));
    });
  });

  describe("#deposit", function () {
    let tokenAInitialBalance;

    beforeEach(async () => {
      tokenAInitialBalance = parseTokenA("1000000");

      await mintForkedToken(
        tokenA.address,
        biswapStrategy.address,
        tokenAInitialBalance
      );
    });

    it("it reverts if msg.sender is not owner", async function () {
      await expect(
        biswapStrategy.connect(nonReceiptOwner).deposit(10)
      ).to.revertedWith("Ownable__CallerIsNotTheOwner()");
    });

    it("deposit", async function () {
      await biswapStrategy.deposit(parseTokenA("100"));
    });
  });

  describe.only("#calculateSwapAmount", function () {
    let tokenAInitialBalance, tokenAmount;
    const DEX_FEE = utils.parseEther("0.0025");

    beforeEach(async () => {
      tokenAInitialBalance = parseTokenA("1000000");
      tokenAmount = parseTokenA("1000");

      await mintForkedToken(
        tokenA.address,
        biswapStrategy.address,
        tokenAInitialBalance
      );
    });

    it.only("it reverts if oracle price and biswap price has too much difference", async function () {
      await oracle.setPriceAndDecimals(
        tokenA.address,
        utils.parseUnits("2", 8),
        8
      );

      await expect(
        biswapStrategy.calculateSwapAmountPublic(tokenAmount, DEX_FEE)
      ).to.revertedWith("PriceManipulation()");

      await oracle.setPriceAndDecimals(
        tokenA.address,
        utils.parseUnits("0.5", 8),
        8
      );

      await expect(
        biswapStrategy.calculateSwapAmountPublic(tokenAmount, DEX_FEE)
      ).to.revertedWith("PriceManipulation()");
    });
  });
});
