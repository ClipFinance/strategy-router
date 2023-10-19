const { parseUnits, parseEther } = require("ethers/lib/utils");
const { ethers, upgrades } = require("hardhat");
const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const IUniswapV2Factory = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const IUniswapV3Pool = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json");
const INonfungiblePositionManager = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json");
const { Pool, Position, nearestUsableTick } = require("@uniswap/v3-sdk");
const { Token } = require("@uniswap/sdk-core");
const {
  getUSDC,
  getBUSD,
  getUSDT,
  getHAY,
  deploy,
  create2Deploy,
  create2DeployProxy,
  deployProxyIdleStrategy,
  getCreate2DeployerAndProxyBytecode,
} = require("../utils");
const { getContract, impersonate } = require("./forkHelper");
const { BigNumber } = require("ethers");
const bn = require("bignumber.js");

module.exports = {
  setupTokens,
  setupCore,
  deployFakeStrategy,
  deployFakeUnderFulfilledWithdrawalStrategy,
  deployFakeOverFulfilledWithdrawalStrategy,
  setupFakeUnderFulfilledWithdrawalStrategy,
  setupFakeOverFulfilledWithdrawalStrategy,
  setupFakeUnderFulfilledWithdrawalIdleStrategy,
  setupFakeToken,
  setupFakeTokens,
  setupFakeTwoTokensByOrder,
  setupFakeUnderFulfilledTransferToken,
  setupTokensLiquidityOnPancake,
  setupTokensLiquidityOnBiswap,
  getPairToken,
  getPairTokenOnBiswap,
  getPairTokenOnPancake,
  deployTokensPoolAndProvideLiquidityOnPancakeV3,
  setupParamsOnBNB,
  setupTestParams,
  setupFakePrices,
  setupFakeExchangePlugin,
  mintFakeToken,
  deployBiswapStrategy,
  addBiswapPoolToRewardProgram,
  deployDodoStrategy,
  setupIdleStrategies,
  deployStargateStrategy,
};

async function deployFakeStrategy({
  batch,
  router,
  admin,
  token,
  weight = 10_000,
  profitPercent = 10_000,
}) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  let strategy = await deploy(
    "MockStrategy",
    token.address,
    profitPercent,
    token.parse((10_000_000).toString()),
    2000,
    [router.address, batch.address]
  );
  await strategy.transferOwnership(router.address);
  await admin.addStrategy(strategy.address, weight);
}

async function deployBiswapStrategy({
  router,
  poolId,
  tokenA,
  tokenB,
  lpToken,
  oracle,
  priceManipulationPercentThresholdInBps,
  upgrader,
  depositors,
  create2Deployer,
  ProxyBytecode,
  saltAddition,
}) {
  const { proxyContract: biswapStrategy } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    saltAddition,
    ContractName: "MockBiswapBase",
    constructorArgs: [
      router,
      poolId,
      tokenA.address,
      tokenB.address,
      lpToken,
      oracle,
      priceManipulationPercentThresholdInBps,
    ],
    initializeTypes: ["address", "uint256", "uint16", "address[]"],
    initializeArgs: [
      upgrader,
      tokenA.parse((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      depositors,
    ],
  });

  return biswapStrategy;
}

async function deployStargateStrategy({
  router,
  token,
  lpToken,
  stgToken,
  stargateRouter,
  stargateFarm,
  poolId,
  farmId,
  upgrader,
  depositors,
  create2Deployer,
  ProxyBytecode,
  saltAddition,
}) {
  const { proxyContract: stargateStrategy } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    saltAddition,
    ContractName: "StargateBase",
    constructorArgs: [
      router,
      token.address,
      lpToken,
      stgToken,
      stargateRouter,
      stargateFarm,
      poolId,
      farmId,
    ],
    initializeTypes: ["address", "uint256", "uint16", "address[]"],
    initializeArgs: [
      upgrader,
      token.parse((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      depositors,
    ],
  });

  return stargateStrategy;
}

async function deployDodoStrategy({
  router,
  token,
  lpToken,
  dodoToken,
  pool,
  farm,
  upgrader,
  depositors,
  create2Deployer,
  ProxyBytecode,
  saltAddition,
}) {
  if (!depositors) {
    depositors = [router];
  }
  const { proxyContract: dodoStrategy } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    saltAddition,
    ContractName: "DodoBase",
    constructorArgs: [router, token.address, lpToken, dodoToken, pool, farm],
    initializeTypes: ["address", "uint256", "uint16", "address[]"],
    initializeArgs: [
      upgrader,
      token.parse((100_000_000).toString()),
      500, // 5%
      depositors,
    ],
  });

  return dodoStrategy;
}

