const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
let { getTokens, skipBlocks, BLOCKS_MONTH, parseAmount, parseUsdt, getDepositToken, getUSDC, getBUSD, getUSDT, parseUsdc, parseBusd, deploy } = require("../utils");


module.exports = {
  commonSetup, setupTokens, setupCore, adminInitialDeposit,
  setupFakeTokens, setupFakeTokensLiquidity, setupParamsOnBNB, setupTestParams
};

async function commonSetup() {
  await setupTokens();
  await setupCore();
}


// Deploy TestCurrencies and mint totalSupply to the 'owner'
async function setupFakeTokens() {

  [owner] = await ethers.getSigners();

  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  parseUsdc = (args) => parseUnits(args, 18);
  usdc = await deploy("TestCurrency", parseUsdc(totalSupply), 18);

  parseBusd = (args) => parseUnits(args, 8);
  busd = await deploy("TestCurrency", parseBusd(totalSupply), 8);

  parseUsdt = (args) => parseUnits(args, 6);
  usdt = await deploy("TestCurrency", parseUsdt(totalSupply), 6);

  return { usdc, busd, usdt, parseUsdc, parseBusd, parseUsdt };

};

// Create liquidity on uniswap-like router with test tokens
async function setupFakeTokensLiquidity() {

  [owner] = await ethers.getSigners();

  let uniswapRouter = await ethers.getContractAt("IUniswapV2Router02", hre.networkVariables.uniswapRouter);
  let addLiquidity = async (tokenA, tokenB, amount) => {
    let amountA = parseUnits(amount, await tokenA.decimals());
    let amountB = parseUnits(amount, await tokenB.decimals());
    await tokenA.approve(uniswapRouter.address, amountA);
    await tokenB.approve(uniswapRouter.address, amountB);
    await uniswapRouter.addLiquidity(
      tokenA.address,
      tokenB.address,
      amountA,
      amountB,
      0,
      0,
      owner.address,
      Date.now()
    );
  }

  let amount = (1_000_000).toString();
  await addLiquidity(usdc, usdt, amount);
  await addLiquidity(usdc, busd, amount);
  await addLiquidity(busd, usdt, amount);
};


// Get tokens that actually exists on BNB for testing
async function setupTokens() {

  [owner] = await ethers.getSigners();

  usdc = await getUSDC();
  busd = await getBUSD();
  usdt = await getUSDT();

};

// deploy core contracts
async function setupCore() {

  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~ 
  oracle = await deploy("FakeOracle");

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
  exchange = await deploy("Exchange");

  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  router = await deploy("StrategyRouter");

  // ~~~~~~~~~~~ SET GLOBAL VARIABLES ~~~~~~~~~~~ 
  receiptContract = await ethers.getContractAt(
    "ReceiptNFT",
    await router.receiptContract()
  );
  batching = await ethers.getContractAt(
    "Batching",
    await router.batching()
  );
  sharesToken = await ethers.getContractAt(
    "SharesToken",
    await router.sharesToken()
  );
  CYCLE_DURATION = Number(await router.cycleDuration());
  INITIAL_SHARES = Number(await router.INITIAL_SHARES());
}

async function adminInitialDeposit() {
  await router.depositToBatch(busd.address, parseBusd("1"));
  await router.depositToStrategies();

  expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
}

// Setup core params for testing with TestCurrency
async function setupTestParams() {

  [owner, feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setMinUsdPerCycle(parseUniform("0.9"));
  await router.setExchange(exchange.address);
  await router.setOracle(oracle.address);
  await router.setFeePercent(2000);
  await router.setFeeAddress(feeAddress.address);
  await router.setCycleDuration(CYCLE_DURATION)

  // Setup fake prices
  await oracle.setPrice(usdt.address, parseUsdt("0.99"));
  await oracle.setPrice(busd.address, parseBusd("1.01"));
  await oracle.setPrice(usdc.address, parseUsdc("1.0"));

  // Setup exchange params
  await exchange.setUniswapRouter(hre.networkVariables.uniswapRouter);
  await exchange.setDexType(
    [
      busd.address,
      busd.address,
      usdc.address,
    ],
    [
      usdt.address,
      usdc.address,
      usdt.address,
    ],
    [
      hre.networkVariables.exchangeTypes.pancakeDirect,
      hre.networkVariables.exchangeTypes.pancakeDirect,
      hre.networkVariables.exchangeTypes.pancakeDirect,
    ]
  );

}

// Setup core params that are similar (or the same) as those that will be set in production
async function setupParamsOnBNB() {
  [owner, feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setMinUsdPerCycle(parseUniform("0.9"));
  await router.setExchange(exchange.address);
  await router.setOracle(oracle.address);
  await router.setFeePercent(2000);
  await router.setFeeAddress(feeAddress.address);
  await router.setCycleDuration(CYCLE_DURATION)

  // Setup exchange params
  await exchange.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdt,
    hre.networkVariables.acryptosUst4Pool.address
  );
  await exchange.setCurvePool(
    hre.networkVariables.usdc,
    hre.networkVariables.usdt,
    hre.networkVariables.acryptosUst4Pool.address
  );
  await exchange.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdc,
    hre.networkVariables.acryptosUst4Pool.address
  );
  await exchange.setUniswapRouter(hre.networkVariables.uniswapRouter);
  await exchange.setCoinIds(
    hre.networkVariables.acryptosUst4Pool.address,
    hre.networkVariables.acryptosUst4Pool.tokens,
    hre.networkVariables.acryptosUst4Pool.coinIds
  );
  await exchange.setDexType(
    [
      hre.networkVariables.busd,
      hre.networkVariables.busd,
      hre.networkVariables.usdc,
    ],
    [
      hre.networkVariables.usdt,
      hre.networkVariables.usdc,
      hre.networkVariables.usdt,
    ],
    [
      hre.networkVariables.exchangeTypes.acryptosUst4Pool,
      hre.networkVariables.exchangeTypes.acryptosUst4Pool,
      hre.networkVariables.exchangeTypes.acryptosUst4Pool,
    ]
  );

}