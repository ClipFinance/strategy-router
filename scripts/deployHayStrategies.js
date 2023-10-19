const hre = require("hardhat");
const { ethers, upgrades } = require("hardhat");

const { parseUnits } = require("ethers/lib/utils");
const {
  deploy,
  deployProxy,
  deployProxyIdleStrategy,
} = require("../test/utils");

// deploy thena hay strategy script on mainnet

async function main() {
  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~

  const [owner] = await ethers.getSigners();

  await setupVerificationHelper();

  const DELAY = 20_000; // 20 sec
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  // ~~~~~~~~~~~ GET TOKENS ADDRESSES ON MAINNET ~~~~~~~~~~~
  const busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
  const usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
  const usdt = await ethers.getContractAt("ERC20", hre.networkVariables.usdt);
  const hay = await ethers.getContractAt("ERC20", hre.networkVariables.hay);
  // const usdcDecimals = await usdc.decimals();
  // const usdtDecimals = await usdt.decimals();
  // const busdDecimals = await busd.decimals();
  const hayDecimals = await hay.decimals();
  // const parseUsdc = (amount) => parseUnits(amount, usdcDecimals);
  // const parseUsdt = (amount) => parseUnits(amount, usdtDecimals);
  // const parseBusd = (amount) => parseUnits(amount, busdDecimals);
  const parseHay = (amount) => parseUnits(amount, hayDecimals);

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~\

  const STRATEGY_ROUTER = "0xc903f9Ad53675cD5f6440B32915abfa955B8CbF4";
  const BATCH = "0xCEE26C4C6f155408cb1c966AaFcd8966Ec60E80b";
  const SHARES_TOKEN = "0xf42b35d37eC8bfC26173CD66765dd5B84CCB03E3";
  const RECEIPT_CONTRACT = "0xa9AA2EdF9e11E72e1100eBBb4A7FE647C12B55Ab";
  // const EXCHANGE = "0xE6d68cdA34a38e40DEfbEDA69688036E5250681d"; // will deploy new one
  const ORACLE = "0x8482807e1cae22e6EF248c0B2B6A02B8d581f537";
  const PANCAKE_V3_PLUGIN = "0x6025712051Bb2067686C291d3266DD92b824dDd3";
  const PANCAKE_V2_PLUGIN = "0x1974e981359a17e7508Af4B55D90fb61ECF880eF";
  const router = await ethers.getContractAt("StrategyRouter", STRATEGY_ROUTER);
  const batch = await ethers.getContractAt("Batch", BATCH);
  const oracle = await ethers.getContractAt("ChainlinkOracle", ORACLE);

  const ADMIN = "0xA6981177F8232D363a740ed98CbBC753424F3B94";
  const admin = await ethers.getContractAt("RouterAdmin", ADMIN);

  const bswAddress = hre.networkVariables.bsw;
  const stgAddress = hre.networkVariables.stg;
  const dodoAddress = hre.networkVariables.dodo;
  const theAddress = hre.networkVariables.the;

  // ~~~~~~~~~~~ DEPLOY THENA HAY STRATEGY ~~~~~~~~~~~
  console.log(" ");
  console.log("Deploying Thena Hay Strategy...");

  let StrategyFactory = await ethers.getContractFactory("ThenaHay");
  const priceManipulationPercentThresholdInBps = 300; // 3%
  const thenaHay = await upgrades.deployProxy(
    StrategyFactory,
    [
      owner.address,
      parseHay((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      [
        STRATEGY_ROUTER,
        BATCH,
      ]
    ],
    {
      kind: "uups",
      constructorArgs: [STRATEGY_ROUTER, ORACLE, priceManipulationPercentThresholdInBps],
      unsafeAllow: ['delegatecall'],
      initializer: 'initialize(address, uint256, uint16, address[])',
    }
  );
  await delay(DELAY);
  console.log("Deployed Thena Hay Strategy address:", thenaHay.address);

  console.log("Transfering ownership of Thena Hay Strategy to Strategy Router...")
  await (await thenaHay.transferOwnership(STRATEGY_ROUTER)).wait();
  await delay(DELAY);

  // ~~~~~~~~~~~ DEPLOY BISWAP HAY STRATEGY ~~~~~~~~~~~
  console.log(" ");
  console.log("Deploying Biswap Hay Strategy...");

  StrategyFactory = await ethers.getContractFactory("BiswapHayUsdt");
  const biswapHayUsdt = await upgrades.deployProxy(
    StrategyFactory,
    [
      owner.address,
      parseHay((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      [
        STRATEGY_ROUTER,
        BATCH,
      ]
    ],
    {
      kind: "uups",
      constructorArgs: [STRATEGY_ROUTER, ORACLE, priceManipulationPercentThresholdInBps],
      unsafeAllow: ['delegatecall'],
      initializer: 'initialize(address, uint256, uint16, address[])',
    }
  );
  await delay(DELAY);
  console.log("Deployed Biswap Hay Strategy address:", biswapHayUsdt.address);

  console.log("Transfering ownership of Biswap Hay Strategy to Strategy Router...")
  await (await biswapHayUsdt.transferOwnership(STRATEGY_ROUTER)).wait();
  await delay(DELAY);

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~

  console.log(" ");
  console.log("Deploing new Exchange contract and update it on strategy router...");

  const exchange = await deployProxy("Exchange");
  console.log("Exchange", exchange.address);

  await delay(DELAY);

  // setup Batch and Router addresses to update exchange address
  console.log("Updating exchange address on Batch...");
  await (
    await batch.setAddresses(
      exchange.address,
      oracle.address,
      router.address,
      RECEIPT_CONTRACT
    )
  ).wait();
  await delay(DELAY);

  console.log("Updating exchange address on Strategy Router...");
  await (
    await admin.setAddresses(
      exchange.address,
      oracle.address,
      SHARES_TOKEN,
      batch.address,
      RECEIPT_CONTRACT
    )
  ).wait();
  await delay(DELAY);

  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~

  console.log(" ");
  console.log("Setting up Price feeds for HAY and BSW tokens...");

  await oracle.setPriceFeeds(
    [hay.address, bswAddress],
    [hre.networkVariables.HayUsdPriceFeed, hre.networkVariables.BswUsdPriceFeed]);
  await delay(DELAY);

  console.log(" ");
  console.log("Deploing new Idle Strategies for supported tokens...");
  const busdIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, busd);
  const usdcIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, usdc);
  const usdtIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, usdt);

  const newIdleStrategies = {
    [busd.address]: {
      address: busdIdleStrategy.address,
      symbol: "BUSD",
    },
    [usdc.address]: {
      address: usdcIdleStrategy.address,
      symbol: "USDC",
    },
    [usdt.address]: {
      address: usdtIdleStrategy.address,
      symbol: "USDT",
    },
  }

  const idleStrategiesData = await router.getIdleStrategies();

  await Promise.all(idleStrategiesData.map(async (idleStrategyData, strategyIndex) => {
    const { strategyAddress: oldStrategyAddress, depositToken } = idleStrategyData;

    await (
      await admin.setIdleStrategy(strategyIndex, newIdleStrategies[depositToken].address)
    ).wait();

    console.log(`Idle Strategy for ${newIdleStrategies[depositToken].symbol} updated from ${oldStrategyAddress} to ${newIdleStrategies[depositToken].address}`);

  }));

  await delay(DELAY);

  console.log(" ");
  console.log("Deploing new Hay Idle Strategy and adding HAY as supported token...");

  const hayIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, hay);
  console.log("Deployed Hay Idle Strategy: ", hayIdleStrategy.address);
  await (
    await admin.setSupportedToken(hay.address, true, hayIdleStrategy.address)
  ).wait();

  console.log(" ");
  console.log("Adding Thena Hay Strategy to Strategy Router...");
  await (await admin.addStrategy(thenaHay.address, 10000)).wait(); // TODO change strategy weight to real value on production deploy
  await delay(DELAY);

  console.log(" ");
  console.log("Adding Biswap Hay Strategy to Strategy Router...");
  await (await admin.addStrategy(biswapHayUsdt.address, 10000)).wait();
  await delay(DELAY);

  // wombat plugin params
  console.log(" ");
  console.log("Deploing Wombat Plugin and setting up its params...");
  const wombatPlugin = await deploy(
    "WombatPlugin",
    hre.networkVariables.wombatRouter
  );
  console.log("Wombat Plugin: ", wombatPlugin.address);
  await delay(DELAY);

  console.log("Setting up USDC as the mediator token for HAY/BUSD pair...");
  await (
    await wombatPlugin.setMediatorTokenForPair(
      usdc.address,
      [hay.address, busd.address]
    )
  ).wait();
  await delay(DELAY);

  console.log("Setting up Hay Pool as the pool for HAY/USDC pair...");
  await(
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatHayPool,
      [hay.address, usdc.address]
    )
  ).wait();
  await delay(DELAY);
  console.log("Setting up Main Pool as the pool for USDC/BUSD pair...");
  await(
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatMainPool,
      [usdc.address, busd.address]
    )
  ).wait();
  await delay(DELAY);
  console.log("Setting up Main Pool as the pool for HAY/USDT pair...");
  await(
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatHayPool,
      [hay.address, usdt.address]
    )
  ).wait();
  await delay(DELAY);
  console.log("Setting up Main Pool as the pool for BUSD/USDT pair...");
  await(
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatMainPool,
      [busd.address, usdt.address]
    )
  ).wait();
  await delay(DELAY);
  console.log("Setting up Main Pool as the pool for USDC/USDT pair...");
  await(
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatMainPool,
      [usdc.address, usdt.address]
    )
  ).wait();
  await delay(DELAY);

  // biswap plugin params
  console.log(" ");
  console.log("Deploing Biswap Plugin and setting up its params...");
  const biSwapPlugin = await deploy(
    "UniswapPlugin",
    hre.networkVariables.biswapRouter
  );
  console.log("BiSwapPlugin Plugin: ", biSwapPlugin.address);
  await delay(DELAY);

  console.log("Setting up USDT as the mediator token for BSW/HAY pair...");
  await (
    await biSwapPlugin.setMediatorTokenForPair(
      usdt.address,
      [bswAddress, hay.address]
    )
  ).wait();
  await delay(DELAY);

  // thena algebra plugin params
  console.log(" ");
  console.log("Deploing Thena Algebra Plugin and setting up its params...");
  const thenaAlgebraPlugin = await deploy(
    "AlgebraPlugin",
    hre.networkVariables.thenaAlgebraRouter,
    hre.networkVariables.thenaAlgebraFactory
  );
  console.log("ThenaAlgebra Plugin: ", thenaAlgebraPlugin.address);
  await delay(DELAY);

  console.log("Setting up USDT as the mediator token for THE/HAY and THE/USDC pair...");
  await (
    await thenaAlgebraPlugin.setMediatorTokenForPair(
      usdt.address,
      [theAddress, hay.address]
    )
  ).wait();
  await (
    await thenaAlgebraPlugin.setMediatorTokenForPair(
      usdt.address,
      [theAddress, usdc.address]
    )
  ).wait();

  await delay(DELAY);

  // setup Exchange params
  console.log(" ");
  console.log("Setting up MaxStablecoinSlippageInBps Exchange routes...");
  await (
    await exchange.setMaxStablecoinSlippageInBps(50) // 0.5%
  ).wait();

  console.log(" ");
  console.log("Setting up Exchange routes...");

  await (await exchange.setRoute(
    [
      // stable coins
      busd.address,
      busd.address,
      usdc.address,

      // hay pairs
      hay.address,
      hay.address,
      hay.address,

      // bsw pairs
      bswAddress,
      bswAddress,
      bswAddress,
      bswAddress,

      // stg pairs
      stgAddress,
      stgAddress,

      // dodo pairs
      dodoAddress,
      dodoAddress,

      // thena pairs
      theAddress,
      theAddress,
      theAddress,

    ],
    [
      // stable coins
      usdt.address,
      usdc.address,
      usdt.address,

      // hay pairs
      usdc.address,
      usdt.address,
      busd.address,

      // bsw pairs
      busd.address,
      usdt.address,
      usdc.address,
      hay.address,

      // stg pairs
      usdt.address,
      busd.address,

      // dodo pairs
      usdt.address,
      busd.address,

      // the pairs
      usdt.address,
      usdc.address,
      hay.address,

    ],
    [
      // stable coins
      PANCAKE_V3_PLUGIN,
      PANCAKE_V3_PLUGIN,
      PANCAKE_V3_PLUGIN,

      // hay pairs
      wombatPlugin.address,
      wombatPlugin.address,
      wombatPlugin.address,

      // bsw pairs
      PANCAKE_V2_PLUGIN,
      PANCAKE_V2_PLUGIN,
      PANCAKE_V2_PLUGIN,
      biSwapPlugin.address,

      // stg pairs
      PANCAKE_V2_PLUGIN,
      PANCAKE_V2_PLUGIN,

      // dodo pairs
      PANCAKE_V2_PLUGIN,
      PANCAKE_V2_PLUGIN,

      // the pairs
      thenaAlgebraPlugin.address,
      thenaAlgebraPlugin.address,
      thenaAlgebraPlugin.address,

    ]
  )).wait();
  await delay(DELAY);

  // verify deployed contracts
  console.log(" ");
  console.log("Don't forget about verifying deployed contracts...")
  await safeVerifyMultiple([
    thenaHay,
    biswapHayUsdt,

    busdIdleStrategy,
    usdcIdleStrategy,
    usdtIdleStrategy,
    hayIdleStrategy,

    exchange,
    wombatPlugin,
    biSwapPlugin,
    thenaAlgebraPlugin,
  ]);

  console.log("Congratulation!!! You are successfully deployed and set up Thena Hay and Biswap Hay Strategies!")

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