async function setupFakeUnderFulfilledWithdrawalStrategy({
  batch,
  router,
  token,
  underFulfilledWithdrawalBps = 0,
  profitPercent = 0,
  isRewardPositive = true,
  hardcapLimit = 10_000_000,
}) {
  const strategy = await deploy(
    "UnderFulfilledWithdrawalMockStrategy",
    underFulfilledWithdrawalBps,
    token.address,
    profitPercent,
    isRewardPositive,
    token.parse(hardcapLimit.toString()),
    2000,
    [router.address, batch.address]
  );
  await strategy.transferOwnership(router.address);
  strategy.token = token;

  return strategy;
}

async function setupFakeUnderFulfilledWithdrawalIdleStrategy({
  token,
  underFulfilledWithdrawalBps = 0,
}) {
  const strategy = await deploy(
    "UnderFulfilledWithdrawalMockIdleStrategy",
    underFulfilledWithdrawalBps,
    token.address
  );
  strategy.token = token;

  return strategy;
}

async function deployFakeUnderFulfilledWithdrawalStrategy({
  admin,
  batch,
  router,
  token,
  underFulfilledWithdrawalBps,
  weight = 10_000,
  profitPercent = 0,
  isRewardPositive = true,
  hardcapLimit,
}) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  const strategy = await setupFakeUnderFulfilledWithdrawalStrategy({
    batch,
    router,
    token,
    underFulfilledWithdrawalBps,
    profitPercent,
    isRewardPositive,
    hardcapLimit,
  });
  await admin.addStrategy(strategy.address, weight);
  return strategy;
}

async function setupFakeOverFulfilledWithdrawalStrategy({
  batch,
  router,
  token,
  overFulfilledWithdrawalBps = 0,
  profitPercent = 0,
  isRewardPositive = true,
}) {
  const strategy = await deploy(
    "OverFulfilledWithdrawalMockStrategy",
    overFulfilledWithdrawalBps,
    token.address,
    profitPercent,
    isRewardPositive,
    token.parse((10_000_000).toString()),
    2000,
    [router.address, batch.address]
  );
  await strategy.transferOwnership(router.address);
  strategy.token = token;

  return strategy;
}

async function deployFakeOverFulfilledWithdrawalStrategy({
  admin,
  batch,
  router,
  token,
  overFulfilledWithdrawalBps,
  weight = 10_000,
  profitPercent = 0,
  isRewardPositive = true,
}) {
  // console.log(router.address, await token.name(), weight, profitPercent);
  const strategy = await setupFakeOverFulfilledWithdrawalStrategy({
    batch,
    router,
    token,
    overFulfilledWithdrawalBps,
    profitPercent,
    isRewardPositive,
  });
  await admin.addStrategy(strategy.address, weight);

  return strategy;
}

// Deploy TestCurrencies and mint totalSupply to the 'owner'
async function setupFakeTokens(batch, router, create2Deployer, ProxyBytecode) {
  const [owner] = await ethers.getSigners();

  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  let parseUsdc = (value) => {
    if (typeof value === "number") {
      value = value.toString();
    }

    return parseUnits(value, 18);
  };
  let usdc = await deploy("MockToken", parseUsdc(totalSupply), 18);
  usdc.decimalNumber = 18;
  usdc.parse = parseUsdc;

  if (batch !== false) {
    usdc.idleStrategy = await deployProxyIdleStrategy(
      owner,
      batch,
      router,
      owner.address,
      usdc,
      "Usdc",
      create2Deployer,
      ProxyBytecode
    );
    usdc.idleStrategy.token = usdc;
  }

  let parseBusd = (value) => {
    if (typeof value === "number") {
      value = value.toString();
    }

    return parseUnits(value, 8);
  };
  let busd = await deploy("MockToken", parseBusd(totalSupply), 8);
  busd.decimalNumber = 8;
  busd.parse = parseBusd;

  if (batch !== false) {
    busd.idleStrategy = await deployProxyIdleStrategy(
      owner,
      batch,
      router,
      owner.address,
      busd,
      "Busd",
      create2Deployer,
      ProxyBytecode
    );
    busd.idleStrategy.token = busd;
  }

  let parseUsdt = (value) => {
    if (typeof value === "number") {
      value = value.toString();
    }

    return parseUnits(value, 6);
  };
  let usdt = await deploy("MockToken", parseUsdt(totalSupply), 6);
  usdt.decimalNumber = 6;
  usdt.parse = parseUsdt;

  if (batch !== false) {
    usdt.idleStrategy = await deployProxyIdleStrategy(
      owner,
      batch,
      router,
      owner.address,
      usdt,
      "Usdt",
      create2Deployer,
      ProxyBytecode
    );
    usdt.idleStrategy.token = usdt;
  }

  return { usdc, busd, usdt, parseUsdc, parseBusd, parseUsdt };
}

