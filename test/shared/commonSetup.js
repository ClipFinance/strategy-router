const { parseUnits, parseEther } = require("ethers/lib/utils");
const { ethers, upgrades } = require("hardhat");
const {
  getUSDC,
  getBUSD,
  getUSDT,
  deploy,
  parseUniform,
  deployProxy,
} = require("../utils");
const {
  getContract,
  impersonate
} = require("./forkHelper")

module.exports = {
  setupTokens,
  setupCore,
  deployFakeStrategy,
  deployFakeUnderFulfilledWithdrawalStrategy,
  setupFakeToken,
  setupFakeTokens,
  setupFakeTwoTokensByOrder,
  setupTokensLiquidityOnPancake,
  setupTokensLiquidityOnBiswap,
  getPairToken,
  getPairTokenOnBiswap,
  setupParamsOnBNB,
  setupTestParams,
  setupRouterParams,
  setupFakePrices,
  setupPancakePlugin,
  setupFakeExchangePlugin,
  mintFakeToken,
  deployBiswapStrategy,
  deployDodoStrategy,
  addBiswapPool,
};

async function deployFakeStrategy({
  router,
  token,
  weight = 10_000,
  profitPercent = 10_000,
}) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  let strategy = await deploy("MockStrategy", token.address, profitPercent);
  await strategy.transferOwnership(router.address);
  await router.addStrategy(strategy.address, token.address, weight);
}

async function deployBiswapStrategy({
  router,
  poolId,
  tokenA,
  tokenB,
  lpToken,
  oracle,
  upgrader,
}) {
  let BiswapBase = await ethers.getContractFactory("MockBiswapBase");
  let biswapStrategy = await upgrades.deployProxy(BiswapBase, [upgrader], {
    kind: "uups",
    constructorArgs: [router, poolId, tokenA, tokenB, lpToken, oracle],
  });

  return biswapStrategy;
}

async function deployDodoStrategy({
  router,
  token,
  lpToken,
  dodoToken,
  pool,
  farm,
  upgrader,
}) {
  let DodoBase = await ethers.getContractFactory("DodoBase");
  let dodoStrategy = await upgrades.deployProxy(DodoBase, [upgrader], {
    kind: "uups",
    constructorArgs: [router, token, lpToken, dodoToken, pool, farm],
    unsafeAllow: ['delegatecall']
  });

  return dodoStrategy;
}

async function deployFakeUnderFulfilledWithdrawalStrategy({
  router, token, underFulfilledWithdrawalBps,
  weight = 10_000, profitPercent = 0, isRewardPositive = true
}) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  let strategy = await deploy(
    "UnderFulfilledWithdrawalMockStrategy",
    underFulfilledWithdrawalBps,
    token.address,
    profitPercent,
    isRewardPositive
  );
  await strategy.transferOwnership(router.address);
  await router.addStrategy(strategy.address, token.address, weight);
}

// Deploy TestCurrencies and mint totalSupply to the 'owner'
async function setupFakeTokens() {
  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  let parseUsdc = (args) => parseUnits(args, 18);
  let usdc = await deploy("MockToken", parseUsdc(totalSupply), 18);
  usdc.decimalNumber = 18;

  let parseBusd = (args) => parseUnits(args, 8);
  let busd = await deploy("MockToken", parseBusd(totalSupply), 8);
  busd.decimalNumber = 8;

  let parseUsdt = (args) => parseUnits(args, 6);
  let usdt = await deploy("MockToken", parseUsdt(totalSupply), 6);
  usdt.decimalNumber = 6;

  return { usdc, busd, usdt, parseUsdc, parseBusd, parseUsdt };
}

async function setupFakeTwoTokensByOrder() {
  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  let token0 = await deploy("MockToken", parseUnits(totalSupply, 18), 18);
  token0.decimalNumber = 18;

  let token1 = await deploy("MockToken", parseUnits(totalSupply, 18), 18);
  token1.decimalNumber = 18;

  if (token0.address.toLowerCase() > token1.address.toLowerCase()) {
    const token = token0;
    token0 = token1;
    token1 = token;
  }

  return { token0, token1 };
}

async function setupFakeToken(
  totalSupply = (100_000_000).toString(),
  decimals = 18
) {
  let parseToken = (args) => parseUnits(args, decimals);
  let token = await deploy("MockToken", parseToken(totalSupply), decimals);
  token.decimalNumber = decimals;

  return { token, parseToken };
}

async function mintFakeToken(toAddress, token, value) {
  await token.mint(toAddress, value);
}

