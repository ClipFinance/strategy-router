const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, skipBlocks, BLOCKS_MONTH, parseAmount, parseUsdt, getDepositToken, getUSDC, getBUSD } = require("./utils");


module.exports = { commonSetup, adminInitialDeposit };

async function commonSetup() {
  await setupTokens();
  await setupCore();
}

async function setupTokens() {

  [owner, feeAddress] = await ethers.getSigners();

  usdc = await getUSDC();
  busd = await getBUSD();

};

async function setupCore() {
  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~ 
  oracle = await ethers.getContractFactory("FakeOracle");
  oracle = await oracle.deploy();
  await oracle.deployed();

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
  exchange = await ethers.getContractFactory("Exchange");
  exchange = await exchange.deploy();
  await exchange.deployed();
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

  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
  router = await StrategyRouter.deploy();
  await router.deployed();
  await router.setMinUsdPerCycle(parseUniform("0.9"));
  await router.setExchange(exchange.address);
  await router.setOracle(oracle.address);
  await router.setFeePercent(2000);
  await router.setFeeAddress(feeAddress.address);

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
  await busd.approve(router.address, parseBusd("1000000"));
  await usdc.approve(router.address, parseUsdc("1000000"));

  await router.depositToBatch(busd.address, parseBusd("1"));
  await router.depositToStrategies();

  expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
};