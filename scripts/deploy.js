const { parseUnits } = require("ethers/lib/utils");
const hre = require("hardhat");
const { ethers } = require("hardhat");
const { deploy } = require("../test/utils");
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

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~ 

  CYCLE_DURATION = 1;
  MIN_USD_PER_CYCLE = parseUniform("0.01");
  MIN_DEPOSIT = parseUniform("0.0001");
  FEE_ADDRESS = "0xcAD3e8A8A2D3959a90674AdA99feADE204826202";
  FEE_PERCENT = 1000;
  INITIAL_DEPOSIT = parseUsdc("0.1");

  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~ 
  oracle = await deploy("ChainlinkOracle");
  console.log("ChainlinkOracle", oracle.address);

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
  exchange = await deploy("Exchange");
  console.log("Exchange", exchange.address);

  let acsPlugin = await deploy("CurvePlugin");
  console.log("acsPlugin", acsPlugin.address);
  let pancakePlugin = await deploy("UniswapPlugin");
  console.log("pancakePlugin", pancakePlugin.address);

  // pancake plugin params
  await pancakePlugin.setUseWeth(hre.networkVariables.bsw, hre.networkVariables.busd, true);
  await pancakePlugin.setUseWeth(hre.networkVariables.bsw, hre.networkVariables.usdt, true);
  await pancakePlugin.setUseWeth(hre.networkVariables.bsw, hre.networkVariables.usdc, true);

  await (await acsPlugin.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdt,
    hre.networkVariables.acryptosUst4Pool.address
  )).wait();
  await (await acsPlugin.setCurvePool(
    hre.networkVariables.usdc,
    hre.networkVariables.usdt,
    hre.networkVariables.acryptosUst4Pool.address
  )).wait();
  await (await acsPlugin.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdc,
    hre.networkVariables.acryptosUst4Pool.address
  )).wait();
  await (await pancakePlugin.setUniswapRouter(hre.networkVariables.uniswapRouter)).wait();
  await (await acsPlugin.setCoinIds(
    hre.networkVariables.acryptosUst4Pool.address,
    hre.networkVariables.acryptosUst4Pool.tokens,
    hre.networkVariables.acryptosUst4Pool.coinIds
  )).wait();
  await (await exchange.setPlugin(
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
      acsPlugin.address,
      acsPlugin.address,
      acsPlugin.address,
    ]
  )).wait();

  // ~~~~~~~~~~~ DEPLOY StrategyRouterLib ~~~~~~~~~~~ 
  const routerLib = await deploy("StrategyRouterLib");
  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
    libraries: {
      StrategyRouterLib: routerLib.address
    }
  });
  router = await StrategyRouter.deploy(exchange.address, oracle.address);
  router = await router.deployed();
  console.log("StrategyRouter", router.address);
  console.log("ReceiptNFT", await router.receiptContract());
  console.log("SharesToken", await router.sharesToken());

  await (await router.setMinUsdPerCycle(MIN_USD_PER_CYCLE)).wait();
  await (await router.setMinDeposit(MIN_DEPOSIT)).wait();
  await (await router.setCycleDuration(CYCLE_DURATION)).wait();
  await (await router.setExchange(exchange.address)).wait();
  await (await router.setFeePercent(FEE_PERCENT)).wait();
  await (await router.setFeeAddress(FEE_ADDRESS)).wait();
  await (await router.setOracle(oracle.address)).wait();

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  console.log("Deploying strategies...");
  strategyBusd = await deploy("BiswapBusdUsdt", router.address);
  console.log("strategyBusd", strategyBusd.address);
  await (await strategyBusd.transferOwnership(router.address)).wait();


  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  strategyUsdc = await deploy("BiswapUsdcUsdt", router.address);
  console.log("strategyUsdc", strategyUsdc.address);
  await (await strategyUsdc.transferOwnership(router.address)).wait();


  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~ 
  console.log("Setting supported token...");
  await (await router.setSupportedToken(busd.address, true)).wait();
  await (await router.setSupportedToken(usdc.address, true)).wait();

  console.log("Adding strategies...");
  await (await router.addStrategy(strategyBusd.address, busd.address, 5000)).wait();
  await (await router.addStrategy(strategyUsdc.address, usdc.address, 5000)).wait();


  console.log("Approving for initial deposit...");
  if ((await usdc.allowance(owner.address, router.address)).lt(INITIAL_DEPOSIT)) {
    await (await usdc.approve(router.address, INITIAL_DEPOSIT)).wait();
    console.log("usdc approved...");
  }
  console.log("Initial deposit to batch...");
  await (await router.depositToBatch(usdc.address, INITIAL_DEPOSIT)).wait();
  console.log("Initial deposit to strategies...");
  await (await router.depositToStrategies()).wait();


  // vvvvvvvvvvvvvvvvvvvvvvvvv VERIFICATION vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  console.log("  - Verification will start in a minute...\n");
  await delay(46000);

  let batchingAddress = await router.batching();
  let receiptNftAddress = await router.receiptContract();
  let sharesTokenAddress = await router.sharesToken();

  // verify router
  await safeVerify({
    address: router.address,
    constructorArguments: router.constructorArgs,
    libraries: {
      StrategyRouterLib: routerLib.address
    }
  });

  // verify receiptNFT
  await safeVerify({
    address: receiptNftAddress,
    constructorArguments: [router.address, batchingAddress],
  });

  // verify batching contract
  await safeVerify({
    address: batchingAddress,
    constructorArguments: [router.address],
  });

  // verify ShareToken contract
  await safeVerify({
    address: sharesTokenAddress,
    constructorArguments: [],
  });


  await verifyMultiple([
    exchange,
    strategyBusd,
    strategyUsdc,
    oracle
  ]);
}

// Helper function that won't exit script on error
async function safeVerify(verifyArgs) {
  try {
    await hre.run("verify:verify", verifyArgs);
  } catch (error) {
    await handleVerificationError(error);
  }
}

async function handleVerificationError(error) {
  // make common errors less verbose, and remove stacktrace
  if (error.message.startsWith("The selected network is")) {
    console.log("hardhat-etherscan warning: unsupported network.", hre.network.name, "\n");
  } else if (error.message.startsWith("Already verified")) {
    console.log(error.message, "\n");
  } else {
    console.log(error, "\n");
  }
}

async function verifyMultiple(deployedContracts) {
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
      await handleVerificationError(error);
    }
  }
}

// Function caches deploy arguments, so that we don't duplicate them manually
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