// Deploy TestCurrencies and mint totalSupply to the 'owner'
async function setupFakeExchangePlugin(oracle, slippageBps, feeBps) {
  let exchangePlugin = await deploy(
    "MockExchangePlugin",
    oracle.address,
    slippageBps,
    feeBps
  );

  // set up balances for main stablecoins
  await getUSDC(exchangePlugin.address);
  await getBUSD(exchangePlugin.address);
  await getUSDT(exchangePlugin.address);

  return { exchangePlugin };
}

// Create liquidity on uniswap-like router with test tokens
async function setupTokensLiquidity(tokenA, tokenB, amount, amount1, routerAddr) {
  const [owner] = await ethers.getSigners();
  let uniswapRouter = await ethers.getContractAt(
    "IUniswapV2Router02",
    routerAddr
  );

  let amountA = parseUnits(amount.toString(), await tokenA.decimals());
  let amountB = parseUnits(amount1 ? amount1.toString() : amount.toString(), await tokenB.decimals());
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

// Create liquidity on Pancake
async function setupTokensLiquidityOnPancake(tokenA, tokenB, amount, amount1) {
  await setupTokensLiquidity(tokenA, tokenB, amount, amount1, hre.networkVariables.uniswapRouter)
}

// Create liquidity on Biswap
async function setupTokensLiquidityOnBiswap(tokenA, tokenB, amount, amount1) {
  await setupTokensLiquidity(tokenA, tokenB, amount, amount1, hre.networkVariables.biswapRouter)
}

// Get lp pair token on uniswap-like router
async function getPairToken(tokenA, tokenB, routerAddr) {
  let uniswapRouter = await ethers.getContractAt(
    "IUniswapV2Router02",
    routerAddr
  );

  const factory = await getContract(
    "IUniswapV2Factory",
    await uniswapRouter.factory()
  );

  const lpAddr = await factory.getPair(tokenA.address, tokenB.address);
  lpToken = await getContract("MockToken", lpAddr);

  return lpToken;
}

// Get pair token on Biswap
function getPairTokenOnBiswap(tokenA, tokenB) {
  return getPairToken(tokenA, tokenB, hre.networkVariables.biswapRouter)
}

// Create liquidity on uniswap-like router with test tokens
async function addBiswapPool(lpTokenAddress, alloc = 70) {
  const biswapFarm = await getContract("IBiswapFarm", hre.networkVariables.biswapFarm);

  biswapOwner = await impersonate(await biswapFarm.owner());

  biswapPoolId = await biswapFarm.poolLength();

  const [owner] = await ethers.getSigners();

  await owner.sendTransaction({
    from: owner.address,
    to: biswapOwner.address,
    value: parseEther("1"),
  });
  await biswapFarm.connect(biswapOwner).add(alloc, lpTokenAddress, false);

  return biswapPoolId;
}

// Get tokens that actually exists on BNB for testing
async function setupTokens() {
  ({ tokenContract: usdc, parse: parseUsdc } = await getUSDC());
  ({ tokenContract: usdt, parse: parseUsdt } = await getUSDT());
  ({ tokenContract: busd, parse: parseBusd } = await getBUSD());
  return { usdc, busd, usdt, parseUsdc, parseUsdt, parseBusd };
}

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
      StrategyRouterLib: routerLib.address,
    },
  });
  let router = await upgrades.deployProxy(StrategyRouter, [], {
    kind: "uups",
  });
  await router.deployed();
  // Deploy SharesToken
  let sharesToken = await deployProxy("SharesToken", [router.address]);
  // Deploy  ReceiptNFT
  let receiptContract = await deployProxy("ReceiptNFT", [
    router.address,
    batch.address,
  ]);

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

  return {
    oracle,
    exchange,
    router,
    receiptContract,
    batch,
    sharesToken,
    INITIAL_SHARES,
  };
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
  const [owner, , , , , , , , , feeAddress] = await ethers.getSigners();
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
        fakeExchangePlugin.address,
      ]
    );
  } else {
    let pancakePlugin = await deploy("UniswapPlugin");
    let pancake = pancakePlugin.address;
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
  let pancake = pancakePlugin.address;
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
  const [owner, , , , , , , , , , feeAddress] = await ethers.getSigners();
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
  let dodo = hre.networkVariables.dodo;
  let acs4usd = hre.networkVariables.acs4usd.address;

  let acsPlugin = await deploy("CurvePlugin");
  let pancakePlugin = await deploy("UniswapPlugin");

  // Setup exchange params
  await exchange.setRoute(
    [busd, busd, usdc, bsw, bsw, bsw, usdt],
    [usdt, usdc, usdt, busd, usdt, usdc, dodo],
    [
      acsPlugin.address,
      acsPlugin.address,
      acsPlugin.address,
      pancakePlugin.address,
      pancakePlugin.address,
      pancakePlugin.address,
      pancakePlugin.address,
    ]
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
