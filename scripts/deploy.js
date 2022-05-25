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
  busd = await ethers.getContractAt("ERC20", "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56");
  usdc = await ethers.getContractAt("ERC20", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");

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

  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
  router = await StrategyRouter.deploy();
  await router.deployed();
  console.log("StrategyRouter", router.address);
  console.log("ReceiptNFT", await router.receiptContract());
  console.log("SharesToken", await router.sharesToken());

  await router.setMinUsdPerCycle(MIN_USD_PER_CYCLE);
  await router.setMinDeposit(MIN_DEPOSIT);
  await router.setCycleDuration(CYCLE_DURATION);
  await router.setExchange(exchange.address);
  await router.setFeePercent(FEE_PERCENT);
  await router.setFeeAddress(FEE_ADDRESS);
  await router.setOracle(oracle.address);

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  console.log("Deploying strategies...");
  strategyBusd = await ethers.getContractFactory("biswap_busd_usdt");
  strategyBusd = await strategyBusd.deploy(router.address);
  await strategyBusd.deployed();
  await strategyBusd.transferOwnership(router.address);
  console.log("strategyBusd", strategyBusd.address);


  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
  strategyUsdc = await ethers.getContractFactory("biswap_usdc_usdt");
  strategyUsdc = await strategyUsdc.deploy(router.address);
  await strategyUsdc.deployed();
  await strategyUsdc.transferOwnership(router.address);
  console.log("strategyUsdc", strategyUsdc.address);


  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~ 
  console.log("Setting supported stablecoin...");
  await router.setSupportedStablecoin(busd.address, true);
  await router.setSupportedStablecoin(usdc.address, true);

  console.log("Adding strategies...");
  await router.addStrategy(strategyBusd.address, busd.address, 5000);
  await router.addStrategy(strategyUsdc.address, usdc.address, 5000);


  console.log("Approving for initial deposit...");
  if((await usdc.allowance(owner.address, router.address)).lt(INITIAL_DEPOSIT)) {
    await usdc.approve(router.address, INITIAL_DEPOSIT);
    console.log("usdc approved...");
  }
  console.log("Initial deposit to batch...");
  await router.depositToBatch(usdc.address, INITIAL_DEPOSIT);
  console.log("Initial deposit to strategies...");
  await router.depositToStrategies();


  // vvvvvvvvvvvvvvvvvvvvvvvvv VERIFICATION vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  console.log("  - Verification will start in a minute...\n");
  // await delay(46000);


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