async function setupFakeTwoTokensByOrder(
  create2Deployer,
  decimals0 = 18,
  decimals1 = 18
) {
  // each test token's total supply, minted to owner
  const totalSupply = (100_000_000).toString();

  const parseToken0 = (args) => parseUnits(args, decimals0);
  let { contract: token0 } = await create2Deploy({
    ContractName: "MockToken",
    constructorArgs: [parseToken0(totalSupply), decimals0],
    create2Deployer,
    saltAddition: "Token0",
  });
  token0.decimalNumber = decimals0;
  token0.parse = parseToken0;

  const parseToken1 = (args) => parseUnits(args, decimals1);
  let { contract: token1 } = await create2Deploy({
    ContractName: "MockToken",
    constructorArgs: [parseToken1(totalSupply), decimals1],
    create2Deployer,
    saltAddition: "Token1",
  });
  token1.decimalNumber = decimals1;
  token1.parse = parseToken1;

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

async function setupFakeToken(decimals = 18) {
  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  let parseToken = (args) => parseUnits(args, decimals);
  let token = await deploy("MockToken", parseToken(totalSupply), decimals);
  token.decimalNumber = 18;
  token.parse = parseToken;

  return token;
}

async function setupFakeUnderFulfilledTransferToken(
  underFulfilledTransferInBps = 0,
  decimals = 18
) {
  // each test token's total supply, minted to owner
  let totalSupply = (100_000_000).toString();

  let parseToken = (args) => parseUnits(args, decimals);
  let token = await deploy(
    "UnderFulfilledTransferMockToken",
    underFulfilledTransferInBps,
    parseToken(totalSupply),
    decimals
  );
  token.decimalNumber = 18;
  token.parse = parseToken;

  return token;
}

async function setupIdleStrategies(
  owner,
  batch,
  router,
  create2Deployer,
  ProxyBytecode,
  ...tokens
) {
  for (const token of tokens) {
    tokenName = await token.symbol();
    idleStrategy = await deployProxyIdleStrategy(
      owner,
      batch,
      router,
      owner.address,
      token,
      tokenName,
      create2Deployer,
      ProxyBytecode
    );

    token.idleStrategy = idleStrategy;
  }
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
  await getHAY(exchangePlugin.address);

  return { exchangePlugin };
}

// Create liquidity on uniswap-like router with test tokens
async function setupTokensLiquidity(
  tokenA,
  tokenB,
  amount,
  amount1,
  routerAddr
) {
  const [owner] = await ethers.getSigners();
  let uniswapRouter = await ethers.getContractAt(
    "IUniswapV2Router02",
    routerAddr
  );

  let amountA = parseUnits(amount.toString(), await tokenA.decimals());
  let amountB = parseUnits(
    amount1 ? amount1.toString() : amount.toString(),
    await tokenB.decimals()
  );
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
  await setupTokensLiquidity(
    tokenA,
    tokenB,
    amount,
    amount1,
    hre.networkVariables.uniswapRouter
  );
}

// Create liquidity on Biswap
async function setupTokensLiquidityOnBiswap(tokenA, tokenB, amount, amount1) {
  await setupTokensLiquidity(
    tokenA,
    tokenB,
    amount,
    amount1,
    hre.networkVariables.biswapRouter
  );
}

// Get lp pair token on uniswap-like router
async function getPairToken(tokenA, tokenB, routerAddr) {
  let uniswapRouter = await ethers.getContractAt(
    "IUniswapV2Router02",
    routerAddr
  );

  const factory = await getContract(
    IUniswapV2Factory.abi,
    await uniswapRouter.factory()
  );

  const lpAddr = await factory.getPair(tokenA.address, tokenB.address);
  lpToken = await getContract("MockToken", lpAddr);

  return lpToken;
}

// Get pair token on Biswap
function getPairTokenOnBiswap(tokenA, tokenB) {
  return getPairToken(tokenA, tokenB, hre.networkVariables.biswapRouter);
}

// Get pair token on Pancake
function getPairTokenOnPancake(tokenA, tokenB) {
  return getPairToken(tokenA, tokenB, hre.networkVariables.uniswapRouter);
}

// Create liquidity on uniswap-like router with test tokens
async function addBiswapPoolToRewardProgram(lpTokenAddress, alloc = 70) {
  const biswapFarm = await getContract(
    "IBiswapFarm",
    hre.networkVariables.biswapFarm
  );

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

// Deploy UniswapV3-like pool and provide liquidity
async function deployTokensPoolAndProvideLiquidityOnPancakeV3(
  tokenA,
  tokenB,
  fee,
  amount
) {
  const [owner] = await ethers.getSigners();
  const factory = await ethers.getContractAt(
    IUniswapV3Factory.abi,
    hre.networkVariables.uniswapV3Factory
  );
  const nonfungiblePositionManager = await ethers.getContractAt(
    INonfungiblePositionManager.abi,
    hre.networkVariables.nonfungiblePositionManager
  );

  const tokenAData = await getTokenData(tokenA, amount);
  const tokenBData = await getTokenData(tokenB, amount);

  // sort tokens data by address
  const [token0, token1] = BigNumber.from(tokenA.address).gt(tokenB.address)
    ? [tokenBData, tokenAData]
    : [tokenAData, tokenBData];

  await nonfungiblePositionManager.createAndInitializePoolIfNecessary(
    token0.address,
    token1.address,
    fee,
    // prepare reserves to set up pool price to 1:1
    encodePriceSqrt(token1.reserve, token0.reserve)
  );

  // prepare data to create pool object
  const poolAddress = await factory.getPool(
    tokenA.address,
    tokenB.address,
    fee
  );
  const pool = await ethers.getContractAt(IUniswapV3Pool.abi, poolAddress);
  const poolData = await getPoolV3Data(pool);

  const poolObj = new Pool(
    new Token(
      hre.network.config.chainId,
      token0.address,
      token0.decimals,
      token0.symbol,
      token0.name
    ),
    new Token(
      hre.network.config.chainId,
      token1.address,
      token1.decimals,
      token1.symbol,
      token1.name
    ),
    poolData.fee,
    poolData.sqrtPriceX96.toString(),
    poolData.liquidity.toString(),
    poolData.tick
  );

  // calculate ticks
  const nearestTick = nearestUsableTick(poolData.tick, poolData.tickSpacing);
  const tickLower = BigNumber.from(
    nearestTick - poolData.tickSpacing * 100
  ).toNumber();
  const tickUpper = BigNumber.from(
    nearestTick + poolData.tickSpacing * 100
  ).toNumber();

  // create position object to get desired amounts of tokens to provide liquidity
  const positionObj = new Position.fromAmounts({
    pool: poolObj,
    tickLower,
    tickUpper,
    amount0: token0.amount,
    amount1: token1.amount,
    useFullPrecision: false,
  });

  const { amount0: amount0Desired, amount1: amount1Desired } =
    positionObj.mintAmounts;

  // approve tokens
  await token0.contract.approve(
    nonfungiblePositionManager.address,
    amount0Desired.toString()
  );
  await token1.contract.approve(
    nonfungiblePositionManager.address,
    amount1Desired.toString()
  );

  // mint liquidity
  const params = {
    token0: token0.address,
    token1: token1.address,
    fee: poolData.fee,
    tickLower: tickLower,
    tickUpper: tickUpper,
    amount0Desired: amount0Desired.toString(),
    amount1Desired: amount1Desired.toString(),
    amount0Min: 0,
    amount1Min: 0,
    recipient: owner.address,
    deadline: (await ethers.provider.getBlock("latest")).timestamp + 60 * 10,
  };

  await nonfungiblePositionManager.mint(params);

  return pool;
}

// returns the sqrt price
function encodePriceSqrt(reserve1, reserve0) {
  const sqrtPriceX96 = BigNumber.from(
    "0x" +
      new bn(reserve1.toString())
        .div(reserve0.toString())
        .sqrt()
        .multipliedBy(new bn(2).pow(96))
        .integerValue(3)
        .toString(16)
  );
  return sqrtPriceX96;
}

async function getTokenData(tokenContract, amount) {
  const decimals = await tokenContract.decimals();
  return {
    contract: tokenContract,
    address: tokenContract.address,
    symbol: await tokenContract.symbol(),
    name: await tokenContract.name(),
    decimals,
    reserve: parseUnits("1", decimals),
    amount: parseUnits(amount, decimals),
  };
}

async function getPoolV3Data(poolContract) {
  const [token0, token1, tickSpacing, fee, liquidity, slot0] =
    await Promise.all([
      poolContract.token0(),
      poolContract.token1(),
      poolContract.tickSpacing(),
      poolContract.fee(),
      poolContract.liquidity(),
      poolContract.slot0(),
    ]);

  return {
    token0,
    token1,
    tickSpacing,
    fee,
    liquidity,
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
  };
}

// Get tokens that actually exists on BNB for testing
async function setupTokens() {
  ({ tokenContract: usdc, parse: parseUsdc } = await getUSDC());
  ({ tokenContract: usdt, parse: parseUsdt } = await getUSDT());
  ({ tokenContract: busd, parse: parseBusd } = await getBUSD());
  ({ tokenContract: hay, parse: parseHay } = await getHAY());

  return {
    usdc,
    parseUsdc,
    busd,
    parseBusd,
    usdt,
    parseUsdt,
    hay,
    parseHay,
  };
}

// deploy core contracts
async function setupCore(
  { batchContract, oracleContract } = {
    batchContract: "Batch",
    oracleContract: "FakeOracle",
  }
) {
  // Deploy Create2Deployer and get ProxyBytecode
  const { create2Deployer, ProxyBytecode } =
    await getCreate2DeployerAndProxyBytecode();

  // Deploy Oracle
  let oracle;
  oracleContract === "ChainlinkOracle"
    ? ({ proxyContract: oracle } = await create2DeployProxy({
        create2Deployer,
        ProxyBytecode,
        ContractName: "ChainlinkOracle",
      }))
    : ({ contract: oracle } = await create2Deploy({
        create2Deployer,
        ContractName: oracleContract,
      }));

  // Deploy Exchange
  const { proxyContract: exchange } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    ContractName: "Exchange",
  });

  // Deploy Batch
  const { proxyContract: batch } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    ContractName: batchContract,
  });

  // Deploy StrategyRouterLib
  let routerLib = await deploy("StrategyRouterLib");

  // Deploy StrategyRouter
  const { proxyContract: router } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    ContractName: "StrategyRouter",
    factoryOptions: {
      libraries: {
        StrategyRouterLib: routerLib.address,
      },
    },
  });

  // Deploy Admin
  const { contract: admin } = await create2Deploy({
    create2Deployer,
    ContractName: "RouterAdmin",
    constructorArgs: [router.address],
  });

  // Deploy and setup BatchOut
  const { proxyContract: batchOut } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    ContractName: "BatchOut",
  });

  // Deploy SharesToken
  const { proxyContract: sharesToken } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    ContractName: "SharesToken",
    initializeTypes: ["address", "address"],
    initializeArgs: [router.address, batchOut.address],
  });

  // Deploy  ReceiptNFT
  const { proxyContract: receiptContract } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    ContractName: "ReceiptNFT",
    initializeTypes: ["address", "address", "string", "bool"],
    initializeArgs: [
      router.address,
      batch.address,
      "https://www.clip.finance/",
      false,
    ],
  });

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

  // Setup BatchOut
  await batchOut.setAddresses(
    exchange.address,
    oracle.address,
    router.address,
    receiptContract.address,
    sharesToken.address,
    admin.address
  );

  await admin.grantRole(await admin.MODERATOR(), batchOut.address);

  // Retrieve contracts that are deployed from StrategyRouter constructor
  let INITIAL_SHARES = Number(1e12);

  admin.addSupportedToken = async function (token) {
    return await admin.setSupportedToken(
      token.address,
      true,
      token.idleStrategy.address
    );
  };

  admin.removeSupportedToken = async function (token) {
    return await admin.setSupportedToken(
      token.address,
      false,
      ethers.constants.AddressZero
    );
  };

  await exchange.setMaxStablecoinSlippageInBps(1000);

  return {
    create2Deployer,
    ProxyBytecode,
    oracle,
    exchange,
    admin,
    router,
    receiptContract,
    batch,
    batchOut,
    sharesToken,
    INITIAL_SHARES,
  };
}

