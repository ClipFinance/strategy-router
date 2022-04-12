const hre = require("hardhat");
const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, skipCycleTime, printStruct, logFarmLPs, BLOCKS_MONTH, skipBlocks, BLOCKS_DAY } = require("../test/utils");


// deploy script for testing on mainnet

async function main() {

  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 

  // save deployment args in runtime, to simplify verification in deploy.js
  // for some reason this snippet breaks gas-reporter, so need to find a better way to do it
  let oldDeploy = hre.ethers.ContractFactory.prototype.deploy;
  hre.ethers.ContractFactory.prototype.deploy = async function (...args) {
    let contract = await oldDeploy.call(this, ...args);
    contract.constructorArgs = args;
    return contract;
  }
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  provider = ethers.provider;
  parseUsdc = (args) => parseUnits(args, 18);
  parseUst = (args) => parseUnits(args, 18);
  parseUniform = (args) => parseUnits(args, 18);

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

  CYCLE_DURATION = 1;
  MIN_USD_PER_CYCLE = parseUniform("0.01");

  // ~~~~~~~~~~~ GET UST ADDRESS ON MAINNET ~~~~~~~~~~~ 
  UST = "0x23396cf899ca06c4472205fc903bdb4de249d6fc";
  ust = await ethers.getContractAt("ERC20", UST);

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
  exchange = await ethers.getContractFactory("Exchange");
  exchange = await exchange.deploy();
  await exchange.deployed();
  console.log("Exchange", exchange.address);

  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
  router = await StrategyRouter.deploy();
  await router.deployed();
  console.log("router", router.address);
  console.log("ReceiptNFT", await router.receiptContract());
  console.log("SharesToken", await router.sharesToken());

  await router.setMinUsdPerCycle(MIN_USD_PER_CYCLE);
  await router.setCycleDuration(CYCLE_DURATION);
  await router.setExchange(exchange.address);

  // ~~~~~~~~~~~ DEPLOY Acryptos UST strategy ~~~~~~~~~~~ 
  strategyAcryptos = await ethers.getContractFactory("acryptos_ust");
  strategyAcryptos = await strategyAcryptos.deploy(router.address);
  await strategyAcryptos.deployed();
  await strategyAcryptos.transferOwnership(router.address);
  console.log("strategyAcryptos", strategyAcryptos.address);


  // ~~~~~~~~~~~ DEPLOY Biswap ust-busd strategy ~~~~~~~~~~~ 
  strategyBiswap = await ethers.getContractFactory("biswap_ust_busd");
  strategyBiswap = await strategyBiswap.deploy(router.address);
  await strategyBiswap.deployed();
  await strategyBiswap.transferOwnership(router.address);
  console.log("strategyBiswap", strategyBiswap.address);


  await router.setSupportedStablecoin(ust.address, true);

  await router.addStrategy(strategyAcryptos.address, ust.address, 5000);
  await router.addStrategy(strategyBiswap.address, ust.address, 5000);


  // admin initial deposit seems to be fix for a problem, 
  // if you deposit and withdraw multiple times (without initial deposit)
  // then pps and shares become broken (they increasing because of dust always left on farms)
  await ust.approve(router.address, parseUst("1"));
  await router.depositToBatch(ust.address, parseUst("0.1"));
  await router.depositToStrategies();


  // vvvvvvvvvvvvvvvvvvvvvvvvv VERIFICATION vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  console.log("  - Verification will start in a minute...\n");
  await delay(46000);


  let deployedContracts = [
    exchange,
    router,
    // these two deployed by StrategyRouter and they don't have constructor args
    // thus we can use their address with args set to [] for verification
    await router.receiptContract(),
    await router.sharesToken(),
    strategyAcryptos,
    strategyBiswap
  ];

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

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
