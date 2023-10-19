const { parseUnits } = require("ethers/lib/utils");
const hre = require("hardhat");
const { ethers, upgrades } = require("hardhat");
const {
  deploy,
  deployProxy,
  parseUniform,
  deployProxyIdleStrategy,
  toUniform,
} = require("../test/utils");
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
  const busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
  const usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
  const usdt = await ethers.getContractAt("ERC20", hre.networkVariables.usdt);
  const hay = await ethers.getContractAt("ERC20", hre.networkVariables.hay);
  const usdcDecimals = await usdc.decimals();
  const usdtDecimals = await usdt.decimals();
  // const busdDecimals = await busd.decimals();
  // const hayDecimals = await hay.decimals();
  const parseUsdc = (amount) => parseUnits(amount, usdcDecimals);
  const parseUsdt = (amount) => parseUnits(amount, usdtDecimals);
  // const parseBusd = (amount) => parseUnits(amount, busdDecimals);
  // const parseHay = (amount) => parseUnits(amount, hayDecimals);

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~\

  const CYCLE_DURATION = 1;
  const INITIAL_DEPOSIT = parseUsdc("1");
  const MAX_EXCHANGE_SLIPPAGE = 500;
  const RECEIPT_NFT_URI = "https://www.clip.finance/";
  const depositFeeSettings = {
    minFeeInUsd: parseUniform("0.15"), // 0.15 USD
    maxFeeInUsd: parseUniform("1"), // 1 USD
    feeInBps: 1, // is 0.01% in BPS
  };

  // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~

  const oracle = await deployProxy("ChainlinkOracle");
  console.log("ChainlinkOracle", oracle.address);
  const priceManipulationPercentThresholdInBps = 2000;

  // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~

  const exchange = await deployProxy("Exchange");
  console.log("Exchange", exchange.address);

  // let acsPlugin = await deploy("CurvePlugin");
  // console.log("acsPlugin", acsPlugin.address);
  const pancakeV3Plugin = await deploy(
    "UniswapV3Plugin",
    hre.networkVariables.uniswapV3Router
  );
  console.log("pancakeV3Plugin", pancakeV3Plugin.address);

  const pancakePlugin = await deploy(
    "UniswapPlugin",
    hre.networkVariables.uniswapRouter
  );
  console.log("pancakePlugin", pancakePlugin.address);

  // ~~~~~~~~~~~ DEPLOY StrategyRouterLib ~~~~~~~~~~~
  const routerLib = await deploy("StrategyRouterLib");
  // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
    libraries: {
      StrategyRouterLib: routerLib.address,
    },
  });
  const router = await upgrades.deployProxy(StrategyRouter, [], {
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  });
  await router.deployed();
  console.log("StrategyRouter", router.address);
  // Deploy Admin
  const admin = await deploy("RouterAdmin", router.address);
  console.log("RouterAdmin", admin.address);
  // Deploy Batch Out
  const batchOut = await deployProxy("BatchOut", [], true);
  // Deploy Batch
  const batch = await deployProxy("Batch", [], true);
  console.log("Batch", batch.address);
  // Deploy SharesToken
  const sharesToken = await deployProxy("SharesToken", [
    router.address,
    batchOut.address,
  ]);
  console.log("SharesToken", sharesToken.address);
  // Deploy  ReceiptNFT
  const receiptContract = await deployProxy("ReceiptNFT", [
    router.address,
    batch.address,
    RECEIPT_NFT_URI,
    false,
  ]);
  console.log("ReceiptNFT", receiptContract.address);

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  // console.log("Deploying strategies...");
  // let StrategyFactory = await ethers.getContractFactory("BiswapBusdUsdt");
  // strategyBusd = await upgrades.deployProxy(
  //   StrategyFactory,
  //   [
  //     owner.address,
  //     parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [
  //       router.address,
  //       batch.address,
  //     ]
  //   ],
  //   {
  //     kind: "uups",
  //     constructorArgs: [router.address, oracle.address, priceManipulationPercentThresholdInBps],
  //     initializer: 'initialize(address, uint256, uint16, address[])',
  //   }
  // );
  // console.log("strategyBusd", strategyBusd.address);
  // await (await strategyBusd.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  // StrategyFactory = await ethers.getContractFactory("BiswapUsdcUsdt");
  // strategyUsdc = await upgrades.deployProxy(
  //   StrategyFactory,
  //   [
  //     owner.address,
  //     parseUsdc((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [
  //       router.address,
  //       batch.address,
  //     ]
  //   ],
  //   {
  //     kind: "uups",
  //     constructorArgs: [router.address, oracle.address, priceManipulationPercentThresholdInBps],
  //     initializer: 'initialize(address, uint256, uint16, address[])',
  //   }
  // );
  // console.log("strategyUsdc", strategyUsdc.address);
  // await (await strategyUsdc.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  let StrategyFactory = await ethers.getContractFactory("DodoUsdt");
  const dodoUsdt = await upgrades.deployProxy(
    StrategyFactory,
    [
      owner.address,
      parseUsdt((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      [router.address, batch.address],
    ],
    {
      kind: "uups",
      constructorArgs: [router.address],
      unsafeAllow: ["delegatecall"],
      initializer: "initialize(address, uint256, uint16, address[])",
    }
  );
  console.log("dodoUsdt", dodoUsdt.address);
  await (await dodoUsdt.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  StrategyFactory = await ethers.getContractFactory("DodoBusd");
  const dodoBusd = await upgrades.deployProxy(
    StrategyFactory,
    [
      owner.address,
      parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      [router.address, batch.address],
    ],
    {
      kind: "uups",
      constructorArgs: [router.address],
      unsafeAllow: ["delegatecall"],
      initializer: "initialize(address, uint256, uint16, address[])",
    }
  );

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  StrategyFactory = await ethers.getContractFactory("StargateUsdt");
  const stargateUsdtStrategy = await upgrades.deployProxy(
    StrategyFactory,
    [
      owner.address,
      parseUsdt((1_000_000).toString()), // TODO change to real value on production deploy
      500, // 5%
      [router.address, batch.address],
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [router.address],
      initializer: "initialize(address, uint256, uint16, address[])",
    }
  );
  console.log("stargateUsdtStrategy", stargateUsdtStrategy.address);
  await (await stargateUsdtStrategy.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  // StrategyFactory = await ethers.getContractFactory("StargateBusd");
  // stargateBusdStrategy = await upgrades.deployProxy(
  //   StrategyFactory,
  //   [
  //     owner.address,
  //     parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [
  //       router.address,
  //       batch.address,
  //     ]
  //   ],
  //   {
  //     kind: "uups",
  //     unsafeAllow: ["delegatecall"],
  //     constructorArgs: [router.address],
  //     initializer: 'initialize(address, uint256, uint16, address[])',
  //   }
  // );
  // console.log("stargateBusdStrategy", stargateBusdStrategy.address);
  // await (await stargateBusdStrategy.transferOwnership(router.address)).wait();

  // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  // StrategyFactory = await ethers.getContractFactory("ThenaUsdt")
  // thenaUsdtStrategy = await upgrades.deployProxy(
  //   StrategyFactory,
  //   [
  //     owner.address,
  //     parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //   ],
  //   {
  //     kind: 'uups',
  //     unsafeAllow: ['delegatecall'],
  //     constructorArgs: [router.address, oracle.address],
  //     initializer: 'initialize(address, uint256, uint16)',
  //   }
  // );
  // console.log("thenaUsdtStrategy", thenaUsdtStrategy.address);
  // await (await thenaUsdtStrategy.transferOwnership(router.address)).wait();

  // // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~
  // StrategyFactory = await ethers.getContractFactory("ThenaUsdc")
  // thenaUsdcStrategy = await upgrades.deployProxy(
  //   StrategyFactory,
  //   [
  //     owner.address,
  //     parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //   ],
  //   {
  //     kind: 'uups',
  //     unsafeAllow: ['delegatecall'],
  //     constructorArgs: [router.address, oracle.address],
  //     initializer: 'initialize(address, uint256, uint16)',
  //   }
  // );
  // console.log("thenaUsdcStrategy", thenaUsdcStrategy.address);
  // await (await thenaUsdcStrategy.transferOwnership(router.address)).wait()

  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~
  console.log("oracle setup...");
  const oracleTokens = [
    busd.address,
    usdc.address,
    usdt.address,
    hay.address,
    hre.networkVariables.bsw,
    hre.networkVariables.wbnb,
  ];
  const priceFeeds = [
    hre.networkVariables.BusdUsdPriceFeed,
    hre.networkVariables.UsdcUsdPriceFeed,
    hre.networkVariables.UsdtUsdPriceFeed,
    hre.networkVariables.HayUsdPriceFeed, // oracle should be whitelisted
    hre.networkVariables.BswUsdPriceFeed,
    hre.networkVariables.BnbUsdPriceFeed,
  ];
  await (await oracle.setPriceFeeds(oracleTokens, priceFeeds)).wait();

  // pancake v3 plugin params
  console.log("pancake v3 plugin setup...");
  await (
    await pancakeV3Plugin.setSingleHopPairData(100, [
      busd.address,
      usdt.address,
    ])
  ).wait();
  await (
    await pancakeV3Plugin.setSingleHopPairData(100, [
      busd.address,
      usdc.address,
    ])
  ).wait();
  await (
    await pancakeV3Plugin.setSingleHopPairData(100, [
      usdc.address,
      usdt.address,
    ])
  ).wait();

  // pancake plugin params
  console.log("pancake plugin setup...");

  const wbnbAddress = hre.networkVariables.wbnb;
  const bswAddress = hre.networkVariables.bsw;
  const stgAddress = hre.networkVariables.stg;
  const dodoAddress = hre.networkVariables.dodo;
  const theAddress = hre.networkVariables.the;
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      dodoAddress,
      usdt.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      dodoAddress,
      busd.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      bswAddress,
      busd.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      bswAddress,
      usdt.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      bswAddress,
      usdc.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(busd.address, [
      stgAddress,
      usdt.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      theAddress,
      usdt.address,
    ])
  ).wait();
  await (
    await pancakePlugin.setMediatorTokenForPair(wbnbAddress, [
      theAddress,
      usdc.address,
    ])
  ).wait();

  // acryptos plugin params
  // console.log("acryptos plugin setup...");
  // await (await acsPlugin.setCurvePool(
  //   hre.networkVariables.busd,
  //   hre.networkVariables.usdt,
  //   hre.networkVariables.acs4usd.address
  // )).wait();
  // await (await acsPlugin.setCurvePool(
  //   hre.networkVariables.usdc,
  //   hre.networkVariables.usdt,
  //   hre.networkVariables.acs4usd.address
  // )).wait();
  // await (await acsPlugin.setCurvePool(
  //   hre.networkVariables.busd,
  //   hre.networkVariables.usdc,
  //   hre.networkVariables.acs4usd.address
  // )).wait();
  // await (await acsPlugin.setCoinIds(
  //   hre.networkVariables.acs4usd.address,
  //   hre.networkVariables.acs4usd.tokens,
  //   hre.networkVariables.acs4usd.coinIds
  // )).wait();

  // setup Exchange routes
  console.log("exchange routes setup...");
  await (
    await exchange.setRouteEx(
      [
        busd.address,
        busd.address,
        usdc.address,
        bswAddress,
        bswAddress,
        bswAddress,
        stgAddress,
        stgAddress,
        dodoAddress,
        dodoAddress,
        theAddress,
        theAddress,
      ],
      [
        usdt.address,
        usdc.address,
        usdt.address,
        busd.address,
        usdt.address,
        usdc.address,
        usdt.address,
        busd.address,
        usdt.address,
        busd.address,
        usdt.address,
        usdc.address,
      ],
      [
        {
          defaultRoute: pancakeV3Plugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakeV3Plugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakeV3Plugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
        {
          defaultRoute: pancakePlugin.address,
          limit: 0,
          secondRoute: ethers.constants.AddressZero,
          customSlippageInBps: 0,
        },
      ]
    )
  ).wait();

  await await exchange.setMaxStablecoinSlippageInBps(MAX_EXCHANGE_SLIPPAGE);

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

  // setup Batch addresses
  console.log("Batch settings setup...");
  await (
    await batch.setAddresses(
      exchange.address,
      oracle.address,
      router.address,
      receiptContract.address
    )
  ).wait();
  await (await batch.setDepositFeeSettings(depositFeeSettings)).wait();

  // setup StrategyRouter
  console.log("StrategyRouter settings setup...");
  await (await router.setFeesCollectionAddress(admin.address)).wait();

  await (
    await admin.setAddresses(
      exchange.address,
      oracle.address,
      sharesToken.address,
      batch.address,
      receiptContract.address
    )
  ).wait();

  await (await admin.setAllocationWindowTime(CYCLE_DURATION)).wait();

  console.log("Setting supported token...");
  const busdIdleStrategy = await deployProxyIdleStrategy(
    owner,
    batch,
    router,
    admin.address,
    busd
  );
  await (
    await admin.setSupportedToken(busd.address, true, busdIdleStrategy.address)
  ).wait();
  const usdcIdleStrategy = await deployProxyIdleStrategy(
    owner,
    batch,
    router,
    admin.address,
    usdc
  );
  await (
    await admin.setSupportedToken(usdc.address, true, usdcIdleStrategy.address)
  ).wait();
  const usdtIdleStrategy = await deployProxyIdleStrategy(
    owner,
    batch,
    router,
    admin.address,
    usdt
  );
  await (
    await admin.setSupportedToken(usdt.address, true, usdtIdleStrategy.address)
  ).wait();

  console.log("Adding strategies...");
  // await (await admin.addStrategy(strategyBusd.address, 5000)).wait();
  // await (await admin.addStrategy(strategyUsdc.address, 5000)).wait();
  await (await admin.addStrategy(dodoBusd.address, 7000)).wait();
  await (await admin.addStrategy(dodoUsdt.address, 7000)).wait();
  // await (await admin.addStrategy(stargateBusdStrategy.address, 5000)).wait();
  await (await admin.addStrategy(stargateUsdtStrategy.address, 3000)).wait();
  // await (await router.addStrategy(thenaUsdtStrategy.address, 5000)).wait();
  // await (await router.addStrategy(thenaUsdcStrategy.address, 5000)).wait();

  console.log("Approving for initial deposit...");
  if (
    (await usdc.allowance(owner.address, router.address)).lt(INITIAL_DEPOSIT)
  ) {
    await (await usdc.approve(router.address, INITIAL_DEPOSIT)).wait();
    console.log("usdc approved...");
  }

  try {
    console.log("Initial deposit to batch...");
    const depositFeeAmount = await batch.getDepositFeeInBNB(
      await toUniform(usdc, INITIAL_DEPOSIT)
    );
    await (
      await router.depositToBatch(usdc.address, INITIAL_DEPOSIT, "", {
        value: depositFeeAmount,
      })
    ).wait();
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
      StrategyRouterLib: routerLib.address,
    },
  });

  await safeVerifyMultiple([
    admin,
    oracle,
    exchange,
    // acsPlugin,
    pancakePlugin,
    pancakeV3Plugin,
    receiptContract,
    batch,
    sharesToken,
    // strategyBusd,
    // strategyUsdc,
    dodoBusd,
    dodoUsdt,
    // stargateBusdStrategy,
    // thenaUsdtStrategy,
    // thenaUsdcStrategy,
    stargateUsdtStrategy,
    busdIdleStrategy,
    usdcIdleStrategy,
    usdtIdleStrategy,
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
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