// Setup core params for testing with MockToken
async function setupTestParams(
  router,
  oracle,
  exchange,
  admin,
  usdc,
  usdt,
  busd,
  fakeExchangePlugin = null
) {
  const [owner, , , , , , , , , feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setFeesCollectionAddress(admin.address);
  await admin.setAllocationWindowTime(1);
  // Setup fake prices
  let usdtAmount = parseUnits("0.99", await usdt.decimals());
  await oracle.setPrice(usdt.address, usdtAmount);
  let busdAmount = parseUnits("1.01", await busd.decimals());
  await oracle.setPrice(busd.address, busdAmount);
  let usdcAmount = parseUnits("1.00", await usdc.decimals());
  await oracle.setPrice(usdc.address, usdcAmount);

  let bsw = hre.networkVariables.bsw;
  let the = hre.networkVariables.the;
  let hay = hre.networkVariables.hay;
  // let wbnb = hre.networkVariables.wbnb;

  // Setup exchange params
  busd = busd.address;
  usdc = usdc.address;
  usdt = usdt.address;
  if (fakeExchangePlugin) {
    await exchange.setRoute(
      [busd, busd, usdc, hay, hay, hay, bsw, bsw, bsw, the, the, the, the],
      [
        usdt,
        usdc,
        usdt,
        usdt,
        usdc,
        busd,
        busd,
        usdt,
        usdc,
        busd,
        usdt,
        usdc,
        hay,
      ],
      [
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
        fakeExchangePlugin.address,
      ]
    );
  } else {
    let pancakePlugin = await deploy(
      "UniswapPlugin",
      hre.networkVariables.uniswapRouter
    );
    let pancake = pancakePlugin.address;
    await exchange.setRoute(
      [busd, busd, usdc, hay, bsw, bsw, bsw],
      [usdt, usdc, usdt, usdt, busd, usdt, usdc],
      [pancake, pancake, pancake, pancake, pancake, pancake, pancake]
    );
  }
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

// Setup core params that are similar (or the same) as those that will be set in production
async function setupParamsOnBNB(admin, router, oracle, exchange) {
  const [owner, , , , , , , , , , feeAddress] = await ethers.getSigners();
  // Setup router params
  await router.setFeesCollectionAddress(admin.address);
  await admin.setAllocationWindowTime(1);

  await setupPluginsOnBNB(exchange);
}

async function setupPluginsOnBNB(exchange) {
  let wbnb = hre.networkVariables.wbnb;
  let bsw = hre.networkVariables.bsw;
  let busd = hre.networkVariables.busd;
  let usdt = hre.networkVariables.usdt;
  let usdc = hre.networkVariables.usdc;
  let hay = hre.networkVariables.hay;
  let dodo = hre.networkVariables.dodo;
  let stg = hre.networkVariables.stg;
  let the = hre.networkVariables.the;
  // let acs4usd = hre.networkVariables.acs4usd.address;

  // let acsPlugin = await deploy("CurvePlugin");
  let pancakePlugin = await deploy(
    "UniswapPlugin",
    hre.networkVariables.uniswapRouter
  );
  // console.log("UniswapPlugin Plugin!", pancakePlugin.address);
  let pancakeV3Plugin = await deploy(
    "UniswapV3Plugin",
    hre.networkVariables.uniswapV3Router
  );
  // console.log("UniswapV3Plugin Plugin!", pancakeV3Plugin.address);

  let wombatPlugin = await deploy(
    "WombatPlugin",
    hre.networkVariables.wombatRouter
  );
  // console.log("Wombat Plugin!", wombatPlugin.address);

  let biSwapPlugin = await deploy(
    "UniswapPlugin",
    hre.networkVariables.biswapRouter
  );

  // console.log("biSwapPlugin Plugin!", biSwapPlugin.address);

  let thenaAlgebraPlugin = await deploy(
    "AlgebraPlugin",
    hre.networkVariables.thenaAlgebraRouter,
    hre.networkVariables.thenaAlgebraFactory
  );

  // console.log("thenaAlgebraPlugin!", thenaAlgebraPlugin.address);

  // Setup exchange params
  await exchange.setRoute(
    [
      // stable coins
      busd,
      busd,
      usdc,

      // hay pairs
      hay,
      hay,
      hay,

      // bsw pairs
      bsw,
      bsw,
      bsw,
      bsw,

      // stg pairs
      stg,
      stg,

      // dodo pairs
      dodo,
      dodo,

      // the pairs
      the,
      the,
      the,
    ],
    [
      // stable coins
      usdt,
      usdc,
      usdt,

      // hay pairs
      usdc,
      usdt,
      busd,

      // bsw pairs
      busd,
      usdt,
      usdc,
      hay,

      // stg pairs
      usdt,
      busd,

      // dodo pairs
      usdt,
      busd,

      // the pairs
      usdt,
      usdc,
      hay,
    ],
    [
      // stable coins
      pancakeV3Plugin.address,
      pancakeV3Plugin.address,
      pancakeV3Plugin.address,

      // hay pairs
      wombatPlugin.address,
      wombatPlugin.address,
      wombatPlugin.address,

      // bsw pairs
      pancakePlugin.address,
      pancakePlugin.address,
      pancakePlugin.address,
      biSwapPlugin.address,

      // stg pairs
      pancakePlugin.address,
      pancakePlugin.address,

      // dodo pairs
      pancakePlugin.address,
      pancakePlugin.address,

      // the pairs
      thenaAlgebraPlugin.address,
      thenaAlgebraPlugin.address,
      thenaAlgebraPlugin.address,
    ]
  );

  // acs plugin params
  // await acsPlugin.setCurvePool(busd, usdt, acs4usd);
  // await acsPlugin.setCurvePool(usdc, usdt, acs4usd);
  // await acsPlugin.setCurvePool(busd, usdc, acs4usd);
  // await acsPlugin.setCoinIds(
  //   hre.networkVariables.acs4usd.address,
  //   hre.networkVariables.acs4usd.tokens,
  //   hre.networkVariables.acs4usd.coinIds
  // );

  // pancake v3 plugin params
  await pancakeV3Plugin.setSingleHopPairData(100, [busd, usdt]);
  await pancakeV3Plugin.setSingleHopPairData(100, [busd, usdc]);
  await pancakeV3Plugin.setSingleHopPairData(100, [usdc, usdt]);

  // pancake plugin params
  await pancakePlugin.setMediatorTokenForPair(wbnb, [dodo, usdt]);
  await pancakePlugin.setMediatorTokenForPair(wbnb, [dodo, busd]);
  await pancakePlugin.setMediatorTokenForPair(wbnb, [bsw, busd]);
  await pancakePlugin.setMediatorTokenForPair(wbnb, [bsw, usdt]);
  await pancakePlugin.setMediatorTokenForPair(wbnb, [bsw, usdc]);
  await pancakePlugin.setMediatorTokenForPair(busd, [stg, usdt]);
  await pancakePlugin.setMediatorTokenForPair(wbnb, [the, usdt]);
  await pancakePlugin.setMediatorTokenForPair(wbnb, [the, usdc]);

  // biswap plugin params
  await biSwapPlugin.setMediatorTokenForPair(usdt, [bsw, hay]);

  // wombat plugin params
  await wombatPlugin.setMediatorTokenForPair(usdc, [hay, busd]);

  await wombatPlugin.setPoolForPair(hre.networkVariables.wombatHayPool, [
    hay,
    usdc,
  ]);
  await wombatPlugin.setPoolForPair(hre.networkVariables.wombatHayPool, [
    hay,
    usdt,
  ]);
  await wombatPlugin.setPoolForPair(hre.networkVariables.wombatMainPool, [
    busd,
    usdt,
  ]);
  await wombatPlugin.setPoolForPair(hre.networkVariables.wombatMainPool, [
    busd,
    usdc,
  ]);
  await wombatPlugin.setPoolForPair(hre.networkVariables.wombatMainPool, [
    usdc,
    usdt,
  ]);

  // thena algebra plugin params
  await thenaAlgebraPlugin.setMediatorTokenForPair(usdt, [the, hay]);
  await thenaAlgebraPlugin.setMediatorTokenForPair(usdt, [the, usdc]);
}
