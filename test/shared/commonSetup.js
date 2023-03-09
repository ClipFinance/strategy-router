const { parseUnits } = require("ethers/lib/utils");
const { ethers, upgrades } = require("hardhat");
const { getUSDC, getBUSD, getUSDT, deploy, parseUniform, deployProxy, deployProxyIdleStrategy } = require("../utils");
const { constants } = require('@openzeppelin/test-helpers');

module.exports = {
  setupTokens, setupCore, deployFakeStrategy,
  setupFakeUnderFulfilledWithdrawalStrategy, deployFakeUnderFulfilledWithdrawalStrategy,
  setupFakeTokens, setupTokensLiquidityOnPancake, setupParamsOnBNB, setupTestParams, setupRouterParams,
  setupFakePrices, setupPancakePlugin,
  setupFakeExchangePlugin, mintFakeToken,
  setupIdleStrategies
};

async function deployFakeStrategy({ router, token, weight = 10_000, profitPercent = 10_000 }) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  let strategy = await deploy("MockStrategy", token.address, profitPercent);
  await strategy.transferOwnership(router.address);
  await router.addStrategy(strategy.address, token.address, weight);
}

async function setupFakeUnderFulfilledWithdrawalStrategy({
 router, token, underFulfilledWithdrawalBps = 0,
 profitPercent = 0, isRewardPositive = true
}) {
  const strategy = await deploy(
    "UnderFulfilledWithdrawalMockStrategy",
    underFulfilledWithdrawalBps,
    token.address,
    profitPercent,
    isRewardPositive
  );
  await strategy.transferOwnership(router.address);
  strategy.token = token;

  return strategy;
}

async function deployFakeUnderFulfilledWithdrawalStrategy({
  router, token, underFulfilledWithdrawalBps,
  weight = 10_000, profitPercent = 0, isRewardPositive = true
}) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  const strategy = await setupFakeUnderFulfilledWithdrawalStrategy({
    router, token, underFulfilledWithdrawalBps, profitPercent, isRewardPositive
  });
  await router.addStrategy(strategy.address, token.address, weight);

  return strategy;
}

// Deploy TestCurrencies and mint totalSupply to the 'owner'
async function setupFakeTokens(router) {
  const [owner] = await ethers.getSigners();

  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  let parseUsdc = (args) => parseUnits(args, 18);
  let usdc = await deploy("MockToken", parseUsdc(totalSupply), 18);
  usdc.decimalNumber = 18;

  usdc.idleStrategy = await deployProxyIdleStrategy(owner, router, usdc);

  let parseBusd = (args) => parseUnits(args, 8);
  let busd = await deploy("MockToken", parseBusd(totalSupply), 8);
  busd.decimalNumber = 8;

  busd.idleStrategy = await deployProxyIdleStrategy(owner, router, busd);

  let parseUsdt = (args) => parseUnits(args, 6);
  let usdt = await deploy("MockToken", parseUsdt(totalSupply), 6);
  usdt.decimalNumber = 6;

  usdt.idleStrategy = await deployProxyIdleStrategy(owner, router, usdt);

  return { usdc, busd, usdt, parseUsdc, parseBusd, parseUsdt };

}

async function setupIdleStrategies(owner, router, ...tokens) {
  for (const token of tokens) {
    const StrategyFactory = await ethers.getContractFactory("DefaultIdleStrategy")
    const idleSTrategy = await upgrades.deployProxy(StrategyFactory, [owner.address], {
      kind: 'uups',
      constructorArgs: [router.address, token.address],
    });
    await idleSTrategy.transferOwnership(router.address);

    token.idleStrategy = idleSTrategy;
  }
}

async function mintFakeToken(toAddress, token, value) {
  await token.mint(toAddress, value);
}

