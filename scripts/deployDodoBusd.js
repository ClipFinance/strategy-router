const { parseUnits } = require("ethers/lib/utils");
const hre = require("hardhat");
const { ethers, upgrades } = require("hardhat");

// deploy dodo busd strategy script on mainnet

async function main() {
  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~

  const [owner] = await ethers.getSigners();

  await setupVerificationHelper();

  const DELAY = 20_000; // 20 sec
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  // ~~~~~~~~~~~ GET TOKENS ADDRESSES ON MAINNET ~~~~~~~~~~~
  const busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
//   const usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
  const usdt = await ethers.getContractAt("ERC20", hre.networkVariables.usdt);
//   const usdcDecimals = await usdc.decimals();
//   const usdtDecimals = await usdt.decimals();
  const busdDecimals = await busd.decimals();
//   const parseUsdc = (amount) => parseUnits(amount, usdcDecimals);
//   const parseUsdt = (amount) => parseUnits(amount, usdtDecimals);
  const parseBusd = (amount) => parseUnits(amount, busdDecimals);

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~\

  const STRATEGY_ROUTER = "0xc903f9Ad53675cD5f6440B32915abfa955B8CbF4";
  const BATCH = "0xCEE26C4C6f155408cb1c966AaFcd8966Ec60E80b";
  const EXCHANGE = "0xE6d68cdA34a38e40DEfbEDA69688036E5250681d";
  const PANCAKE_PLUGIN = "0x1974e981359a17e7508Af4B55D90fb61ECF880eF";

  const ADMIN = "0xA6981177F8232D363a740ed98CbBC753424F3B94";
  const admin = await ethers.getContractAt("RouterAdmin", ADMIN);

  // ~~~~~~~~~~~ DEPLOY DODO BUSD STRATEGY ~~~~~~~~~~~
  console.log(" ");
  console.log("Deploying Dodo Usdt Strategy...");

  let StrategyFactory = await ethers.getContractFactory("DodoBusd");
  const dodoBusd = await upgrades.deployProxy(
    StrategyFactory,
    [
      owner.address,
      parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      [
        STRATEGY_ROUTER,
        BATCH,
      ]
    ],
    {
      kind: "uups",
      constructorArgs: [STRATEGY_ROUTER],
      unsafeAllow: ['delegatecall'],
      initializer: 'initialize(address, uint256, uint16, address[])',
    }
  );
  await delay(DELAY);
  console.log("Deployed Dodo Busd Strategy address:", dodoBusd.address);

  console.log("Transfering ownership of Dodo Busd Strategy to Strategy Router...")
  await (await dodoBusd.transferOwnership(STRATEGY_ROUTER)).wait();
  await delay(DELAY);

  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~
  console.log(" ");
  console.log("Adding Dodo Usdt Strategy to Strategy Router...");
  await (await admin.addStrategy(dodoBusd.address, 7000)).wait();
  await delay(DELAY);

  // pancake plugin params
  console.log(" ");
  console.log("Setting up Pancake Plugin...");

  const pancakePlugin = await ethers.getContractAt("UniswapPlugin", PANCAKE_PLUGIN);

  const dodoAddress = hre.networkVariables.dodo;
  const wbnbAddress = hre.networkVariables.wbnb;

  console.log("Setting up WBNB as the mediator token for DODO/BUSD pair...");
  await (
    await pancakePlugin.setMediatorTokenForPair(
      wbnbAddress,
      [dodoAddress, busd.address]
    )
  ).wait();
  await delay(DELAY);

  // we don't set wbnb as mediator token for DODO/USDT pair
  console.log("Setting up WBNB as the mediator token for DODO/USDT pair... 'cause we forgot to set it in the main deploy script...");
  await (
    await pancakePlugin.setMediatorTokenForPair(
      wbnbAddress,
      [dodoAddress, usdt.address]
    )
  ).wait();
  await delay(DELAY);

  // setup Exchange routes
  console.log(" ");
  console.log("Setting up Exchange route for DODO/BUSD pair...");
  const exchange = await ethers.getContractAt("Exchange", EXCHANGE);

  await (await exchange.setRoute(
    [dodoAddress],[busd.address],
    [pancakePlugin.address]
  )).wait();
  await delay(DELAY);


  // verify dodo busd strategy contract
  console.log(" ");
  console.log("Don't forget about verifying the strategy contract...")
  await safeVerify({
    address: dodoBusd.address,
    constructorArguments: dodoBusd.constructorArgs,
  });

  console.log("Congratulation!!! You are successfully deployed and set up Dodo Busd Strategy!")

}

// Helper function that won't exit script on error
async function safeVerify(verifyArgs) {
  try {
    await hre.run("verify:verify", verifyArgs);
  } catch (error) {
    console.error(error);
  }
}

// Function caches deploy arguments at runtime of this script
async function setupVerificationHelper() {
  let oldDeploy = hre.ethers.ContractFactory.prototype.deploy;
  hre.ethers.ContractFactory.prototype.deploy = async function (...args) {
    let contract = await oldDeploy.call(this, ...args);
    contract.constructorArgs = args;
    return contract;
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });