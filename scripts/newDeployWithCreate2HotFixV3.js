const { parseUnits } = require("ethers/lib/utils");
const hre = require("hardhat");
const { ethers, upgrades } = require("hardhat");
const {
  deploy,
  deployProxy,
  parseUniform,
  toUniform,
  getUSDC,
} = require("../test/utils");
const { impersonate } = require("../test/shared/forkHelper");

const {
  contractsData: { ORACLE },
} = require("./utils/constants");

const {
  delay,
  setupVerificationHelper,
  safeVerify,
  safeVerifyMultiple,
  create2DeployProxyIdleStrategy,
  create2DeployProxy,
  create2Deploy,
} = require("./utils");

// deploy new contracts (StrategyRouter, RouterAdmin, Batch,BatchOut, SharesToken, ReceiptNFT)

async function main() {
  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~

  [owner] = await ethers.getSigners();

  await setupVerificationHelper();

  // ~~~~~~~~~~~ GET TOKENS ADDRESSES ON MAINNET ~~~~~~~~~~~

  const wbnbAddress = hre.networkVariables.wbnb;
  const bswAddress = hre.networkVariables.bsw;
  const stgAddress = hre.networkVariables.stg;
  const dodoAddress = hre.networkVariables.dodo;
  const theAddress = hre.networkVariables.the;

  const busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
  const usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
  const usdt = await ethers.getContractAt("ERC20", hre.networkVariables.usdt);
  const hay = await ethers.getContractAt("ERC20", hre.networkVariables.hay);
  const usdcDecimals = await usdc.decimals();
  const usdtDecimals = await usdt.decimals();
  const busdDecimals = await busd.decimals();
  const hayDecimals = await hay.decimals();
  const parseUsdc = (amount) => parseUnits(amount, usdcDecimals);
  const parseUsdt = (amount) => parseUnits(amount, usdtDecimals);
  const parseBusd = (amount) => parseUnits(amount, busdDecimals);
  const parseHay = (amount) => parseUnits(amount, hayDecimals);

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~\

  const isTest =
    hre.network.name === "localhost" || hre.network.name === "hardhat";

  // const deployedContractsOwner = !isTest
  //   ? owner
  //   : await impersonate("0xdC12ea64fbe3A96a4AC47113F63E42d6de162A77"); // use impersonate only for test and if you don't have access to the admin account

  const WAIT_CONFIRMATIONS = isTest ? 1 : 3; // can set 2 or more confirmations if needed, but for testing 1 is required

  const CYCLE_DURATION = 6;
  const MAX_EXCHANGE_SLIPPAGE = 50; // 0.5%
  const INITIAL_DEPOSIT = parseUsdc("1");
  if (isTest) {
    await getUSDC(owner.address);
  }
  const RECEIPT_NFT_URI = "https://www.clip.finance/";
  const depositFeeSettings = {
    minFeeInUsd: parseUniform("0.15"), // 0.15 USD
    maxFeeInUsd: parseUniform("1"), // 1 USD
    feeInBps: 1, // is 0.01% in BPS
  };
  const withdrawFeeSettings = {
    minFeeInUsd: parseUniform("0.15"), // 0.15 USD
    maxFeeInUsd: parseUniform("1"), // 1 USD
    feeInBps: 1, // is 0.01% in BPS
  };
  const maxSlippageToWithdrawInBps = 200; // 2% slippage

  const priceManipulationPercentThresholdInBps = 300;
  const oracle = await ethers.getContractAt(
    "ChainlinkOracle",
    ORACLE.proxyAddress
  );
  // ~~~~~~~~~~~ DEPLOY Create2Deployer and PlaceholderContract ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Deploying Create2Deployer...");

  const create2Deployer = await ethers.getContractAt(
    "Create2Deployer",
    "0x1e7BD85EDBC3eAD8E6c34eA77f37D7653Ee05636"
  );

  // const Create2Deployer = await ethers.getContractFactory("Create2Deployer");
  // const create2Deployer = await Create2Deployer.deploy();
  // await create2Deployer.deployed();
  // console.log("Deployed Create2Deployer address:", create2Deployer.address);

  // console.log(" ");
  // console.log("Deploying PlaceholderContract...");

  // Deploy PlaceholderContract (first implementation to be used in the proxy with the persist bytecode)
  const placeholderContract = await ethers.getContractAt(
    "PlaceholderContract",
    "0xc3C47F493b37Ef443A7e69544606A04aDA0c6a98"
  );
  // const { contract: placeholderContract } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "PlaceholderContract",
  // });
  // console.log(
  //   "Deployed PlaceholderContract address:",
  //   placeholderContract.address
  // );

  // Add the constructor arguments to the proxy bytecode to obtain the final bytecode
  const UUPSProxyFactory = await ethers.getContractFactory(
    "ProtectedERC1967Proxy"
  );
  const ProxyBytecode = UUPSProxyFactory.getDeployTransaction(
    placeholderContract.address,
    []
  ).data;

  // ~~~~~~~~~~~ DEPLOY (Oracle), StrategyRouter, RouterAdmin, Batch, BatchOut, SharesToken, ReceiptNFT, Rewards contracts ~~~~~~~~~~~

  // // Depoy Oracle
  // console.log(" ");
  // console.log("Deploying Oracle...");

  // const oracle = await deployProxy("ChainlinkOracle");
  // console.log("Deployed Oracle address:", oracle.address);

  // // Deploy StrategyRouter
  // console.log(" ");
  // console.log("Deploying StrategyRouter...");

  // const routerLib = await deploy("StrategyRouterLib");

  const router = await ethers.getContractAt(
    "StrategyRouter",
    "0x03A074D130144FcE6883F7EA3884C0a783d85Fb3"
  );

  // const {
  //   implementation: implRouter,
  //   proxyContract: router,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "StrategyRouter",
  //   factoryOptions: {
  //     libraries: {
  //       StrategyRouterLib: routerLib.address,
  //     },
  //   },
  // });

  // console.log("Deployed Proxy StrategyRouter address:", router.address);

  // // Deploy Admin
  // console.log(" ");
  // console.log("Deploying RouterAdmin...");

  const admin = await ethers.getContractAt(
    "RouterAdmin",
    "0x1a23D1Fb27197dee889A2Acd5dda9CC7656694C4"
  );

  // const { contract: admin } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "RouterAdmin",
  //   constructorArgs: [router.address],
  // });
  // console.log("Deployed RouterAdmin address:", admin.address);

  // // Deploy Batch
  // console.log(" ");
  // console.log("Deploying Batch...");

  const batch = await ethers.getContractAt(
    "Batch",
    "0xfCcc0ECE0daD2Ef38c84de53168dC0923c6c68d1"
  );

  // const {
  //   implementation: implBatch,
  //   proxyContract: batch,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "Batch",
  // });

  // console.log("Deployed Proxy Batch address:", batch.address);

  // // Deploy Batch Out
  // console.log(" ");
  // console.log("Deploying BatchOut...");

  const batchOut = await ethers.getContractAt(
    "BatchOut",
    "0x0839691c82F5B0231c97fdD5Af8073491fa0998c"
  );

  // const {
  //   implementation: implBatchOut,
  //   proxyContract: batchOut,
  //   proxyAddress: batchOutProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "BatchOut",
  // });
  // console.log("Deployed Proxy BatchOut address:", batchOutProxyAddress);

  // // Deploy SharesToken
  // console.log(" ");
  // console.log("Deploying SharesToken...");

  const sharesToken = await ethers.getContractAt(
    "SharesToken",
    "0xDD49bF14cAAE7a22bb6a58A76C4E998054859D9a"
  );

  // const {
  //   implementation: implSharesToken,
  //   proxyContract: sharesToken,
  //   proxyAddress: sharesTokenProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "SharesToken",
  //   initializeTypes: ["address", "address"],
  //   initializeArgs: [router.address, batchOutProxyAddress],
  // });
  // console.log("Deployed Proxy SharesToken address:", sharesTokenProxyAddress);

  // // Deploy  ReceiptNFT
  // console.log(" ");
  // console.log("Deploying ReceiptNFT...");

  const receiptNFT = await ethers.getContractAt(
    "ReceiptNFT",
    "0x4661Ac8b3Dbf8Db241Cc89a3EdeAD3c884900839"
  );

  // const {
  //   implementation: implReceiptNFT,
  //   proxyContract: receiptNFT,
  //   proxyAddress: receiptNFTProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "ReceiptNFT",
  //   initializeTypes: ["address", "address", "string", "bool"],
  //   initializeArgs: [
  //     router.address,
  //     batch.address,
  //     RECEIPT_NFT_URI,
  //     false,
  //   ],
  // });

  // console.log("Deployed Proxy ReceiptNFT address:", receiptNFTProxyAddress);

  // // Deploy Rewards
  // console.log(" ");
  // console.log("Deploying Rewards...");

  const rewards = ethers.getContractAt(
    "Rewards",
    "0x723Acc4cA859F2d95Ec69748Ce1D9c28a3C13024"
  );

  // const { contract: rewards } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "Rewards",
  //   constructorArgs: [router.address, oracle.address],
  // });
  // console.log("Deployed Rewards address:", rewards.address);

  // // ~~~~~~~~~~~ DEPLOY Exchange and Plugins ~~~~~~~~~~~\
  // console.log(" ");
  // console.log("Deploying Exchange...");

  const exchange = await ethers.getContractAt(
    "Exchange",
    "0x10D4Df9A82131a2707fE2F529F18177Aa5B08FbA"
  );
  // const {
  //   implementation: implExchange,
  //   proxyContract: exchange,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "Exchange",
  // });

  // console.log("Deployed Proxy Exchange address:", exchange.address);

  // console.log(" ");
  // console.log("Deploying PancakeV2 Plugin...");

  const pancakeV2Plugin = await ethers.getContractAt(
    "UniswapPlugin",
    "0xBa0F3227827e70a2462e2F669B7f437f995BdbE8"
  );

  // const { contract: pancakeV2Plugin } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "UniswapPlugin",
  //   constructorArgs: [hre.networkVariables.uniswapRouter],
  //   saltAddition: "PancakeV2",
  // });
  // console.log("Deployed PancakeV2 Plugin address:", pancakeV2Plugin.address);

  // console.log(" ");
  // console.log("Deploying PancakeV3 Plugin...");

  const pancakeV3Plugin = await ethers.getContractAt(
    "UniswapV3Plugin",
    "0x7c42c186a9Ecc027d2f4957A2F08C6d503700cDb"
  );
  // const { contract: pancakeV3Plugin } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "UniswapV3Plugin",
  //   constructorArgs: [hre.networkVariables.uniswapV3Router],
  // });
  // console.log("Deployed PancakeV3 Plugin address:", pancakeV3Plugin.address);

  // console.log(" ");
  // console.log("Deploying Wombat Plugin...");

  const wombatPlugin = await ethers.getContractAt(
    "WombatPlugin",
    "0x82A5f499adBbB509F44d76458528912eb7E93B77"
  );
  // const { contract: wombatPlugin } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "WombatPlugin",
  //   constructorArgs: [hre.networkVariables.wombatRouter],
  // });
  // console.log("Deployed Wombat Plugin address:", wombatPlugin.address);

  // console.log(" ");
  // console.log("Deploying Biswap Plugin...");

  const biswapPlugin = await ethers.getContractAt(
    "UniswapPlugin",
    "0xD894241ccD889a49762C7232925E850F3ECDd549"
  );

  // const { contract: biswapPlugin } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "UniswapPlugin",
  //   constructorArgs: [hre.networkVariables.biswapRouter],
  //   saltAddition: "Biswap",
  // });
  // console.log("Deployed Biswap Plugin address:", biswapPlugin.address);

  // console.log(" ");
  // console.log("Deploying Thena Algebra Plugin...");

  const thenaAlgebraPlugin = await ethers.getContractAt(
    "AlgebraPlugin",
    "0x0D18aa1C6AAAA2FdcA4D42AEA990b30B57f59f3A"
  );
  // const { contract: thenaAlgebraPlugin } = await create2Deploy({
  //   create2Deployer,
  //   ContractName: "AlgebraPlugin",
  //   constructorArgs: [
  //     hre.networkVariables.thenaAlgebraRouter,
  //     hre.networkVariables.thenaAlgebraFactory,
  //   ],
  //   saltAddition: "Thena",
  // });
  // console.log(
  //   "Deployed Thena Algebra Plugin address:",
  //   thenaAlgebraPlugin.address
  // );

  // ~~~~~~~~~~~ DEPLOY DODO USDT strategy ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Deploying Dodo Usdt Strategy...");

  const dodoUsdt = await ethers.getContractAt(
    "DodoUsdt",
    "0x4Cf8EB987ba724D690A5Bba80D607F58E1b7C020"
  );

  // const {
  //   implementation: implDodoUsdt,
  //   proxyContract: dodoUsdt,
  //   proxyAddress: dodoUsdtProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "DodoUsdt",
  //   constructorArgs: [router.address],
  //   initializeTypes: ["address", "uint256", "uint16", "address[]"],
  //   initializeArgs: [
  //     owner.address,
  //     parseUsdt((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [router.address, batch.address],
  //   ],
  // });

  // console.log(
  //   "Deployed implementation Dodo Usdt Strategy address:",
  //   implDodoUsdt.address
  // );
  // console.log(
  //   "Deployed Dodo Usdt Strategy Proxy address:",
  //   dodoUsdtProxyAddress
  // );

  // console.log(
  //   "Transfering ownership of Dodo Usdt Strategy to Strategy Router..."
  // );
  // await (
  //   await dodoUsdt.transferOwnership(router.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // ~~~~~~~~~~~ DEPLOY DODO BUSD strategy ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Deploying Dodo Busd Strategy...");

  const dodoBusd = await ethers.getContractAt(
    "DodoBusd",
    "0xac7Ba31eCDF6a2e1a8dac10494B552C2CEeED917"
  );

  // const {
  //   implementation: implDodoBusd,
  //   proxyContract: dodoBusd,
  //   proxyAddress: dodoBusdProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "DodoBusd",
  //   constructorArgs: [router.address],
  //   initializeTypes: ["address", "uint256", "uint16", "address[]"],
  //   initializeArgs: [
  //     owner.address,
  //     parseBusd((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [router.address, batch.address],
  //   ],
  // });

  // console.log(
  //   "Deployed implementation Dodo Busd Strategy address:",
  //   implDodoBusd.address
  // );
  // console.log(
  //   "Deployed Dodo Busd Strategy Proxy address:",
  //   dodoBusdProxyAddress
  // );

  // console.log(
  //   "Transfering ownership of Dodo Busd Strategy to Strategy Router..."
  // );
  // await (
  //   await dodoBusd.transferOwnership(router.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // ~~~~~~~~~~~ DEPLOY STARGATE USDT strategy ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Deploying Stargate Usdt Strategy...");

  const stargateUsdt = await ethers.getContractAt(
    "StargateUsdt",
    "0xfAcd8A564Db63A984Cc7E98B04388E297bB29CF2"
  );

  // const {
  //   implementation: implStargateUsdt,
  //   proxyContract: stargateUsdt,
  //   proxyAddress: stargateUsdtProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "StargateUsdt",
  //   constructorArgs: [router.address],
  //   initializeTypes: ["address", "uint256", "uint16", "address[]"],
  //   initializeArgs: [
  //     owner.address,
  //     parseUsdt((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [router.address, batch.address],
  //   ],
  // });

  // console.log(
  //   "Deployed implementation Stargate Usdt Strategy address:",
  //   implStargateUsdt.address
  // );
  // console.log(
  //   "Deployed Stargate Usdt Strategy Proxy address:",
  //   stargateUsdtProxyAddress
  // );

  // console.log(
  //   "Transfering ownership of Stargate Usdt Strategy to Strategy Router..."
  // );
  // await (
  //   await stargateUsdt.transferOwnership(router.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // ~~~~~~~~~~~ DEPLOY BISWAP HAY STRATEGY ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Deploying Biswap Hay Strategy...");

  const biswapHayUsdt = await ethers.getContractAt(
    "BiswapHayUsdt",
    "0x53B29D8c8191d94Aaedf7cDd7cD3A18113bb3457"
  );

  // const {
  //   implementation: implBiswapHayUsdt,
  //   proxyContract: biswapHayUsdt,
  //   proxyAddress: biswapHayUsdtProxyAddress,
  // } = await create2DeployProxy({
  //   create2Deployer,
  //   ProxyBytecode,
  //   ContractName: "BiswapHayUsdt",
  //   constructorArgs: [
  //     router.address,
  //     oracle.address,
  //     priceManipulationPercentThresholdInBps,
  //   ],
  //   initializeTypes: ["address", "uint256", "uint16", "address[]"],
  //   initializeArgs: [
  //     owner.address,
  //     parseHay((1_000_000).toString()), // TODO change to real value on production deploy
  //     500, // 5%
  //     [router.address, batch.address],
  //   ],
  // });

  // console.log(
  //   "Deployed implementation Biswap Hay Strategy address:",
  //   implBiswapHayUsdt.address
  // );
  // console.log(
  //   "Deployed Biswap Hay Strategy Proxy address:",
  //   biswapHayUsdtProxyAddress
  // );

  // console.log(
  //   "Transfering ownership of Biswap Hay Strategy to Strategy Router..."
  // );
  // await (
  //   await biswapHayUsdt.transferOwnership(router.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~
  // Setup Oracle
  // console.log(" ");
  // console.log("Oracle setting up price feeds...");

  // const oracleTokens = [
  //   busd.address,
  //   usdc.address,
  //   usdt.address,
  //   hay.address,
  //   hre.networkVariables.bsw,
  //   hre.networkVariables.wbnb,
  // ];
  // const priceFeeds = [
  //   hre.networkVariables.BusdUsdPriceFeed,
  //   hre.networkVariables.UsdcUsdPriceFeed,
  //   hre.networkVariables.UsdtUsdPriceFeed,
  //   hre.networkVariables.HayUsdPriceFeed, // oracle should be whitelisted
  //   hre.networkVariables.BswUsdPriceFeed,
  //   hre.networkVariables.BnbUsdPriceFeed,
  // ];
  // await (
  //   await oracle.setPriceFeeds(oracleTokens, priceFeeds)
  // ).wait(WAIT_CONFIRMATIONS);

  // const oracleTokens = [wbnbAddress];
  // const priceFeeds = [hre.networkVariables.BnbUsdPriceFeed];
  // await (
  //   await oracle
  //     .connect(deployedContractsOwner)
  //     .setPriceFeeds(oracleTokens, priceFeeds)
  // ).wait(WAIT_CONFIRMATIONS);

  // // Setup Batch addresses
  // console.log(" ");
  // console.log("Batch setting up addresses...");
  // await (
  //   await batch.setAddresses(
  //     exchange.address,
  //     oracle.address,
  //     router.address,
  //     receiptNFT.address
  //   )
  // ).wait(WAIT_CONFIRMATIONS);
  // await (
  //   await batch.setDepositFeeSettings(depositFeeSettings)
  // ).wait(WAIT_CONFIRMATIONS);

  // // Setup BatchOut
  // console.log(" ");
  // console.log("BatchOut setting up addresses...");
  // await (
  //   await batchOut.setAddresses(
  //     exchange.address,
  //     oracle.address,
  //     router.address,
  //     receiptNFT.address,
  //     sharesToken.address,
  //     admin.address
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("BatchOut setting up withdraw fee settings...");
  // await (
  //   await batchOut.setWithdrawFeeSettings(withdrawFeeSettings)
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("BatchOut setting up max withdraw slippage...");
  // await (
  //   await batchOut.setMaxSlippageToWithdrawInBps(maxSlippageToWithdrawInBps)
  // ).wait();

  // console.log("BatchOut setting up as moderator to RouterAdmin...");
  // await (
  //   await admin.grantRole(await admin.MODERATOR(), batchOut.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // // setup StrategyRouter
  // console.log(" ");
  // console.log(
  //   "StrategyRouter setting up fees collection address and moderator..."
  // );
  // await (
  //   await router.setFeesCollectionAddress(admin.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("StrategyRouter setting up addresses...");
  // await (
  //   await admin.setAddresses(
  //     exchange.address,
  //     oracle.address,
  //     sharesToken.address,
  //     batch.address,
  //     receiptNFT.address
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("StrategyRouter setting up cycle duration...");
  // await (
  //   await admin.setAllocationWindowTime(CYCLE_DURATION)
  // ).wait(WAIT_CONFIRMATIONS);

  // // ~~~~~~~~~~~ SETTING UP PLUGINS AND EXCHANGE ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Setting up plugins...");

  // console.log("Setting up PancakeV2 Plugin...");
  // await (
  //   await pancakeV2Plugin.setMediatorTokensForPairs(
  //     [wbnbAddress, wbnbAddress, busd.address, wbnbAddress, wbnbAddress],
  //     [
  //       [dodoAddress, usdt.address],
  //       [dodoAddress, busd.address],
  //       [stgAddress, usdt.address],
  //       [theAddress, usdt.address],
  //       [theAddress, usdc.address],
  //     ]
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("Setting up PancakeV3 Plugin...");
  // await (
  //   await pancakeV3Plugin.setSingleHopPairsData(
  //     [100, 100, 100],
  //     [
  //       [busd.address, usdt.address],
  //       [busd.address, usdc.address],
  //       [usdc.address, usdt.address],
  //     ]
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("Setting up Wombat Plugin...");
  // await (
  //   await wombatPlugin.setMediatorTokensForPairs(
  //     [usdc.address],
  //     [[hay.address, busd.address]]
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // const wombatMainPool = hre.networkVariables.wombatMainPool;
  // const wombatHayPool = hre.networkVariables.wombatHayPool;
  // await (
  //   await wombatPlugin.setPoolsForPairs(
  //     [
  //       wombatHayPool,
  //       wombatMainPool,
  //       wombatHayPool,
  //       wombatMainPool,
  //       wombatMainPool,
  //     ],
  //     [
  //       [hay.address, usdc.address],
  //       [usdc.address, busd.address],
  //       [hay.address, usdt.address],
  //       [busd.address, usdt.address],
  //       [usdc.address, usdt.address],
  //     ]
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("Setting up Biswap Plugin...");
  // await (
  //   await biswapPlugin.setMediatorTokensForPairs(
  //     [usdt.address, usdt.address, usdt.address],
  //     [
  //       [bswAddress, busd.address],
  //       [bswAddress, usdc.address],
  //       [bswAddress, hay.address],
  //     ]
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("Setting up Thena Algebra Plugin...");

  // await (
  //   await thenaAlgebraPlugin.setMediatorTokensForPairs(
  //     [usdt.address, usdt.address],
  //     [
  //       [theAddress, hay.address],
  //       [theAddress, usdc.address],
  //     ]
  //   )
  // ).wait(WAIT_CONFIRMATIONS);

  // // setup Exchange params
  // console.log(" ");
  // console.log("Setting Exchange params...");

  // console.log("Setting up Exchange slippage...");
  // await (
  //   await exchange.setMaxStablecoinSlippageInBps(MAX_EXCHANGE_SLIPPAGE)
  // ).wait(WAIT_CONFIRMATIONS);

  // console.log("Setting up Exchange routes...");
  // await (
  //   await exchange.setRoute(
  //     [
  //       // stable coins
  //       busd.address,
  //       busd.address,
  //       usdc.address,

  //       // hay pairs
  //       hay.address,
  //       hay.address,
  //       hay.address,

  //       // bsw pairs
  //       bswAddress,
  //       bswAddress,
  //       bswAddress,
  //       bswAddress,

  //       // stg pairs
  //       stgAddress,
  //       stgAddress,

  //       // dodo pairs
  //       dodoAddress,
  //       dodoAddress,

  //       // thena pairs
  //       theAddress,
  //       theAddress,
  //       theAddress,
  //     ],
  //     [
  //       // stable coins
  //       usdt.address,
  //       usdc.address,
  //       usdt.address,

  //       // hay pairs
  //       usdc.address,
  //       usdt.address,
  //       busd.address,

  //       // bsw pairs
  //       busd.address,
  //       usdt.address,
  //       usdc.address,
  //       hay.address,

  //       // stg pairs
  //       usdt.address,
  //       busd.address,

  //       // dodo pairs
  //       usdt.address,
  //       busd.address,

  //       // the pairs
  //       usdt.address,
  //       usdc.address,
  //       hay.address,
  //     ],
  //     [
  //       // stable coins
  //       pancakeV3Plugin.address,
  //       pancakeV3Plugin.address,
  //       pancakeV3Plugin.address,

  //       // hay pairs
  //       wombatPlugin.address,
  //       wombatPlugin.address,
  //       wombatPlugin.address,

  //       // bsw pairs
  //       biswapPlugin.address,
  //       biswapPlugin.address,
  //       biswapPlugin.address,
  //       biswapPlugin.address,

  //       // stg pairs
  //       pancakeV2Plugin.address,
  //       pancakeV2Plugin.address,

  //       // dodo pairs
  //       pancakeV2Plugin.address,
  //       pancakeV2Plugin.address,

  //       // the pairs
  //       thenaAlgebraPlugin.address,
  //       thenaAlgebraPlugin.address,
  //       thenaAlgebraPlugin.address,
  //     ]
  //   )
  // ).wait();

  // ~~~~~~~~~~~ SETTING UP SUPPORTED TOKENS ~~~~~~~~~~~
  // console.log(" ");
  // console.log("Setting up supported tokens...");

  const busdIdleStrategy = await ethers.getContractAt(
    "DefaultIdleStrategy",
    "0xaE592F7Eff121974C80436148FBE82a82bbc6716"
  );

  // const {
  //   idleStrategy: busdIdleStrategy,
  //   implIdleStrategy: implBusdIdleStrategy,
  // } = await create2DeployProxyIdleStrategy(
  //   create2Deployer,
  //   ProxyBytecode,
  //   owner,
  //   batch,
  //   router,
  //   admin.address,
  //   busd,
  //   "Busd",
  //   WAIT_CONFIRMATIONS
  // );
  // console.log(
  //   "Deployed implementation Busd Idle Strategy address:",
  //   implBusdIdleStrategy.address
  // );
  // console.log(
  //   "Deployed Busd Idle Strategy Proxy address:",
  //   busdIdleStrategy.address
  // );
  // console.log("Setting up Busd as supported token...");
  // await (
  //   await admin.setSupportedToken(busd.address, true, busdIdleStrategy.address)
  // ).wait(WAIT_CONFIRMATIONS);

  const usdcIdleStrategy = await ethers.getContractAt(
    "DefaultIdleStrategy",
    "0x2a4088eB99bEE65123bacD00047108c3846c3b3A"
  );

  // const {
  //   idleStrategy: usdcIdleStrategy,
  //   implIdleStrategy: implUsdcIdleStrategy,
  // } = await create2DeployProxyIdleStrategy(
  //   create2Deployer,
  //   ProxyBytecode,
  //   owner,
  //   batch,
  //   router,
  //   admin.address,
  //   usdc,
  //   "Usdc",
  //   WAIT_CONFIRMATIONS
  // );
  // console.log(
  //   "Deployed implementation Usdc Idle Strategy address:",
  //   implUsdcIdleStrategy.address
  // );
  // console.log(
  //   "Deployed Usdc Idle Strategy Proxy address:",
  //   usdcIdleStrategy.address
  // );
  // console.log("Setting up Usdc as supported token...");
  // await (
  //   await admin.setSupportedToken(usdc.address, true, usdcIdleStrategy.address)
  // ).wait(WAIT_CONFIRMATIONS);

  const usdtIdleStrategy = await ethers.getContractAt(
    "DefaultIdleStrategy",
    "0x8C927DfD7c3aA5f85f57d69B8e8F4E3f9435f003"
  );

  // const {
  //   idleStrategy: usdtIdleStrategy,
  //   implIdleStrategy: implUsdtIdleStrategy,
  // } = await create2DeployProxyIdleStrategy(
  //   create2Deployer,
  //   ProxyBytecode,
  //   owner,
  //   batch,
  //   router,
  //   admin.address,
  //   usdt,
  //   "Usdt",
  //   WAIT_CONFIRMATIONS
  // );
  // console.log(
  //   "Deployed implementation Usdt Idle Strategy address:",
  //   implUsdtIdleStrategy.address
  // );
  // console.log(
  //   "Deployed Usdt Idle Strategy Proxy address:",
  //   usdtIdleStrategy.address
  // );
  // console.log("Setting up Usdt as supported token...");
  // await (
  //   await admin.setSupportedToken(usdt.address, true, usdtIdleStrategy.address)
  // ).wait(WAIT_CONFIRMATIONS);

  // const hayIdleStrategy = await ethers.getContractAt(
  //   "IdleStrategy",
  //   "0xf7E13f7A1328e7918C4a60533995f791B1f253a1"
  // );

  const hayIdleStrategy = await ethers.getContractAt(
    "DefaultIdleStrategy",
    "0xf7E13f7A1328e7918C4a60533995f791B1f253a1"
  );

  // const {
  //   idleStrategy: hayIdleStrategy,
  //   implIdleStrategy: implHayIdleStrategy,
  // } = await create2DeployProxyIdleStrategy(
  //   create2Deployer,
  //   ProxyBytecode,
  //   owner,
  //   batch,
  //   router,
  //   admin.address,
  //   hay,
  //   "Hay",
  //   WAIT_CONFIRMATIONS
  // );
  // console.log(
  //   "Deployed implementation Hay Idle Strategy address:",
  //   implHayIdleStrategy.address
  // );
  // console.log(
  //   "Deployed Hay Idle Strategy Proxy address:",
  //   hayIdleStrategy.address
  // );

  console.log("Transferring ownership to router...");

  await (
    await hayIdleStrategy.transferOwnership(router.address)
  ).wait(WAIT_CONFIRMATIONS);

  //
  console.log("Setting up Hay as supported token...");
  await (
    await admin.setSupportedToken(hay.address, true, hayIdleStrategy.address)
  ).wait(WAIT_CONFIRMATIONS);

  console.log(" ");
  console.log("Adding strategies...");
  console.log("Adding Dodo Usdt Strategy...");
  await (
    await admin.addStrategy(dodoBusd.address, 10000)
  ).wait(WAIT_CONFIRMATIONS);
  console.log("Adding Dodo Busd Strategy...");
  await (
    await admin.addStrategy(dodoUsdt.address, 7000)
  ).wait(WAIT_CONFIRMATIONS);
  console.log("Adding Stargate Usdt Strategy...");
  await (
    await admin.addStrategy(stargateUsdt.address, 3000)
  ).wait(WAIT_CONFIRMATIONS);
  console.log("Adding Biswap Hay Strategy...");
  await (
    await admin.addStrategy(biswapHayUsdt.address, 1000)
  ).wait(WAIT_CONFIRMATIONS);

  // ~~~~~~~~~~~ INITIAL DEPOSIT ~~~~~~~~~~~
  console.log(" ");
  if (
    (await usdc.allowance(owner.address, router.address)).lt(INITIAL_DEPOSIT)
  ) {
    console.log("Approving for initial deposit...");
    await (
      await usdc.approve(router.address, INITIAL_DEPOSIT)
    ).wait(WAIT_CONFIRMATIONS);
    console.log("usdc approved...");
  }

  try {
    console.log("Initial deposit to batch...");
    const depositFeeAmount = await batch.getDepositFeeInBNB(
      (await toUniform(INITIAL_DEPOSIT, usdc.address)).toHexString()
    );
    await (
      await router.depositToBatch(usdc.address, INITIAL_DEPOSIT, "", {
        value: depositFeeAmount.toHexString(),
      })
    ).wait(WAIT_CONFIRMATIONS);
  } catch (error) {
    console.error(error);
  }
  try {
    console.log("Initial allocation to strategies...");
    await (await router.allocateToStrategies()).wait(WAIT_CONFIRMATIONS);
  } catch (error) {
    console.error(error);
  }

  // vvvvvvvvvvvvvvvvvvvvvvvvv VERIFICATION vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  if (!isTest) {
    console.log("  - Verification will start in a minute...\n");
    await delay(46000);

    // verify router
    // await safeVerify({
    //   address: implRouter.address,
    //   libraries: {
    //     StrategyRouterLib: routerLib.address,
    //   },
    // });

    await safeVerifyMultiple([
      // oracle,
      // admin,
      // implBatch,
      // implBatchOut,
      // implReceiptNFT,
      // implSharesToken,
      // rewards,
      // implExchange,
      // pancakeV2Plugin,
      // pancakeV3Plugin,
      // wombatPlugin,
      // biswapPlugin,
      // thenaAlgebraPlugin,
      // implDodoUsdt,
      // implDodoBusd,
      // implStargateUsdt,
      // implBiswapHayUsdt,
      // implBusdIdleStrategy,
      // implUsdcIdleStrategy,
      // implUsdtIdleStrategy,
      // implHayIdleStrategy,
    ]);
  }

  console.log(" ");
  console.log("Deployed contracts addresses");

  console.log("StrategyRouter:", router.address);
  console.log("RouterAdmin:", admin.address);
  console.log("Batch:", batch.address);
  console.log("BatchOut:", batchOut.address);
  console.log("SharesToken:", sharesToken.address);
  console.log("ReceiptNFT:", receiptNFT.address);
  console.log("Oracle:", oracle.address);
  console.log("Rewards:", rewards.address);

  console.log("Exchange:", exchange.address);
  console.log("PancakeV2 Plugin:", pancakeV2Plugin.address);
  console.log("PancakeV3 Plugin:", pancakeV3Plugin.address);
  console.log("Wombat Plugin:", wombatPlugin.address);
  console.log("Biswap Plugin:", biswapPlugin.address);
  console.log("Thena Algebra Plugin:", thenaAlgebraPlugin.address);

  console.log("DodoUsdt:", dodoUsdt.address);
  console.log("DodoBusd:", dodoBusd.address);
  console.log("StargateUsdt:", stargateUsdt.address);
  console.log("BiswapHayUsdt:", biswapHayUsdt.address);

  console.log("Busd Idle Strategy:", busdIdleStrategy.address);
  console.log("Usdc Idle Strategy:", usdcIdleStrategy.address);
  console.log("Usdt Idle Strategy:", usdtIdleStrategy.address);
  console.log("Hay Idle Strategy:", hayIdleStrategy.address);
  console.log(" ");
  console.log("Deploying done!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