// Deploy TestCurrencies and mint totalSupply to the 'owner'
async function setupFakeExchangePlugin(
  oracle,
  slippageBps,
  feeBps,
) {
  let exchangePlugin = await deploy(
    "MockExchangePlugin",
    oracle.address,
    slippageBps,
    feeBps,
  );

  // set up balances for main stablecoins
  await getUSDC(exchangePlugin.address);
  await getBUSD(exchangePlugin.address);
  await getUSDT(exchangePlugin.address);

  return { exchangePlugin };
}

// Create liquidity on uniswap-like router with test tokens
async function setupTokensLiquidityOnPancake(tokenA, tokenB, amount) {
  const [owner] = await ethers.getSigners();
  let uniswapRouter = await ethers.getContractAt("IUniswapV2Router02", hre.networkVariables.uniswapRouter);

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
};


// Get tokens that actually exists on BNB for testing
async function setupTokens() {
  ({ tokenContract: usdc, parse: parseUsdc } = await getUSDC());
  ({ tokenContract: usdt, parse: parseUsdt } = await getUSDT());
  ({ tokenContract: busd, parse: parseBusd } = await getBUSD());

  return { usdc, busd, usdt, parseUsdc, parseUsdt, parseBusd };
};

// deploy core contracts
async function setupCore() {

  // Deploy Oracle 
  let oracle = await deploy("FakeOracle");
  // Deploy Exchange 
  let exchange = await deployProxy("Exchange");
  // Deploy Batch
  let batch = await deployProxy("Batch");
  // Deploy StrategyRouterLib 
  let routerLib = await deploy("StrategyRouterLib");
  // Deploy StrategyRouter 
  let StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
    libraries: {
      StrategyRouterLib: routerLib.address
    }
  });
  let router = await upgrades.deployProxy(StrategyRouter, [], {
    kind: 'uups',
  });
  await router.deployed();
  // Deploy SharesToken
  let sharesToken = await deployProxy("SharesToken", [router.address]);
  // Deploy  ReceiptNFT
  let receiptContract = await deployProxy("ReceiptNFT", [router.address, batch.address]);

  // set addresses
  await router.setAddresses(
    exchange.address,
    oracle.address,
    sharesToken.address,
    batch.address,
    receiptContract.address
  );
  await batch.setAddresses(
    exchange.address,
    oracle.address,
    router.address,
    receiptContract.address
  );

  // Retrieve contracts that are deployed from StrategyRouter constructor
  let INITIAL_SHARES = Number(1e12);

  router.addSupportedToken = async function (token) {
    return await router.setSupportedToken(token.address, true, token.idleStrategy.address);
  };
  router.removeSupportedToken = async function (token) {
    return await router.setSupportedToken(token.address, false, constants.ZERO_ADDRESS);
  };

  return { oracle, exchange, router, receiptContract, batch, sharesToken, INITIAL_SHARES };
}

// Setup core params for testing with MockToken
async function setupTestParams(
  router,
  oracle,
  exchange,
  usdc,
  usdt,
  busd,
  fakeExchangePlugin = null
) {

  const [owner,,,,,,,,,feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setFeesPercent(2000);
  await router.setFeesCollectionAddress(feeAddress.address);
  await router.setAllocationWindowTime(1);

  // Setup fake prices
  let usdtAmount = parseUnits("0.99", await usdt.decimals());
  await oracle.setPrice(usdt.address, usdtAmount);
  let busdAmount = parseUnits("1.01", await busd.decimals());
  await oracle.setPrice(busd.address, busdAmount);
  let usdcAmount = parseUnits("1.0", await usdc.decimals());
  await oracle.setPrice(usdc.address, usdcAmount);

  let bsw = hre.networkVariables.bsw;

  // Setup exchange params
  busd = busd.address;
  usdc = usdc.address;
  usdt = usdt.address;
  if (fakeExchangePlugin) {
    await exchange.setRoute(
      [busd, busd, usdc, bsw, bsw, bsw],
      [usdt, usdc, usdt, busd, usdt, usdc],
      [
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address
      ]
    );
  } else {
    let pancakePlugin = await deploy("UniswapPlugin");
    let pancake = (pancakePlugin).address;
    await exchange.setRoute(
      [busd, busd, usdc, bsw, bsw, bsw],
      [usdt, usdc, usdt, busd, usdt, usdc],
      [pancake, pancake, pancake, pancake, pancake, pancake]
    );

    // pancake plugin params
    await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter);
    // await pancakePlugin.setUseWeth(bsw, busd, true);
    // await pancakePlugin.setUseWeth(bsw, usdt, true);
    // await pancakePlugin.setUseWeth(bsw, usdc, true);
  }
}

