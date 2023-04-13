const { parseUnits } = require("ethers/lib/utils");
const hre = require("hardhat");
const { ethers } = require("hardhat");
const { deploy, deployProxy, parseUniform, deployProxyIdleStrategy } = require("../test/utils");
const fs = require("fs");

// deploy script for testing on testnet
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

  CYCLE_DURATION = 3600;
  MIN_USD_PER_CYCLE = parseUniform("0.01");
  FEE_ADDRESS = "0xcAD3e8A8A2D3959a90674AdA99feADE204826202";
  FEE_PERCENT = 1000;
  INITIAL_DEPOSIT = parseUsdc("0.1");

  const depositFeeSettings = {
    minFeeInUsd: parseUniform("0.15"), // 0.15 USD
    maxFeeInUsd: parseUniform("1"), // 1 USD
    feeInBps: 1, // is 0.01% in BPS
  };

  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~
  oracle = await deployProxy("ChainlinkOracle");
  console.log("ChainlinkOracle", oracle.address);

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~
  exchange = await deployProxy("Exchange");
  console.log("Exchange", exchange.address);

  let pancakePlugin = await deploy("UniswapPlugin");
  console.log("pancakePlugin", pancakePlugin.address);

  // ~~~~~~~~~~~ DEPLOY StrategyRouterLib ~~~~~~~~~~~
  const routerLib = await deploy("StrategyRouterLib");
  console.log("routerLib", routerLib.address);

  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
    libraries: {
      StrategyRouterLib: routerLib.address
    }
  });
  router = await upgrades.deployProxy(StrategyRouter, [], {
    kind: 'uups',
    unsafeAllow: ['delegatecall'],
  });
  await router.deployed();
  console.log("StrategyRouter", router.address);
  // Deploy Batch
  let batch = await deployProxy("Batch", [], true);
  console.log("Batch", batch.address);
  // Deploy SharesToken
  let sharesToken = await deployProxy("SharesToken", [router.address]);
  console.log("SharesToken", sharesToken.address);
  // Deploy  ReceiptNFT
  let receiptContract = await deployProxy("ReceiptNFT", [router.address, batch.address]);
  console.log("ReceiptNFT", receiptContract.address);

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  console.log("Deploying strategies...");

  const mockStrategyFactory = await ethers.getContractFactory("MockStrategy");
  let mockStrategy = await mockStrategyFactory.deploy(usdc.address, 10000);
  await mockStrategy.deployed();
  console.log("strategy:", mockStrategy.address);
  await (await mockStrategy.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~
  console.log("oracle setup...");
  let oracleTokens = [busd.address, usdc.address];
  let priceFeeds = [
    hre.networkVariables.BusdUsdPriceFeed,
    hre.networkVariables.UsdcUsdPriceFeed,
  ];
  await (await oracle.setPriceFeeds(oracleTokens, priceFeeds)).wait();

  // pancake plugin params
  console.log("pancake plugin setup...");
  await (await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter)).wait();
  await (await pancakePlugin.setMediatorTokenForPair(
    hre.networkVariables.wbnb,
    [hre.networkVariables.busd, hre.networkVariables.usdc]
  )).wait();

  // setup Exchange routes
  console.log("exchange routes setup...");
  await (await exchange.setRouteEx(
    [
      hre.networkVariables.busd,

    ],
    [
      hre.networkVariables.usdc,

    ],
    [
      { defaultRoute: pancakePlugin.address, limit: 0, secondRoute: ethers.constants.AddressZero },
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
  await (await batch.setDepositFeeSettings(depositFeeSettings)).wait();

  // setup StrategyRouter
  console.log("StrategyRouter settings setup...");
  await (await router.setAddresses(
    exchange.address,
    oracle.address,
    sharesToken.address,
    batch.address,
    receiptContract.address
  )).wait();
  await (await router.setAllocationWindowTime(CYCLE_DURATION)).wait();
  await (await router.setFeesPercent(FEE_PERCENT)).wait();
  await (await router.setFeesCollectionAddress(FEE_ADDRESS)).wait();

  console.log("Setting supported token...");
  const busdIdleStrategy = await deployProxyIdleStrategy(owner, router, busd);
  await (await router.setSupportedToken(busd.address, true, busdIdleStrategy.address)).wait();
  const usdcIdleStrategy = await deployProxyIdleStrategy(owner, router, usdc);
  await (await router.setSupportedToken(usdc.address, true, usdcIdleStrategy.address)).wait();

  console.log("Adding strategies...");
  await (await router.addStrategy(mockStrategy.address, 10000)).wait();

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
    pancakePlugin,
    receiptContract,
    batch,
    sharesToken,
    mockStrategy
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
