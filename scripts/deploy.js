const hre = require("hardhat");
const { ethers, waffle } = require("hardhat");
const { parseUsdc } = require("../test/utils/utils");

// deploy script for testing on mainnet
// to test on hardhat network:
//   remove block pinning from config and uncomment 'accounts'
//   in .env set account with bnb and at least INITIAL_DEPOSIT usdc

async function main() {

  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 

  [owner] = await ethers.getSigners();

  await setupVerificationHelper();

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  provider = ethers.provider;

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

  CYCLE_DURATION = 1;
  MIN_USD_PER_CYCLE = parseUniform("0.01");
  MIN_DEPOSIT = parseUniform("0.0001");
  FEE_ADDRESS = "0xcAD3e8A8A2D3959a90674AdA99feADE204826202";
  FEE_PERCENT = 1000;
  INITIAL_DEPOSIT = parseUsdc("0.1");

  // ~~~~~~~~~~~ GET TOKENS ADDRESSES ON MAINNET ~~~~~~~~~~~ 
  busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
  usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);

  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~ 
  oracle = await ethers.getContractFactory("ChainlinkOracle");
  oracle = await oracle.deploy();
  await oracle.deployed();
  console.log("ChainlinkOracle", oracle.address);

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
  exchange = await ethers.getContractFactory("Exchange");
  exchange = await exchange.deploy();
  await exchange.deployed();
  console.log("Exchange", exchange.address);
  await (await exchange.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdt,
    hre.networkVariables.acryptosUst4Pool.address
  )).wait();
  await (await exchange.setCurvePool(
    hre.networkVariables.usdc,
    hre.networkVariables.usdt,
    hre.networkVariables.acryptosUst4Pool.address
  )).wait();
  await (await exchange.setCurvePool(
    hre.networkVariables.busd,
    hre.networkVariables.usdc,
    hre.networkVariables.acryptosUst4Pool.address
  )).wait();
  await (await exchange.setUniswapRouter(hre.networkVariables.uniswapRouter)).wait();
  await (await exchange.setCoinIds(
    hre.networkVariables.acryptosUst4Pool.address,
    hre.networkVariables.acryptosUst4Pool.tokens,
    hre.networkVariables.acryptosUst4Pool.coinIds
  )).wait();
  await (await exchange.setDexType(
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
  )).wait();

  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
  router = await StrategyRouter.deploy();
  await router.deployed();
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
  strategyBusd = await ethers.getContractFactory("BiswapBusdUsdt");
  strategyBusd = await strategyBusd.deploy(router.address);
  await strategyBusd.deployed();
  console.log("strategyBusd", strategyBusd.address);
  await (await strategyBusd.transferOwnership(router.address)).wait();


  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  strategyUsdc = await ethers.getContractFactory("BiswapUsdcUsdt");
  strategyUsdc = await strategyUsdc.deploy(router.address);
  await strategyUsdc.deployed();
  console.log("strategyUsdc", strategyUsdc.address);
  await (await strategyUsdc.transferOwnership(router.address)).wait();


  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~ 
  console.log("Setting supported stablecoin...");
  await (await router.setSupportedStablecoin(busd.address, true)).wait();
  await (await router.setSupportedStablecoin(usdc.address, true)).wait();

  console.log("Adding strategies...");
  await (await router.addStrategy(strategyBusd.address, busd.address, 5000)).wait();
  await (await router.addStrategy(strategyUsdc.address, usdc.address, 5000)).wait();


  console.log("Approving for initial deposit...");
  if((await usdc.allowance(owner.address, router.address)).lt(INITIAL_DEPOSIT)) {
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


  let deployedContracts = [
    exchange,
    router,
    // these two deployed by StrategyRouter and they don't have constructor args
    // thus we can use their address with args set to [] for verification
    await router.receiptContract(),
    await router.batching(),
    await router.sharesToken(),
    strategyBusd,
    strategyUsdc,
    oracle
  ];

  await verify(deployedContracts);
}

async function verify(deployedContracts) {
  for (let i = 0; i < deployedContracts.length; i++) {
    try {
      const contract = deployedContracts[i];
      if(typeof contract === "string") {
        await hre.run("verify:verify", {
          address: contract,
          constructorArguments: [],
        });
      } else {
        await hre.run("verify:verify", {
          address: contract.address,
          constructorArguments: contract.constructorArgs,
        });
      }
    } catch (error) {
      console.log(error)
    }
  }
}

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