async function setupRouterParams(router, oracle, exchange) {

  const [owner, feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setFeesPercent(2000);
  await router.setFeesCollectionAddress(feeAddress.address);
  await router.setAllocationWindowTime(1);
}

async function setupFakePrices(oracle, usdc, usdt, busd) {
  // Setup fake prices
  let usdtAmount = parseUnits("0.99", await usdt.decimals());
  await oracle.setPrice(usdt.address, usdtAmount);
  let busdAmount = parseUnits("1.01", await busd.decimals());
  await oracle.setPrice(busd.address, busdAmount);
  let usdcAmount = parseUnits("1.0", await usdc.decimals());
  await oracle.setPrice(usdc.address, usdcAmount);
}

async function setupPancakePlugin(exchange, usdc, usdt, busd) {
  let bsw = hre.networkVariables.bsw;

  let pancakePlugin = await deploy("UniswapPlugin");
  let pancake = (pancakePlugin).address;
  // Setup exchange params
  busd = busd.address;
  usdc = usdc.address;
  usdt = usdt.address;
  await exchange.setRoute(
      [busd, busd, usdc, bsw, bsw, bsw],
      [usdt, usdc, usdt, busd, usdt, usdc],
      [pancake, pancake, pancake, pancake, pancake, pancake]
  );

  // pancake plugin params
  await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter);
  // await pancakePlugin.setUseWeth(bsw, busd, true);
  // await pancakePlugin.setUseWeth(bsw, usdt, true);
  // await pancakePlugin.setUseWeth(bsw, usdc, true);
}

// Setup core params that are similar (or the same) as those that will be set in production
async function setupParamsOnBNB(router, oracle, exchange) {
  const [owner,,,,,,,,,,feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setFeesPercent(2000);
  await router.setFeesCollectionAddress(feeAddress.address);
  await router.setAllocationWindowTime(1);

  await setupPluginsOnBNB(exchange);
}

async function setupPluginsOnBNB(exchange) {

  let bsw = hre.networkVariables.bsw;
  let busd = hre.networkVariables.busd;
  let usdt = hre.networkVariables.usdt;
  let usdc = hre.networkVariables.usdc;
  let acs4usd = hre.networkVariables.acs4usd.address;

  let acsPlugin = await deploy("CurvePlugin");
  let pancakePlugin = await deploy("UniswapPlugin");

  // Setup exchange params
  await exchange.setRoute(
    [busd, busd, usdc, bsw, bsw, bsw],
    [usdt, usdc, usdt, busd, usdt, usdc],
    [acsPlugin.address, acsPlugin.address, acsPlugin.address, 
      pancakePlugin.address, pancakePlugin.address, pancakePlugin.address]
  );

  // acs plugin params
  await acsPlugin.setCurvePool(busd, usdt, acs4usd);
  await acsPlugin.setCurvePool(usdc, usdt, acs4usd);
  await acsPlugin.setCurvePool(busd, usdc, acs4usd);
  await acsPlugin.setCoinIds(
    hre.networkVariables.acs4usd.address,
    hre.networkVariables.acs4usd.tokens,
    hre.networkVariables.acs4usd.coinIds
  );

  // pancake plugin params
  await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter);
  await pancakePlugin.setUseWeth(bsw, busd, true);
  await pancakePlugin.setUseWeth(bsw, usdt, true);
  await pancakePlugin.setUseWeth(bsw, usdc, true);
}