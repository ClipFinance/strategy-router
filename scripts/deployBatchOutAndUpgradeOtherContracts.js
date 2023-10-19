const hre = require("hardhat");
const { ethers, upgrades } = hre;

const {
  contractsData: {
    STRATEGY_ROUTER, // will be upgraded
    BATCH, // will be upgraded
    SHARES_TOKEN, // will be upgraded
    RECEIPT_CONTRACT,
    EXCHANGE,
    ORACLE,
  },
} = require("./utils/constants");

const { setupVerificationHelper, delay, safeVerify } = require("./utils");

const {
  deploy,
  deployProxy,
  deployProxyIdleStrategy,
} = require("../test/utils");
const {
  impersonateAccount,
} = require("@nomicfoundation/hardhat-network-helpers");
const { impersonate } = require("../test/shared/forkHelper");

// deploy proxy for BatchOut and upgrade StrategyRouter, Batch, and SharesToken contracts

async function main() {
  let [owner] = await ethers.getSigners();

  await setupVerificationHelper();

  // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~\

  const adminOwner = "0xdC12ea64fbe3A96a4AC47113F63E42d6de162A77";
  const ADMIN = "0xA6981177F8232D363a740ed98CbBC753424F3B94";
  const ROUTER_LIB = "0xC7d256C5E9898C07820466de78Ebe46254938bf0";
  // //   const PANCAKE_V3_PLUGIN = "0x6025712051Bb2067686C291d3266DD92b824dDd3";
  // //   const PANCAKE_V2_PLUGIN = "0x1974e981359a17e7508Af4B55D90fb61ECF880eF";

  // // ~~~~~~~~~~~ DEPLOY Batch Out ~~~~~~~~~~~ \
  const batchOut = await deployProxy("BatchOut", [], true);
  await batchOut.deployed();

  console.log("BatchOut deployed to:", batchOut.address);

  // Setup BatchOut
  await (
    await batchOut.setAddresses(
      EXCHANGE.proxyAddress,
      ORACLE.proxyAddress,
      STRATEGY_ROUTER.proxyAddress,
      RECEIPT_CONTRACT.proxyAddress,
      SHARES_TOKEN.proxyAddress,
      ADMIN
    )
  ).wait(); // can set 2 or more confirmations if needed

  const defaultWithdrawFeeSettings = {
    minFeeInUsd: parseUniform("0.15"),
    maxFeeInUsd: parseUniform("1"),
    feeInBps: 1, // is 0.01% in BPS
  };

  await (
    await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings)
  ).wait();

  // const signer = owner;
  const signer =
    owner.address == adminOwner ? owner : await impersonate(adminOwner); // only for testnet and if you don't have access to the admin account

  const routerAdmin = await ethers.getContractAt("RouterAdmin", ADMIN);
  // set batchOut as moderator in routerAdmin to redeem receipts
  await (
    await routerAdmin
      .connect(signer)
      .grantRole(await routerAdmin.MODERATOR(), batchOut.address)
  ).wait();

  console.log("BatchOut setup done", await batchOut.currentCycleId());

  // ~~~~~~~~~~~ VERIFY ~~~~~~~~~~~ \

  await safeVerify({
    address: batchOut.address,
    constructorArguments: [],
  });

  // ~~~~~~~~~~~ UPGRADE StrategyRouter ~~~~~~~~~~~ \

  // set router moderator to owner
  const admin = await ethers.getContractAt("RouterAdmin", ADMIN);
  console.log("Setting fees collection address...");
  await (
    await admin.connect(signer).setFeesCollectionAddress(owner.address)
  ).wait();

  const StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
    libraries: {
      StrategyRouterLib: ROUTER_LIB,
    },
  });

  const strategyRouterOptions = {
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  };
  // use it if you are not implementation of StrategyRouter in .openzeppelin/upgrades/<network>.json
  await upgrades.forceImport(
    STRATEGY_ROUTER.proxyAddress,
    StrategyRouter,
    strategyRouterOptions
  );
  console.log("Upgrading StrategyRouter...");
  const strategyRouter = await upgrades.upgradeProxy(
    STRATEGY_ROUTER.proxyAddress,
    StrategyRouter,
    strategyRouterOptions
  );

  // return moderator rights to admin contract
  console.log("Setting fees collection address...");
  await (await strategyRouter.setFeesCollectionAddress(ADMIN)).wait();
  console.log("StrategyRouter upgraded");

  // ~~~~~~~~~~~ UPGRADE Batch ~~~~~~~~~~~ \

  // Set BNB price feed to oracle
  const oracle = await ethers.getContractAt(
    "ChainlinkOracle",
    ORACLE.proxyAddress
  );
  // Check if owner of oracle is owner of this script and transfer ownership if not
  if ((await oracle.owner()) != owner.address) {
    console.log("Setting oracle admin...");
    await (
      await oracle.connect(signer).transferOwnership(owner.address)
    ).wait();
  }
  console.log("Setting price feeds...");
  // set BNB price feed to use in Batch
  await (
    await oracle.setPriceFeeds(
      [hre.networkVariables.wbnb],
      [hre.networkVariables.BnbUsdPriceFeed]
    )
  ).wait();

  let oldBatch = await ethers.getContractAt("OldBatch", BATCH.proxyAddress);
  if ((await oldBatch.owner()) != owner.address) {
    console.log("Setting Batch admin...");
    await (
      await oldBatch.connect(signer).transferOwnership(owner.address)
    ).wait();
  }

  const OldBatch = await ethers.getContractFactory("OldBatch");

  const batchOptions = {
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  };
  // use it if you are not implementation of Batch in .openzeppelin/upgrades/<network>.json
  await upgrades.forceImport(BATCH.proxyAddress, OldBatch, batchOptions);

  console.log("Upgrading Batch...");
  const Batch = await ethers.getContractFactory("Batch");
  const batch = await upgrades.upgradeProxy(
    BATCH.proxyAddress,
    Batch,
    batchOptions
  );

  console.log(
    "getDepositFeeInBNB",
    await batch.getDepositFeeInBNB("1000000000000000000000")
  );

  console.log("Batch upgraded");

  // ~~~~~~~~~~~ UPGRADE SharesToken ~~~~~~~~~~~ \
  const oldSharesToken = await ethers.getContractAt(
    "OldSharesToken",
    SHARES_TOKEN.proxyAddress
  );
  if ((await oldSharesToken.owner()) != owner.address) {
    console.log("Setting SharesToken admin...");
    await (
      await oldSharesToken.connect(signer).transferOwnership(owner.address)
    ).wait();
  }

  const oldStrategyRouterAddressFromSharesToken =
    await ethers.provider.getStorageAt(SHARES_TOKEN.proxyAddress, 251);
  const oldBatchOutAddressFromSharesToken = await ethers.provider.getStorageAt(
    SHARES_TOKEN.proxyAddress,
    252
  );

  console.log(
    "oldStrategyRouterAddressFromSharesToken",
    oldStrategyRouterAddressFromSharesToken
  );
  console.log(
    "oldBatchOutAddressFromSharesToken",
    oldBatchOutAddressFromSharesToken
  );

  const OldSharesToken = await ethers.getContractFactory("OldSharesToken");
  const SharesToken = await ethers.getContractFactory("SharesToken");
  const sharesTokenOptions = {
    kind: "uups",
  };
  // use it if you are not implementation of SharesToken in .openzeppelin/upgrades/<network>.json
  await upgrades.forceImport(SHARES_TOKEN.proxyAddress, OldSharesToken, {
    ...sharesTokenOptions,
    initializer: "initialize(address)",
  });
  console.log("Upgrading SharesToken...");
  const sharesToken = await upgrades.upgradeProxy(
    SHARES_TOKEN.proxyAddress,
    SharesToken,
    {
      ...sharesTokenOptions,
      initializer: "initialize(address, address)",
    }
  );

  // set router and batchOut addresses as operators
  console.log("Setting operators...");
  await (
    await sharesToken.setOperators(
      STRATEGY_ROUTER.proxyAddress,
      batchOut.address
    )
  ).wait();

  const strategyRouterAddressFromSharesToken =
    await ethers.provider.getStorageAt(SHARES_TOKEN.proxyAddress, 251);
  const batchOutAddressFromSharesToken = await ethers.provider.getStorageAt(
    SHARES_TOKEN.proxyAddress,
    252
  );

  console.log(
    "strategyRouterAddressFromSharesToken",
    strategyRouterAddressFromSharesToken
  );
  console.log("batchOutAddressFromSharesToken", batchOutAddressFromSharesToken);
  console.log("SharesToken upgraded");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
