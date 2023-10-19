const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTokensLiquidityOnPancake,
  setupTestParams,
  deployFakeStrategy,
} = require("./shared/commonSetup");
const {
  provider,
  parseUniform,
  toUniform,
  fromUniform,
  ZERO_BN,
  MAX_BPS,
  create2DeployProxy,
} = require("./utils");

describe("Test BatchOut", function () {
  let owner, nonOwner;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router,
    oracle,
    exchange,
    admin,
    batch,
    receiptContract,
    sharesToken,
    batchOut;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;
  // constants
  const defauldWithdrawWindowTime = 3600;
  const batchOutWithdrawDelta = 500; // 5%
  const initialWithdrawFeeSettings = {
    minFeeInUsd: 0,
    maxFeeInUsd: 0,
    feeInBps: 0,
  };
  const defaultWithdrawFeeSettings = {
    minFeeInUsd: parseUniform("0.15"),
    maxFeeInUsd: parseUniform("1"),
    feeInBps: 1, // is 0.01% in BPS
  };
  const withdrawFeeSettingsWithFixedFee = {
    minFeeInUsd: parseUniform("0.5"),
    maxFeeInUsd: parseUniform("0.5"),
    feeInBps: 0,
  };

  before(async function () {
    [owner, nonOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({
      router,
      oracle,
      exchange,
      admin,
      batch,
      batchOut,
      receiptContract,
      sharesToken,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore());

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode));

    // send some tokens to nonOwner
    await usdc.transfer(nonOwner.address, parseUsdc("100000"));
    await usdt.transfer(nonOwner.address, parseUsdt("100000"));
    await busd.transfer(nonOwner.address, parseBusd("100000"));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, admin, usdc, usdt, busd);

    // setup infinite allowance
    await busd.approve(router.address, ethers.constants.MaxUint256);
    await busd
      .connect(nonOwner)
      .approve(router.address, ethers.constants.MaxUint256);
    await usdc.approve(router.address, ethers.constants.MaxUint256);
    await usdc
      .connect(nonOwner)
      .approve(router.address, ethers.constants.MaxUint256);
    await usdt.approve(router.address, ethers.constants.MaxUint256);
    await usdt
      .connect(nonOwner)
      .approve(router.address, ethers.constants.MaxUint256);

    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(busd);
    await admin.addSupportedToken(usdt);

    // add fake strategies
    await deployFakeStrategy({ batch, router, admin, token: busd });
    await deployFakeStrategy({ batch, router, admin, token: usdc });
    await deployFakeStrategy({ batch, router, admin, token: usdt });

    // owner initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("10000"), "");
    await router.allocateToStrategies();
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  after(async () => {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("#setAddresses", function () {
    it("should revert if not moderator", async function () {
      await expect(
        batchOut
          .connect(nonOwner)
          .setAddresses(
            exchange.address,
            oracle.address,
            router.address,
            receiptContract.address,
            sharesToken.address,
            admin.address
          )
      ).to.be.revertedWithCustomError(batchOut, "NotModerator");
    });

    it("should set addresses", async function () {
      const { proxyContract: tempBatchOut } = await create2DeployProxy({
        create2Deployer,
        ProxyBytecode,
        ContractName: "BatchOut",
        saltAddition: "Temp",
      });
      expect(await tempBatchOut.exchange()).to.be.equal(
        ethers.constants.AddressZero
      );
      expect(await tempBatchOut.oracle()).to.be.equal(
        ethers.constants.AddressZero
      );
      expect(await tempBatchOut.router()).to.be.equal(
        ethers.constants.AddressZero
      );
      expect(await tempBatchOut.receiptContract()).to.be.equal(
        ethers.constants.AddressZero
      );
      expect(await tempBatchOut.sharesToken()).to.be.equal(
        ethers.constants.AddressZero
      );

      await tempBatchOut.setAddresses(
        exchange.address,
        oracle.address,
        router.address,
        receiptContract.address,
        sharesToken.address,
        admin.address
      );

      expect(await tempBatchOut.exchange()).to.be.equal(exchange.address);
      expect(await tempBatchOut.oracle()).to.be.equal(oracle.address);
      expect(await tempBatchOut.router()).to.be.equal(router.address);
      expect(await tempBatchOut.receiptContract()).to.be.equal(
        receiptContract.address
      );
      expect(await tempBatchOut.sharesToken()).to.be.equal(sharesToken.address);
    });
  });

  describe("#setWithdrawFeeSettings", function () {
    it("should be with default settings", async function () {
      const withdrawFeeSettings = await batchOut.withdrawFeeSettings();
      expect(withdrawFeeSettings.minFeeInUsd).to.be.equal(
        initialWithdrawFeeSettings.minFeeInUsd
      );
      expect(withdrawFeeSettings.maxFeeInUsd).to.be.equal(
        initialWithdrawFeeSettings.maxFeeInUsd
      );
      expect(withdrawFeeSettings.feeInBps).to.be.equal(
        initialWithdrawFeeSettings.feeInBps
      );
    });

    it("should revert if not moderator", async function () {
      await expect(
        batchOut
          .connect(nonOwner)
          .setWithdrawFeeSettings(defaultWithdrawFeeSettings)
      ).to.be.revertedWithCustomError(batchOut, "NotModerator");
    });

    it("should revert when if set max withdraw fee exceeds threshold", async function () {
      // withdraw fee threshold is 50 USD
      await expect(
        batchOut.setWithdrawFeeSettings({
          ...defaultWithdrawFeeSettings,
          maxFeeInUsd: parseUniform("51"), // 51 USD
        })
      ).to.be.revertedWithCustomError(
        batchOut,
        "MaxWithdrawFeeExceedsThreshold"
      );
    });

    it("should revert when if set min withdraw fee exceeds max", async function () {
      await expect(
        batchOut.setWithdrawFeeSettings({
          minFeeInUsd: parseUniform("2"),
          maxFeeInUsd: parseUniform("1"),
          feeInBps: 1,
        })
      ).to.be.revertedWithCustomError(batchOut, "MinWithdrawFeeExceedsMax");
    });

    it("should revert when if set withdraw fee percentage exceeds percentage threshold", async function () {
      // deposit fee percentage threshold is 3% in BPS
      await expect(
        batchOut.setWithdrawFeeSettings(
          {
            ...defaultWithdrawFeeSettings,
            feeInBps: 301,
          } // 3,01% feeInBps
        )
      ).to.be.revertedWithCustomError(
        batchOut,
        "WithdrawFeePercentExceedsFeePercentageThreshold"
      );
    });

    it("should revert when fee in BPS is set and max fee in USD is not set", async function () {
      await expect(
        batchOut.setWithdrawFeeSettings({
          minFeeInUsd: parseUniform("0"),
          maxFeeInUsd: parseUniform("0"),
          feeInBps: 1,
        })
      ).to.be.revertedWithCustomError(
        batchOut,
        "NotSetMaxFeeInUsdWhenFeeInBpsIsSet"
      );
    });

    it("should set withdraw settings with correct values", async function () {
      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      const withdrawFeeSettings = await batchOut.withdrawFeeSettings();

      expect(withdrawFeeSettings.minFeeInUsd).to.be.equal(
        defaultWithdrawFeeSettings.minFeeInUsd
      );
      expect(withdrawFeeSettings.maxFeeInUsd).to.be.equal(
        defaultWithdrawFeeSettings.maxFeeInUsd
      );
      expect(withdrawFeeSettings.feeInBps).to.be.equal(
        defaultWithdrawFeeSettings.feeInBps
      );
    });

    it("should set withdraw fee to zero (initial values) once it was not zero", async function () {
      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      await batchOut.setWithdrawFeeSettings(initialWithdrawFeeSettings);

      const withdrawFeeSettings = await batchOut.withdrawFeeSettings();

      expect(withdrawFeeSettings.minFeeInUsd).to.be.equal(
        initialWithdrawFeeSettings.minFeeInUsd
      );
      expect(withdrawFeeSettings.maxFeeInUsd).to.be.equal(
        initialWithdrawFeeSettings.maxFeeInUsd
      );
      expect(withdrawFeeSettings.feeInBps).to.be.equal(
        initialWithdrawFeeSettings.feeInBps
      );
    });

    it("should set withdraw fee settings with correct values with fixed fee", async function () {
      await batchOut.setWithdrawFeeSettings(withdrawFeeSettingsWithFixedFee);

      const withdrawFeeSettings = await batchOut.withdrawFeeSettings();

      expect(withdrawFeeSettings.minFeeInUsd).to.be.equal(
        withdrawFeeSettingsWithFixedFee.minFeeInUsd
      );
      expect(withdrawFeeSettings.maxFeeInUsd).to.be.equal(
        withdrawFeeSettingsWithFixedFee.maxFeeInUsd
      );
      expect(withdrawFeeSettings.feeInBps).to.be.equal(
        withdrawFeeSettingsWithFixedFee.feeInBps
      );
    });
  });

  describe("#getWithdrawFeeInBNB", function () {
    it("should return 0 fee amount when initial deposit settings (no fee)", async function () {
      // set initial withdraw fee settings (zero values)
      await batchOut.setWithdrawFeeSettings(initialWithdrawFeeSettings);
      const amount = parseUniform("20"); // 20 USD

      const feeAmount = await batchOut.getWithdrawFeeInBNB(amount);

      expect(feeAmount).to.be.equal(0);
    });

    it("should return min deposit fee amount when the deposit fee is set as default", async function () {
      // set withdraw fee as default
      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      const amount = parseUniform("0.15"); // 0.15 USD
      const feeAmount = await batchOut.getWithdrawFeeInBNB(amount);

      // BNB price is 200 USD
      // expect that fee amount is the same as the min fee amount (0.15 USD = 0.15 USD / 200 BNB/USD = 0.00075 BNB)
      expect(feeAmount).to.be.equal(
        ethers.utils.parseUnits("0.00075", "ether")
      );
    });

    it("should return max withdraw fee amount when the withdraw fee is set as default", async function () {
      // set withdraw fee as default
      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      const amount = parseUniform("15000"); // 15,000 USD
      const feeAmount = await batchOut.getWithdrawFeeInBNB(amount);

      // expect that fee amount is the same as the max fee amount (1 USD = 1 USD / 200 BNB/USD = 0.005 BNB)
      expect(feeAmount).to.be.equal(ethers.utils.parseUnits("0.005", "ether"));
    });

    it("should return correct withdraw fee amount depends on the fee percentage (0.01%) when the withdraw fee is set as default", async function () {
      // set withdraw fee as default
      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      const amount = parseUniform(6000); // 6,000 USD

      const feeAmount = await batchOut.getWithdrawFeeInBNB(amount);

      // (0.6 USD = 0.6 USD / 200 BNB/USD = 0.003 BNB)
      expect(feeAmount).to.be.equal(ethers.utils.parseUnits("0.003", "ether"));
    });

    it("should return correct withdraw fee amount depends when the withdraw fee is set as fixed", async function () {
      // set deposit fee as fixed (0.5 USD)
      await batchOut.setWithdrawFeeSettings(withdrawFeeSettingsWithFixedFee);

      const amount = parseUniform("700"); // 700 USD

      const feeAmount = await batchOut.getWithdrawFeeInBNB(amount);

      // expect that fee amount is the same as the fixed fee amount (0.5 USD = 0.5 USD / 200 BNB/USD = 0.0025 BNB)
      expect(feeAmount).to.be.equal(ethers.utils.parseUnits("0.0025", "ether"));
    });
  });

  describe("#setWithdrawWindowTime", function () {
    it("should revert if not moderator", async function () {
      await expect(
        batchOut.connect(nonOwner).setWithdrawWindowTime(100)
      ).to.be.revertedWithCustomError(batchOut, "NotModerator");
    });

    it("should set withdrawWindowTime", async function () {
      expect(await batchOut.withdrawWindowTime()).to.be.equal(
        defauldWithdrawWindowTime
      );

      const withdrawWindowTime = 100;
      await batchOut.setWithdrawWindowTime(withdrawWindowTime);

      expect(await batchOut.withdrawWindowTime()).to.be.equal(
        withdrawWindowTime
      );
    });
  });

  describe("#setModerator", function () {
    it("should revert if not moderator", async function () {
      await expect(
        batchOut.connect(nonOwner).setModerator(nonOwner.address)
      ).to.be.revertedWithCustomError(batchOut, "NotModerator");
    });

    it("should revert if moderator is zero address", async function () {
      await expect(
        batchOut.setModerator(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(batchOut, "InvalidModeratorAddress");
    });

    it("should set moderator", async function () {
      expect(await batchOut.moderator()).to.be.equal(owner.address);

      await batchOut.setModerator(nonOwner.address);

      expect(await batchOut.moderator()).to.be.equal(nonOwner.address);
    });
  });

  describe("#scheduleWithdrawal with withdraw fee", function () {
    beforeEach(async function () {
      // set withdraw fee settings
      await batchOut.setWithdrawFeeSettings(defaultWithdrawFeeSettings);

      // deposit nonOwner to use his shares for testing
      await router
        .connect(nonOwner)
        .depositToBatch(busd.address, parseBusd("10000"), "");
      await router.connect(nonOwner).allocateToStrategies();
    });

    it("should revert if deposit fee is not provided", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      await expect(
        batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            nonOwner.address,
            busd.address,
            receiptIds,
            parseUniform("100")
          )
      ).to.be.revertedWithCustomError(batchOut, "WithdrawUnderDepositFeeValue");
    });

    it("should revert if provide not enough deposit fee", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      const shares = parseUniform("100");
      const withdrawFee = await batchOut.getWithdrawFeeInBNB(shares);
      await expect(
        batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            nonOwner.address,
            busd.address,
            receiptIds,
            shares,
            { value: withdrawFee.sub(1) }
          )
      ).to.be.revertedWithCustomError(batchOut, "WithdrawUnderDepositFeeValue");
    });

    it("should successfully schedule withdrawal with withdraw fee", async function () {
      const currentCycleId = await batchOut.currentCycleId();
      const initialBnbContractBalance = await provider.getBalance(
        batchOut.address
      );

      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );

      const shares = parseUniform("100");
      const withdrawFee = await batchOut.getWithdrawFeeInBNB(shares);

      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(
          nonOwner.address,
          busd.address,
          receiptIds,
          shares,
          { value: withdrawFee }
        );

      const finalCycleInfo = await batchOut.cycleInfo(currentCycleId);
      expect(finalCycleInfo.pendingShareWithdraw).to.be.equal(shares);
      expect(finalCycleInfo.withdrawRequests).to.be.equal(1);
      expect(finalCycleInfo.shareWithdrawRequest.token[0]).to.be.equal(
        busd.address
      );

      const finalBnbContractBalance = await provider.getBalance(
        batchOut.address
      );
      expect(
        finalBnbContractBalance.sub(initialBnbContractBalance)
      ).to.be.equal(withdrawFee);
    });

    it("should successfully schedule withdrawal with withdraw fee when provided more than enough deposit fee and leave the rest in the contract", async function () {
      const currentCycleId = await batchOut.currentCycleId();
      const initialBnbContractBalance = await provider.getBalance(
        batchOut.address
      );

      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );

      const shares = parseUniform("100");
      const withdrawFee = await batchOut.getWithdrawFeeInBNB(shares);
      const extraWithdrawFee = parseUniform("0.001"); // 0.001 BNB

      const withdrawFeeWithExtra = withdrawFee.add(extraWithdrawFee);

      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(
          nonOwner.address,
          busd.address,
          receiptIds,
          shares,
          { value: withdrawFeeWithExtra }
        );

      const finalCycleInfo = await batchOut.cycleInfo(currentCycleId);
      expect(finalCycleInfo.pendingShareWithdraw).to.be.equal(shares);
      expect(finalCycleInfo.withdrawRequests).to.be.equal(1);
      expect(finalCycleInfo.shareWithdrawRequest.token[0]).to.be.equal(
        busd.address
      );

      const finalBnbContractBalance = await provider.getBalance(
        batchOut.address
      );
      expect(
        finalBnbContractBalance.sub(initialBnbContractBalance)
      ).to.be.equal(withdrawFeeWithExtra);
    });
  });

  describe("#scheduleWithdrawal", function () {
    before(async function () {
      // deposit nonOwner to use his shares for testing
      await router
        .connect(nonOwner)
        .depositToBatch(busd.address, parseBusd("10000"), "");
      await router.connect(nonOwner).allocateToStrategies();
    });

    it("should revert if withdrawToken not supported", async function () {
      await expect(
        batchOut.scheduleWithdrawal(
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          [],
          parseUniform("0")
        )
      ).to.be.revertedWithCustomError(batchOut, "UnsupportedToken");
    });

    it("should revert if amount is zero", async function () {
      await expect(
        batchOut.scheduleWithdrawal(
          owner.address,
          busd.address,
          [],
          parseUniform("0")
        )
      ).to.be.revertedWithCustomError(batchOut, "AmountNotSpecified");
    });

    it("should revert if caller is not receipt owner", async function () {
      const receiptIDs = await receiptContract.getTokensOfOwner(owner.address);
      await expect(
        batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            nonOwner.address,
            busd.address,
            receiptIDs,
            parseUniform("100")
          )
      ).to.be.revertedWithCustomError(batchOut, "NotReceiptOwner");
    });

    it("should revert if a user provides empty receiptIds and he has no share tokens", async function () {
      const emptyReceiptIds = [];

      const nonOwnerSharesBalance = await sharesToken
        .connect(nonOwner)
        .balanceOf(owner.address);
      expect(nonOwnerSharesBalance).to.be.equal(ZERO_BN);

      await expect(
        batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            owner.address,
            busd.address,
            emptyReceiptIds,
            parseUniform("100")
          )
      ).to.be.revertedWithCustomError(batchOut, "InsufficientShares");
    });

    it("should revert if a user provides empty receiptIds and the user does not have enough share tokens", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      // redeem all shares tokens
      await router.connect(nonOwner).redeemReceiptsToShares(receiptIds);
      const nonOwnerSharesBalance = await sharesToken.balanceOf(
        nonOwner.address
      );
      expect(nonOwnerSharesBalance).to.be.gt(ZERO_BN);

      const emptyReceiptIds = [];
      await expect(
        batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            owner.address,
            busd.address,
            emptyReceiptIds,
            nonOwnerSharesBalance.add(parseUniform("1"))
          )
      ).to.be.revertedWithCustomError(batchOut, "InsufficientShares");
    });

    it("should revert if provide invalid receiptIds", async function () {
      const receiptIds = [9999999];
      await expect(
        batchOut.scheduleWithdrawal(
          owner.address,
          busd.address,
          receiptIds,
          parseUniform("100")
        )
      ).to.be.revertedWith("ERC721: invalid token ID");
    });

    it("should redeem and transfer shares tokens and successfully schedule withdrawal", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(owner.address);
      const calculatedShares = await router.calculateSharesFromReceipts(
        receiptIds
      );

      const currentCycleId = await batchOut.currentCycleId();
      const initialCycleInfo = await batchOut.cycleInfo(currentCycleId);
      const initialSharesUserBalance = await sharesToken.balanceOf(
        owner.address
      );
      const initialSharesContractBalance = await sharesToken.balanceOf(
        batchOut.address
      );

      expect(initialCycleInfo.pendingShareWithdraw).to.be.equal(ZERO_BN);
      expect(initialCycleInfo.withdrawRequests).to.be.equal(ZERO_BN);

      const sharesToWithdraw = parseUniform("100");

      await batchOut.scheduleWithdrawal(
        owner.address,
        busd.address,
        receiptIds,
        sharesToWithdraw
      );

      const finalSharesUserBalance = await sharesToken.balanceOf(owner.address);
      const sharesDiff = finalSharesUserBalance.sub(initialSharesUserBalance);
      expect(sharesDiff).to.be.equal(calculatedShares.sub(sharesToWithdraw));

      const finalSharesContractBalance = await sharesToken.balanceOf(
        batchOut.address
      );
      expect(finalSharesContractBalance).to.be.equal(
        initialSharesContractBalance.add(sharesToWithdraw)
      );

      const finalCycleInfo = await batchOut.cycleInfo(currentCycleId);
      expect(finalCycleInfo.pendingShareWithdraw).to.be.equal(sharesToWithdraw);
      expect(finalCycleInfo.withdrawRequests).to.be.equal(1);
      expect(finalCycleInfo.shareWithdrawRequest.token[0]).to.be.equal(
        busd.address
      );

      const cycleWithdrawAddress = await batchOut.cycleWithdrawAddresses(
        currentCycleId,
        0
      );

      expect(cycleWithdrawAddress).to.be.equal(owner.address);
    });

    it("should successfully schedule withdrawal with empty receiptIds and enough share tokens", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      // redeem all shares tokens
      await router.connect(nonOwner).redeemReceiptsToShares(receiptIds);
      const nonOwnerSharesBalance = await sharesToken.balanceOf(
        nonOwner.address
      );
      expect(nonOwnerSharesBalance).to.be.gt(ZERO_BN);

      const currentCycleId = await batchOut.currentCycleId();
      const initialCycleInfo = await batchOut.cycleInfo(currentCycleId);

      const emptyReceiptIds = [];
      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(
          owner.address,
          busd.address,
          emptyReceiptIds,
          nonOwnerSharesBalance
        );

      const finalCycleInfo = await batchOut.cycleInfo(currentCycleId);

      expect(finalCycleInfo.pendingShareWithdraw).to.be.equal(
        initialCycleInfo.pendingShareWithdraw.add(nonOwnerSharesBalance)
      );
    });
  });

  describe("#executeBatchWithdrawFromStrategyWithSwap", function () {
    beforeEach(async function () {
      await router.depositToBatch(busd.address, parseBusd("1000"), "");
      await router
        .connect(nonOwner)
        .depositToBatch(busd.address, parseBusd("1000"), "");
      await router.allocateToStrategies();
    });

    // TODO: add withdrawWindowTime functionality
    // it("should revert if withdrawWindowTime is not passed", async function () {
    //   await expect(
    //     batchOut.executeBatchWithdrawFromStrategyWithSwap()
    //   ).to.be.revertedWithCustomError(batchOut, "CycleNotClosableYet");
    // });

    it("should revert if no pending share withdraw", async function () {
      await expect(
        batchOut.executeBatchWithdrawFromStrategyWithSwap()
      ).to.be.revertedWithCustomError(batchOut, "CycleNotClosableYet");
    });

    it("should withdraw from strategy to batchOut contract with only one token", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(owner.address);

      const shares = parseUniform("100");
      await batchOut.scheduleWithdrawal(
        owner.address,
        busd.address,
        receiptIds,
        shares
      );

      const sharesInUsd = await router.calculateSharesUsdValue(shares);
      const calculatedBusdAmount = await getTokenAmount(
        busd.address,
        sharesInUsd
      );

      const currentCycleId = await batchOut.currentCycleId();
      const initialCycleInfo = await batchOut.cycleInfo(currentCycleId);
      const initialBusdContractBalance = await busd.balanceOf(batchOut.address);
      const initialSharesContractBalance = await sharesToken.balanceOf(
        batchOut.address
      );

      expect(initialCycleInfo.pendingShareWithdraw).to.be.equal(shares);

      await batchOut.executeBatchWithdrawFromStrategyWithSwap();

      const finalBusdContractBalance = await busd.balanceOf(batchOut.address);
      const busdDiff = finalBusdContractBalance.sub(initialBusdContractBalance);
      const calculatedBusdDelta = calculatedBusdAmount
        .mul(batchOutWithdrawDelta)
        .div(MAX_BPS); // 0.2% additional because of compounding profit
      expect(busdDiff).to.be.closeTo(
        calculatedBusdAmount.add(calculatedBusdDelta),
        calculatedBusdDelta
      );

      const finalSharesContractBalance = await sharesToken.balanceOf(
        batchOut.address
      );
      expect(finalSharesContractBalance).to.be.equal(
        initialSharesContractBalance.sub(shares)
      );

      const finalCycleInfo = await batchOut.cycleInfo(currentCycleId);
      expect(finalCycleInfo.pendingShareWithdraw).to.be.equal(ZERO_BN);
    });

    it("should withdraw from strategy to batchOut contract with multiple tokens", async function () {
      const ownerReceiptIds = await receiptContract.getTokensOfOwner(
        owner.address
      );

      // schedule withdrawal for busd
      const sharesToWithdrawBusd = parseUniform("150");
      await batchOut.scheduleWithdrawal(
        owner.address,
        busd.address,
        ownerReceiptIds,
        sharesToWithdrawBusd
      );
      const sharesBusdInUsd = await router.calculateSharesUsdValue(
        sharesToWithdrawBusd
      );
      const calculatedBusdAmount = await getTokenAmount(
        busd.address,
        sharesBusdInUsd
      );

      // schedule withdrawal for usdc
      const sharesToWithdrawUsdc = parseUniform("250");
      await batchOut.scheduleWithdrawal(
        owner.address,
        usdc.address,
        [],
        sharesToWithdrawUsdc
      );
      const sharesUsdcInUsd = await router.calculateSharesUsdValue(
        sharesToWithdrawUsdc
      );
      const calculatedUsdcAmount = await getTokenAmount(
        usdc.address,
        sharesUsdcInUsd
      );

      const nonOwnerReceiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      // schedule withdrawal for usdt
      const sharesToWithdrawUsdt = parseUniform("200");
      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(
          nonOwner.address,
          usdt.address,
          nonOwnerReceiptIds,
          sharesToWithdrawUsdt
        );
      const sharesUsdtInUsd = await router.calculateSharesUsdValue(
        sharesToWithdrawUsdt
      );
      const calculatedUsdtAmount = await getTokenAmount(
        usdt.address,
        sharesUsdtInUsd
      );

      const currentCycleId = await batchOut.currentCycleId();
      const initialCycleInfo = await batchOut.cycleInfo(currentCycleId);
      const initialBusdContractBalance = await busd.balanceOf(batchOut.address);
      const initialUsdcContractBalance = await usdc.balanceOf(batchOut.address);
      const initialUsdtContractBalance = await usdt.balanceOf(batchOut.address);
      const initialSharesContractBalance = await sharesToken.balanceOf(
        batchOut.address
      );

      const totalSharesAmount = sharesToWithdrawBusd
        .add(sharesToWithdrawUsdc)
        .add(sharesToWithdrawUsdt);

      expect(initialCycleInfo.pendingShareWithdraw).to.be.equal(
        totalSharesAmount
      );
      // expect that withdrawRequests is 2 because there are 2 different users addresses (owner and nonOwner)
      expect(initialCycleInfo.withdrawRequests).to.be.equal(2);

      await batchOut.executeBatchWithdrawFromStrategyWithSwap();

      const finalBusdContractBalance = await busd.balanceOf(batchOut.address);
      const busdDiff = finalBusdContractBalance.sub(initialBusdContractBalance);
      const calculatedBusdDelta = calculatedBusdAmount
        .mul(batchOutWithdrawDelta)
        .div(MAX_BPS);
      expect(busdDiff).to.be.closeTo(calculatedBusdAmount, calculatedBusdDelta);

      const finalUsdcContractBalance = await usdc.balanceOf(batchOut.address);
      const usdcDiff = finalUsdcContractBalance.sub(initialUsdcContractBalance);
      const calculatedUsdcDelta = calculatedUsdcAmount
        .mul(batchOutWithdrawDelta)
        .div(MAX_BPS);
      expect(usdcDiff).to.be.closeTo(calculatedUsdcAmount, calculatedUsdcDelta);

      const finalUsdtContractBalance = await usdt.balanceOf(batchOut.address);
      const usdtDiff = finalUsdtContractBalance.sub(initialUsdtContractBalance);
      const calculatedUsdtDelta = calculatedUsdtAmount
        .mul(batchOutWithdrawDelta)
        .div(MAX_BPS);
      expect(usdtDiff).to.be.closeTo(calculatedUsdtAmount, calculatedUsdtDelta);

      const finalSharesContractBalance = await sharesToken.balanceOf(
        batchOut.address
      );
      expect(finalSharesContractBalance).to.be.equal(
        initialSharesContractBalance.sub(totalSharesAmount)
      );

      const finalCycleInfo = await batchOut.cycleInfo(currentCycleId);
      expect(finalCycleInfo.pendingShareWithdraw).to.be.equal(ZERO_BN);
    });
  });

  describe("#withdrawFulfill", function () {
    beforeEach(async function () {
      await router.depositToBatch(busd.address, parseBusd("1000"), "");
      await router
        .connect(nonOwner)
        .depositToBatch(busd.address, parseBusd("1000"), "");
      await router.allocateToStrategies();
    });

    it("should revert if no withdrawal requests", async function () {
      await expect(
        batchOut.withdrawFulfill(9999)
      ).to.be.revertedWithCustomError(batchOut, "AllWithdrawalsFulfilled");
    });

    it("should withdraw from strategy to batchOut contract with only one token", async function () {
      const currentCycleId = await batchOut.currentCycleId();
      const initialBusdUserBalance = await busd.balanceOf(nonOwner.address);
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      const shares = parseUniform("100");
      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(nonOwner.address, busd.address, receiptIds, shares);

      const initialBusdbatchOutBalance = await busd.balanceOf(batchOut.address);
      expect(initialBusdbatchOutBalance).to.be.equal(ZERO_BN);

      await batchOut.executeBatchWithdrawFromStrategyWithSwap();

      const withdrawBusdBatchOutBalance = await busd.balanceOf(
        batchOut.address
      );
      expect(withdrawBusdBatchOutBalance).to.be.gt(ZERO_BN);

      await batchOut.withdrawFulfill(currentCycleId);

      const finalBusdbatchOutBalance = await busd.balanceOf(batchOut.address);
      expect(finalBusdbatchOutBalance).to.be.equal(ZERO_BN);

      const finalBusdUserBalance = await busd.balanceOf(nonOwner.address);
      expect(finalBusdUserBalance.sub(initialBusdUserBalance)).to.be.equal(
        withdrawBusdBatchOutBalance
      );
    });

    it("should withdraw from strategy to batchOut contract with multiple tokens", async function () {
      const currentCycleId = await batchOut.currentCycleId();
      const nonOwnerReceiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      const ownerReceiptIds = await receiptContract.getTokensOfOwner(
        owner.address
      );

      // schedule withdrawal for busd for nonOwner
      const initialBusdNonOwnerBalance = await busd.balanceOf(nonOwner.address);
      const sharesToWithdrawBusd = parseUniform("150");
      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(
          nonOwner.address,
          busd.address,
          nonOwnerReceiptIds,
          sharesToWithdrawBusd
        );

      // schedule withdrawal for usdc for owner
      const initialUsdcOwnerBalance = await usdc.balanceOf(owner.address);
      const sharesToWithdrawUsdc = parseUniform("250");
      await batchOut.scheduleWithdrawal(
        owner.address,
        usdc.address,
        ownerReceiptIds,
        sharesToWithdrawUsdc
      );

      // schedule withdrawal for usdt for owner
      const initialUsdtOwnerBalance = await usdt.balanceOf(owner.address);
      const sharesToWithdrawUsdt = parseUniform("200");
      await batchOut.scheduleWithdrawal(
        owner.address,
        usdt.address,
        [],
        sharesToWithdrawUsdt
      );

      const initialBusdBatchOutBalance = await busd.balanceOf(batchOut.address);
      expect(initialBusdBatchOutBalance).to.be.equal(ZERO_BN);
      const initialUsdcBatchOutBalance = await usdc.balanceOf(batchOut.address);
      expect(initialUsdcBatchOutBalance).to.be.equal(ZERO_BN);
      const initialUsdtBatchOutBalance = await usdt.balanceOf(batchOut.address);
      expect(initialUsdtBatchOutBalance).to.be.equal(ZERO_BN);

      await batchOut.executeBatchWithdrawFromStrategyWithSwap();

      const withdrawBusdBatchOutBalance = await busd.balanceOf(
        batchOut.address
      );
      expect(withdrawBusdBatchOutBalance).to.be.gt(ZERO_BN);
      const withdrawUsdcBatchOutBalance = await usdc.balanceOf(
        batchOut.address
      );
      expect(withdrawUsdcBatchOutBalance).to.be.gt(ZERO_BN);
      const withdrawUsdtBatchOutBalance = await usdt.balanceOf(
        batchOut.address
      );
      expect(withdrawUsdtBatchOutBalance).to.be.gt(ZERO_BN);

      await batchOut.withdrawFulfill(currentCycleId);

      const finalBusdbatchOutBalance = await busd.balanceOf(batchOut.address);
      expect(finalBusdbatchOutBalance).to.be.equal(ZERO_BN);
      const finalUsdcBatchOutBalance = await usdc.balanceOf(batchOut.address);
      expect(finalUsdcBatchOutBalance).to.be.equal(ZERO_BN);
      const finalUsdtBatchOutBalance = await usdt.balanceOf(batchOut.address);
      expect(finalUsdtBatchOutBalance).to.be.equal(ZERO_BN);

      const finalBusdNonOwnerBalance = await busd.balanceOf(nonOwner.address);
      expect(
        finalBusdNonOwnerBalance.sub(initialBusdNonOwnerBalance)
      ).to.be.equal(withdrawBusdBatchOutBalance);
      const finalUsdcOwnerBalance = await usdc.balanceOf(owner.address);
      expect(finalUsdcOwnerBalance.sub(initialUsdcOwnerBalance)).to.be.equal(
        withdrawUsdcBatchOutBalance
      );
      const finalUsdtOwnerBalance = await usdt.balanceOf(owner.address);
      expect(finalUsdtOwnerBalance.sub(initialUsdtOwnerBalance)).to.be.equal(
        withdrawUsdtBatchOutBalance
      );
    });

    it("should revert if withdrawFulfill is called twice with the same cycleId", async function () {
      const currentCycleId = await batchOut.currentCycleId();
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );
      const shares = parseUniform("100");
      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(nonOwner.address, busd.address, receiptIds, shares);

      await batchOut.withdrawAndDistribute();

      await expect(
        batchOut.withdrawFulfill(currentCycleId)
      ).to.be.revertedWithCustomError(batchOut, "AllWithdrawalsFulfilled");
    });
  });

  describe("#getNotFulfilledCycleIds", function () {
    beforeEach(async function () {
      await router.depositToBatch(busd.address, parseBusd("1000"), "");
      await router
        .connect(nonOwner)
        .depositToBatch(busd.address, parseBusd("1000"), "");
      await router.allocateToStrategies();
    });

    it("should return empty array if no withdrawal requests", async function () {
      const notFulfilledCycleIds = await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIds.length).to.be.equal(0);
    });

    it("should return not fulfilled cycle ids", async function () {
      const firstCycleId = await batchOut.currentCycleId();
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );

      const cyclesToCheck = 10;
      const shares = parseUniform("10");
      let recieptsUsed = false;
      for (let i = 0; i < cyclesToCheck; i++) {
        await batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            nonOwner.address,
            busd.address,
            recieptsUsed ? [] : receiptIds,
            shares
          );

        recieptsUsed = true;

        await batchOut.executeBatchWithdrawFromStrategyWithSwap();
      }

      const notFulfilledCycleIds = await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIds.length).to.be.equal(cyclesToCheck);
      expect(notFulfilledCycleIds[0]).to.be.equal(firstCycleId);
    });

    it("should returnt not fulfilled cycle ids without instanly fulfilling with withdrawAndDistribute method", async function () {
      const receiptIds = await receiptContract.getTokensOfOwner(
        nonOwner.address
      );

      const cyclesToCheck = 2;
      const shares = parseUniform("10");
      let recieptsUsed = false;
      for (let i = 0; i < cyclesToCheck; i++) {
        await batchOut
          .connect(nonOwner)
          .scheduleWithdrawal(
            nonOwner.address,
            busd.address,
            recieptsUsed ? [] : receiptIds,
            shares
          );

        recieptsUsed = true;

        await batchOut.executeBatchWithdrawFromStrategyWithSwap();
      }

      const currentCycleId = await batchOut.currentCycleId();

      await batchOut
        .connect(nonOwner)
        .scheduleWithdrawal(
          nonOwner.address,
          busd.address,
          recieptsUsed ? [] : receiptIds,
          shares
        );

      await batchOut.withdrawAndDistribute();

      const notFulfilledCycleIds = await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIds.length).to.be.equal(cyclesToCheck);
      expect(notFulfilledCycleIds).to.not.include(currentCycleId);
    });
  });

  describe("#setMaxSlippageToWithdrawInBps", function () {
    it("non owner should not be able to set the max slippage", async function () {
      const newMaxSlippage = 25;
      await expect(
        batchOut.connect(nonOwner).setMaxSlippageToWithdrawInBps(newMaxSlippage)
      ).to.be.revertedWithCustomError(batchOut, "NotModerator");
    });

    it("owner should be able to set the max slippage", async function () {
      const newMaxSlippage = 25;
      await batchOut.setMaxSlippageToWithdrawInBps(newMaxSlippage);

      expect(await batchOut.maxSlippageToWithdrawInBps()).to.equal(
        newMaxSlippage
      );
    });

    it("should be able to change value after it is already changed", async function () {
      let newMaxSlippage = 25;
      await batchOut.setMaxSlippageToWithdrawInBps(newMaxSlippage);
      expect(await batchOut.maxSlippageToWithdrawInBps()).to.equal(
        newMaxSlippage
      );

      newMaxSlippage = 333;
      await batchOut.setMaxSlippageToWithdrawInBps(newMaxSlippage);
      expect(await batchOut.maxSlippageToWithdrawInBps()).to.equal(
        newMaxSlippage
      );
    });

    it("shouldn't be able to set above hardcoded limit", async function () {
      const MAX_SLIPPAGE_TO_WITHDRAW_IN_BPS = 1000;
      let newMaxSlippage = MAX_SLIPPAGE_TO_WITHDRAW_IN_BPS + 1;
      await expect(
        batchOut.setMaxSlippageToWithdrawInBps(newMaxSlippage)
      ).to.be.revertedWithCustomError(batchOut, "NewValueIsAboveMaxBps");
    });
  });

  // amount is in token decimals
  // returns value in uniform decimals
  const getTokenValue = async (tokenAddress, amount) => {
    const [price, priceDecimals] = await oracle.getTokenUsdPrice(tokenAddress);
    const pricePrecision = ethers.BigNumber.from(10).pow(priceDecimals);

    return toUniform(amount.mul(price).div(pricePrecision), tokenAddress);
  };

  // value is in uniform decimals
  // returns amount in token decimals
  const getTokenAmount = async (tokenAddress, value) => {
    const [price, priceDecimals] = await oracle.getTokenUsdPrice(tokenAddress);
    const pricePrecision = ethers.BigNumber.from(10).pow(priceDecimals);

    return await fromUniform(
      value.mul(pricePrecision).div(price),
      tokenAddress
    );
  };
});
