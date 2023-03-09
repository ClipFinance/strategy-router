const { parseUnits } = require("ethers/lib/utils");
const hre = require("hardhat");
const { ethers } = require("hardhat");
const { deploy, deployProxy, parseUniform, deployProxyIdleStrategy } = require("../test/utils");
const fs = require("fs");

// deploy script for testing on mainnet
// to test on hardhat network:
//   remove block pinning from config and uncomment 'accounts'
//   in .env set account with bnb and at least INITIAL_DEPOSIT usdc

async function main() {

  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 

  [owner] = await ethers.getSigners();

  await setupVerificationHelper();

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  // ~~~~~~~~~~~ GET TOKENS ADDRESSES ON MAINNET ~~~~~~~~~~~ 
  busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
  usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
  const usdcDecimals = await usdc.decimals();
  const parseUsdc = (amount) => parseUnits(amount, usdcDecimals);
  const parseExchangeLimit = (amount) => parseUnits(amount, 12);

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~ 
``
  CYCLE_DURATION = 1;
  MIN_USD_PER_CYCLE = parseUniform("0.01");
  MIN_DEPOSIT = parseUniform("0.0001");
  FEE_ADDRESS = "0xcAD3e8A8A2D3959a90674AdA99feADE204826202";
  FEE_PERCENT = 1000;
  INITIAL_DEPOSIT = parseUsdc("0.1");

  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~ 
  oracle = await deployProxy("ChainlinkOracle");
  console.log("ChainlinkOracle", oracle.address);

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
  exchange = await deployProxy("Exchange");
  console.log("Exchange", exchange.address);

  let acsPlugin = await deploy("CurvePlugin");
  console.log("acsPlugin", acsPlugin.address);
  let pancakePlugin = await deploy("UniswapPlugin");
  console.log("pancakePlugin", pancakePlugin.address);

  // ~~~~~~~~~~~ DEPLOY StrategyRouterLib ~~~~~~~~~~~ 
  const routerLib = await deploy("StrategyRouterLib");
  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
    libraries: {
      StrategyRouterLib: routerLib.address
    }
  });
  router = await upgrades.deployProxy(StrategyRouter, [], {
    kind: 'uups',
  });
  await router.deployed();
  console.log("StrategyRouter", router.address);
  // Deploy Batch
  let batch = await deployProxy("Batch");
  console.log("Batch", batch.address);
  // Deploy SharesToken
  let sharesToken = await deployProxy("SharesToken", [router.address]);
  console.log("SharesToken", sharesToken.address);
  // Deploy  ReceiptNFT
  let receiptContract = await deployProxy("ReceiptNFT", [router.address, batch.address]);
  console.log("ReceiptNFT", receiptContract.address);

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  console.log("Deploying strategies...");
  let StrategyFactory = await ethers.getContractFactory("BiswapBusdUsdt")
  strategyBusd = await upgrades.deployProxy(StrategyFactory, [owner.address], {
    kind: 'uups',
    constructorArgs: [router.address],
  });
  console.log("strategyBusd", strategyBusd.address);
  await (await strategyBusd.transferOwnership(router.address)).wait();


  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  StrategyFactory = await ethers.getContractFactory("BiswapUsdcUsdt")
  strategyUsdc = await upgrades.deployProxy(StrategyFactory, [owner.address], {
    kind: 'uups',
    constructorArgs: [router.address],
  });
  console.log("strategyUsdc", strategyUsdc.address);
  await (await strategyUsdc.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~ 
  console.log("oracle setup...");
  let oracleTokens = [busd.address, usdc.address];
  let priceFeeds = [hre.networkVariables.BusdUsdPriceFeed, hre.networkVariables.UsdcUsdPriceFeed];
  await (await oracle.setPriceFeeds(oracleTokens, priceFeeds)).wait();

  // pancake plugin params
  console.log("pancake plugin setup...");
  await (await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter)).wait();
  await (await pancakePlugin.setUseWeth(hre.networkVariables.bsw, hre.networkVariables.busd, true)).wait();
  await (await pancakePlugin.setUseWeth(hre.networkVariables.bsw, hre.networkVariables.usdt, true)).wait();
  await (await pancakePlugin.setUseWeth(hre.networkVariables.bsw, hre.networkVariables.usdc, true)).wait();

  // acryptos plugin params
  console.log("acryptos plugin setup...");
  await (await acsPlugin.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdt,
    hre.networkVariables.acs4usd.address
  )).wait();
  await (await acsPlugin.setCurvePool(
    hre.networkVariables.usdc,
    hre.networkVariables.usdt,
    hre.networkVariables.acs4usd.address
  )).wait();
  await (await acsPlugin.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdc,
    hre.networkVariables.acs4usd.address
  )).wait();
  await (await acsPlugin.setCoinIds(
    hre.networkVariables.acs4usd.address,
    hre.networkVariables.acs4usd.tokens,
    hre.networkVariables.acs4usd.coinIds
  )).wait();

  // setup Exchange routes
  console.log("exchange routes setup...");
  await (await exchange.setRouteEx(
    [
      hre.networkVariables.busd,
      hre.networkVariables.busd,
      hre.networkVariables.usdc,
      hre.networkVariables.bsw,
      hre.networkVariables.bsw,
      hre.networkVariables.bsw,
    ],
    [
      hre.networkVariables.usdt,
      hre.networkVariables.usdc,
      hre.networkVariables.usdt,
      hre.networkVariables.busd,
      hre.networkVariables.usdt,
      hre.networkVariables.usdc,
    ],
    [
      { defaultRoute: acsPlugin.address, limit: parseUnits("100000", 12), secondRoute: pancakePlugin.address },
      { defaultRoute: acsPlugin.address, limit: parseUnits("100000", 12), secondRoute: pancakePlugin.address },
      { defaultRoute: acsPlugin.address, limit: parseUnits("100000", 12), secondRoute: pancakePlugin.address },
      { defaultRoute: pancakePlugin.address, limit: 0, secondRoute: ethers.constants.AddressZero },
      { defaultRoute: pancakePlugin.address, limit: 0, secondRoute: ethers.constants.AddressZero  },
      { defaultRoute: pancakePlugin.address, limit: 0, secondRoute: ethers.constants.AddressZero  },
    ]
  )).wait();

  // setup Batch addresses
  console.log("Batch settings setup...");
  await (await batch.setAddresses(
    exchange.address,
    oracle.address,
    router.address,
    receiptContract.address
  )).wait();

  // setup StrategyRouter 
  console.log("StrategyRouter settings setup...");
  await (await router.setAddresses(
    exchange.address,
    oracle.address,
    sharesToken.address,
    batch.address,
    receiptContract.address
  )).wait();
  await (await router.setMinDepositUsd(MIN_DEPOSIT)).wait();
  await (await router.setAllocationWindowTime(CYCLE_DURATION)).wait();
  await (await router.setFeesPercent(FEE_PERCENT)).wait();
  await (await router.setFeesCollectionAddress(FEE_ADDRESS)).wait();

  console.log("Setting supported token...");
  const busdIdleStrategy = await deployProxyIdleStrategy(owner, router, busd);
  await (await router.setSupportedToken(busd.address, true, busdIdleStrategy.address)).wait();
  const usdcIdleStrategy = await deployProxyIdleStrategy(owner, router, usdc);
  await (await router.setSupportedToken(usdc.address, true, usdcIdleStrategy.address)).wait();

  console.log("Adding strategies...");
  await (await router.addStrategy(strategyBusd.address, busd.address, 5000)).wait();
  await (await router.addStrategy(strategyUsdc.address, usdc.address, 5000)).wait();


  console.log("Approving for initial deposit...");
  if ((await usdc.allowance(owner.address, router.address)).lt(INITIAL_DEPOSIT)) {
    await (await usdc.approve(router.address, INITIAL_DEPOSIT)).wait();
    console.log("usdc approved...");
  }

  try {
    console.log("Initial deposit to batch...");
    await (await router.depositToBatch(usdc.address, INITIAL_DEPOSIT)).wait();
  } catch (error) {
    console.error(error);
  }
  try {
    console.log("Initial deposit to strategies...");
    await (await router.allocateToStrategies()).wait();
  } catch (error) {
    console.error(error);
  }

  // vvvvvvvvvvvvvvvvvvvvvvvvv VERIFICATION vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  console.log("  - Verification will start in a minute...\n");
  await delay(46000);

  // verify router
  await safeVerify({
    address: router.address,
    libraries: {
      StrategyRouterLib: routerLib.address
    }
  });

  await safeVerifyMultiple([
    oracle,
    exchange,
    acsPlugin,
    pancakePlugin,
    receiptContract,
    batch,
    sharesToken,
    strategyBusd,
    strategyUsdc,
  ]);
}

// Helper function that won't exit script on error
async function safeVerify(verifyArgs) {
  try {
    await hre.run("verify:verify", verifyArgs);
  } catch (error) {
      console.error(error);
  }
}

async function safeVerifyMultiple(deployedContracts) {
  for (let i = 0; i < deployedContracts.length; i++) {
    try {
      const contract = deployedContracts[i];
      if (typeof contract === "string") {
        await safeVerify({
          address: contract,
          constructorArguments: [],
        });
      } else {
        await safeVerify({
          address: contract.address,
          constructorArguments: contract.constructorArgs,
        });
      }
    } catch (error) {
      console.error(error);
    }
  }
}

// Function caches deploy arguments at runtime of this script
async function setupVerificationHelper() {
  let oldDeploy = hre.ethers.ContractFactory.prototype.deploy;
  hre.ethers.ContractFactory.prototype.deploy = async function (...args) {
    let contract = await oldDeploy.call(this, ...args);
    contract.constructorArgs = args;
    return contract;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
