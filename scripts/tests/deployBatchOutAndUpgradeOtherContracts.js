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
} = require("../utils/constants");

const { setupTokens } = require("../../test/shared/commonSetup");

const { parseUnits } = require("ethers/lib/utils");
const {
  deployProxy,
  parseUniform,
  convertFromUsdToTokenAmount,
  applySlippageInBps,
} = require("../../test/utils");
const { impersonate, dirtyFix } = require("../../test/shared/forkHelper");
const { expect } = require("chai");

// deploy proxy for BatchOut and upgrade StrategyRouter, Batch, and SharesToken contracts

describe("Test deploy BatchOut and upgrade other contracts", function () {
  let owner, adminModerator;
  // tokens
  let usdc, usdt, busd, hay;
  // helper functions to parse amounts of tokens
  let parseUsdc, parseBusd, parseUsdt, parseHay;
  // core contracts
  let batchOut, admin, router, batch, oracle, sharesToken, receiptContract;

  before(async function () {
    [owner] = await ethers.getSigners();

    ({ usdc, usdt, busd, hay, parseUsdc, parseBusd, parseUsdt, parseHay } =
      await setupTokens());

    const adminOwner = "0xdC12ea64fbe3A96a4AC47113F63E42d6de162A77";
    const ADMIN = "0xA6981177F8232D363a740ed98CbBC753424F3B94";
    const ROUTER_LIB = "0xC7d256C5E9898C07820466de78Ebe46254938bf0";

    // ~~~~~~~~~~~ DEPLOY Batch Out ~~~~~~~~~~~ \
    batchOut = await deployProxy("BatchOut", [], true);
    await batchOut.deployed();

    adminModerator =
      owner.address == adminOwner ? owner : await impersonate(adminOwner);

    admin = await ethers.getContractAt("RouterAdmin", ADMIN);

    // ~~~~~~~~~~~ UPGRADE StrategyRouter ~~~~~~~~~~~ \

    // set router moderator to owner to upgrade strategy router contract
    await admin.connect(adminModerator).setFeesCollectionAddress(owner.address);

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
    router = await upgrades.upgradeProxy(
      STRATEGY_ROUTER.proxyAddress,
      StrategyRouter,
      strategyRouterOptions
    );

    // return moderator rights to admin contract
    await router.setFeesCollectionAddress(ADMIN);

    // ~~~~~~~~~~~ UPGRADE Batch ~~~~~~~~~~~ \

    // Set BNB price feed to oracle
    oracle = await ethers.getContractAt("ChainlinkOracle", ORACLE.proxyAddress);

    // Check if owner of oracle is owner of this script and transfer ownership if not
    if ((await oracle.owner()) != owner.address) {
      await oracle.connect(adminModerator).transferOwnership(owner.address);
    }

    let oldBatch = await ethers.getContractAt("OldBatch", BATCH.proxyAddress);
    if ((await oldBatch.owner()) != owner.address) {
      await oldBatch.connect(adminModerator).transferOwnership(owner.address);
    }

    const OldBatch = await ethers.getContractFactory("OldBatch");

    const batchOptions = {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
    };
    // use it if you are not implementation of Batch in .openzeppelin/upgrades/<network>.json
    await upgrades.forceImport(BATCH.proxyAddress, OldBatch, batchOptions);

    const Batch = await ethers.getContractFactory("Batch");
    batch = await upgrades.upgradeProxy(
      BATCH.proxyAddress,
      Batch,
      batchOptions
    );

    // ~~~~~~~~~~~ UPGRADE SharesToken ~~~~~~~~~~~ \
    const oldSharesToken = await ethers.getContractAt(
      "OldSharesToken",
      SHARES_TOKEN.proxyAddress
    );

    if ((await oldSharesToken.owner()) != owner.address) {
      await oldSharesToken
        .connect(adminModerator)
        .transferOwnership(owner.address);
    }

    const OldSharesToken = await ethers.getContractFactory("OldSharesToken");
    const SharesToken = await ethers.getContractFactory("SharesToken");
    const sharesTokenOptions = {
      kind: "uups",
    };
    // use it if you are not implementation of SharesToken in .openzeppelin/upgrades/<network>.json
    await upgrades.forceImport(
      SHARES_TOKEN.proxyAddress,
      OldSharesToken,
      sharesTokenOptions
    );
    sharesToken = await upgrades.upgradeProxy(
      SHARES_TOKEN.proxyAddress,
      SharesToken,
      sharesTokenOptions
    );

    receiptContract = await ethers.getContractAt(
      "ReceiptNFT",
      RECEIPT_CONTRACT.proxyAddress
    );
  });

  describe("Variables checking", async function () {
    it("should setup BatchOut with correct addresses", async function () {
      expect(await batchOut.exchange()).to.equal(ethers.constants.AddressZero);
      expect(await batchOut.oracle()).to.equal(ethers.constants.AddressZero);
      expect(await batchOut.router()).to.equal(ethers.constants.AddressZero);
      expect(await batchOut.receiptContract()).to.equal(
        ethers.constants.AddressZero
      );
      expect(await batchOut.sharesToken()).to.equal(
        ethers.constants.AddressZero
      );
      const adminSlot = 208;
      expect(
        await ethers.provider.getStorageAt(batchOut.address, adminSlot)
      ).to.equal(ethers.constants.HashZero);

      await batchOut.setAddresses(
        EXCHANGE.proxyAddress,
        ORACLE.proxyAddress,
        STRATEGY_ROUTER.proxyAddress,
        RECEIPT_CONTRACT.proxyAddress,
        SHARES_TOKEN.proxyAddress,
        admin.address
      );

      expect(await batchOut.exchange()).to.equal(EXCHANGE.proxyAddress);
      expect(await batchOut.oracle()).to.equal(ORACLE.proxyAddress);
      expect(await batchOut.router()).to.equal(STRATEGY_ROUTER.proxyAddress);
      expect(await batchOut.receiptContract()).to.equal(
        RECEIPT_CONTRACT.proxyAddress
      );
      expect(await batchOut.sharesToken()).to.equal(SHARES_TOKEN.proxyAddress);
      expect(
        dirtyFix(
          await ethers.provider.getStorageAt(batchOut.address, adminSlot)
        ).toLowerCase()
      ).to.equal(admin.address.toLowerCase());
    });
  });

  describe("Rebalance strategies", async function () {
    it("should successfuly rebalance strategies", async function () {
      const [initialTVL] = await router.getStrategiesValue();

      await expect(admin.connect(adminModerator).rebalanceStrategies()).not.to
        .be.reverted;

      const [afterRebalanceTVL] = await router.getStrategiesValue();
      expect(afterRebalanceTVL).to.be.gt(initialTVL);
    });
  });

  describe("Deposit to batch and allocation to strategies", async function () {
    it("should reverted without a reason string until wbnb price feed is not set", async function () {
      const amountDeposit = (1_000).toString();
      const amountDepositHay = parseHay(amountDeposit);

      await expect(
        router.depositToBatch(hay.address, amountDepositHay, "")
      ).to.be.revertedWithoutReason();

      // Set BNB price feed to oracle and proceed tests
      await oracle.setPriceFeeds(
        [hre.networkVariables.wbnb],
        [hre.networkVariables.BnbUsdPriceFeed]
      );
    });

    // it("should successfuly allocate to strategies with 10K of USDC tokens", async function () {
    //   const [initialTVL] = await router.getStrategiesValue();

    //   const amountDeposit = (10_000).toString();
    //   const amountDepositUniform = parseUniform(amountDeposit);
    //   const amountDepositUsdc = parseUsdc(amountDeposit);
    //   await usdc.approve(router.address, amountDepositUsdc);

    //   const depositFee = await batch.getDepositFeeInBNB(amountDepositUniform);
    //   console.log("depositFee", depositFee);

    //   console.log(
    //     "batch supportsToken",
    //     await batch.supportsToken(usdc.address)
    //   );
    //   console.log(
    //     "oracle isTokenSupported",
    //     await oracle.isTokenSupported(usdc.address)
    //   );
    //   const gasLimit = 30_000_000;
    //   const result = await hre.network.provider.send("debug_traceCall", [
    //     {
    //       from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    //       to: "0xc903f9ad53675cd5f6440b32915abfa955b8cbf4",
    //       value: depositFee.toHexString(),
    //       gasLimit,
    //       data: "0x0e7969870000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000000000000000000000000021e19e0c9bab240000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000",
    //     },
    //     "latest",
    //     {
    //       disableMemory: true,
    //       disableStack: true,
    //       disableStorage: true,
    //     },
    //   ]);

    //   console.log("result.gas", result.gas);
    //   console.log("result.failed", result.failed);
    //   console.log("result.structLogs.length", result.structLogs.length);
    //   result.structLogs.forEach((log) => {
    //     console.log(log);
    //   });
    //   console.log("result.returnValue", result.returnValue);

    //   await router.depositToBatch(usdc.address, amountDepositUsdc, "", {
    //     value: depositFee.toHexString(),
    //     gasLimit,
    //   });

    //   await expect(router.allocateToStrategies()).not.to.be.reverted;

    //   const [afterAllocateTVL] = await router.getStrategiesValue();
    //   expect(afterAllocateTVL).to.be.closeTo(
    //     initialTVL.add(amountDepositUniform),
    //     amountDepositUniform.mul(50).div(10000) // 0.5% slippage
    //   );
    // });

    // it("should successfuly allocate to strategies with 100K of BUSD tokens", async function () {
    //   const [initialTVL] = await router.getStrategiesValue();

    //   const amountDeposit = (100_000).toString();
    //   const amountDepositUniform = parseUniform(amountDeposit);
    //   const amountDepositBusd = parseBusd(amountDeposit);
    //   await busd.approve(router.address, amountDepositBusd);

    //   await router.depositToBatch(busd.address, amountDepositBusd, "");

    //   await expect(router.allocateToStrategies()).not.to.be.reverted;

    //   const [afterAllocateTVL] = await router.getStrategiesValue();
    //   expect(afterAllocateTVL).to.be.closeTo(
    //     initialTVL.add(amountDepositUniform),
    //     amountDepositUniform.mul(50).div(10000) // 0.5% slippage
    //   );
    // });
  });

  describe("Withdraw from strategies", async function () {
    // it("should successfuly withdraw from strategies", async function () {
    //   const [initialTVL] = await router.getStrategiesValue();
    //   const receipts = await receiptContract.getTokensOfOwner(
    //     adminModerator.address
    //   );
    //   console.log("receipts", receipts);
    //   const shares = await router.calculateSharesFromReceipts([receipts[0]]);
    //   const sharesValueUsd = await router.calculateSharesUsdValue(shares);
    //   const expectedWithdrawAmount = applySlippageInBps(
    //     await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
    //     50 // 0.5% slippage
    //   );
    //   expect(
    //     await router
    //       .connect(adminModerator)
    //       .withdrawFromStrategies(
    //         [receipts[0]],
    //         usdc.address,
    //         shares,
    //         expectedWithdrawAmount,
    //         false
    //       )
    //   ).not.to.be.reverted;
    //   const [afterWithdrawTVL] = await router.getStrategiesValue();
    //   expect(afterWithdrawTVL).to.be.closeTo(
    //     initialTVL.sub(sharesValueUsd),
    //     sharesValueUsd.mul(50).div(10000) // 0.5% slippage
    //   );
    // });
  });
  describe("Withdraw from strategies via batchOut", async function () {
    it("should revert with AccessControl unless BatchOut is moderator of admin contract", async function () {
      const receipts = await receiptContract.getTokensOfOwner(
        adminModerator.address
      );

      const shares = await router.calculateSharesFromReceipts(receipts);
      const role = await admin.MODERATOR();
      await expect(
        batchOut
          .connect(adminModerator)
          .scheduleWithdrawal(
            adminModerator.address,
            usdc.address,
            receipts,
            shares
          )
      ).to.be.revertedWith(
        `AccessControl: account ${batchOut.address.toLowerCase()} is missing role ${role.toLowerCase()}`
      );

      // set batchOut as moderator in routerAdmin to redeem receipts
      await admin.connect(adminModerator).grantRole(role, batchOut.address);
    });

    it("should revert when BatchOut is not operator of SharesToken", async function () {
      const receipts = await receiptContract.getTokensOfOwner(
        adminModerator.address
      );
      const shares = await router.calculateSharesFromReceipts(receipts);
      await expect(
        batchOut
          .connect(adminModerator)
          .scheduleWithdrawal(
            adminModerator.address,
            usdc.address,
            receipts,
            shares
          )
      ).to.be.revertedWithCustomError(sharesToken, "CallerIsNotOperator");

      // set batchOut as operator in SharesToken to transfer shares
      await sharesToken.setOperators(router.address, batchOut.address);
    });

    it("should revert when don't provide withdraw fee", async function () {
      // set default withdraw fee settings
      const defaultWithdrawFeeSettings = {
        minFeeInUsd: parseUniform("0.15"),
        maxFeeInUsd: parseUniform("1"),
        feeInBps: 1, // is 0.01% in BPS
      };

      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      const receipts = await receiptContract.getTokensOfOwner(
        adminModerator.address
      );
      const shares = await router.calculateSharesFromReceipts(receipts);

      await expect(
        batchOut
          .connect(adminModerator)
          .scheduleWithdrawal(
            adminModerator.address,
            usdc.address,
            receipts,
            shares
          )
      ).to.be.revertedWithCustomError(batchOut, "WithdrawUnderDepositFeeValue");
    });

    it("should successfuly schedule withdraw from strategies via batchOut", async function () {
      const receipts = await receiptContract.getTokensOfOwner(
        adminModerator.address
      );
      const shares = await router.calculateSharesFromReceipts(receipts);
      const sharesValueUsd = await router.calculateSharesUsdValue(shares);
      const withdrawFee = await batchOut.getWithdrawFeeInBNB(sharesValueUsd);

      await expect(
        batchOut
          .connect(adminModerator)
          .scheduleWithdrawal(
            adminModerator.address,
            usdc.address,
            receipts,
            shares,
            {
              value: withdrawFee,
            }
          )
      ).not.to.be.reverted;

      const currentCycleId = await batchOut.currentCycleId();
      const cycleInfo = await batchOut.cycleInfo(currentCycleId);
      expect(cycleInfo.pendingShareWithdraw).to.be.equal(shares);
      expect(cycleInfo.withdrawRequests).to.be.equal(1);

      const userWithdrawData = await batchOut.userWithdrawStorage(
        currentCycleId,
        adminModerator.address
      );

      expect(userWithdrawData.withdrawStatus).to.be.equal(false);
      expect(userWithdrawData.shareData.token[0]).to.be.equal(usdc.address);
      expect(userWithdrawData.shareData.sharesOrUnits[0]).to.be.equal(shares);
    });

    it("should successfuly withdraw from strategies via batchOut", async function () {
      const currentCycleId = await batchOut.currentCycleId();
      const cycleInfo = await batchOut.cycleInfo(currentCycleId);
      const expectedRecievedUsd = await router.calculateSharesUsdValue(
        cycleInfo.pendingShareWithdraw
      );
      const expectedRecievedUsdc = await convertFromUsdToTokenAmount(
        oracle,
        usdc,
        expectedRecievedUsd
      );
      const initialUserUsdcBalance = await usdc.balanceOf(
        adminModerator.address
      );

      expect(await batchOut.currentCycleId()).to.equal(0);

      await expect(batchOut.withdrawAndDistribute()).not.to.be.reverted;

      expect(await batchOut.currentCycleId()).to.equal(1);
      const userWithdrawData = await batchOut.userWithdrawStorage(
        currentCycleId,
        adminModerator.address
      );
      expect(userWithdrawData.withdrawStatus).to.be.equal(true);

      const finalUserUsdcBalance = await usdc.balanceOf(adminModerator.address);

      expect(finalUserUsdcBalance).to.be.closeTo(
        initialUserUsdcBalance.add(expectedRecievedUsdc),
        expectedRecievedUsdc.mul(50).div(10000) // 0.5% slippage
      );
    });
  });
});
