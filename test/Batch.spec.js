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
  deployProxyIdleStrategy,
  toUniform,
  fromUniform,
} = require("./utils");

describe("Test Batch", function () {
  let owner, nonReceiptOwner;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, admin, batch, receiptContract, sharesToken;
  // deposit settings
  let initialDepositFeeSettings,
    defaultDepositFeeSettings,
    depositFeeSettingsWithFixedFee;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({
      router,
      oracle,
      exchange,
      admin,
      batch,
      receiptContract,
      sharesToken,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore());

    initialDepositFeeSettings = {
      minFeeInUsd: 0,
      maxFeeInUsd: 0,
      feeInBps: 0,
    };

    defaultDepositFeeSettings = {
      minFeeInUsd: parseUniform("0.15"),
      maxFeeInUsd: parseUniform("1"),
      feeInBps: 1, // is 0.01% in BPS
    };

    depositFeeSettingsWithFixedFee = {
      minFeeInUsd: parseUniform("0.5"),
      maxFeeInUsd: parseUniform("0.5"),
      feeInBps: 0,
    };

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, admin, usdc, usdt, busd);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));
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

  describe("#setDepositFeeSettings", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: busd });
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdt });

      // admin initial deposit to set initial shares and pps
      const depositFeeAmount = await batch.getDepositFeeInBNB(parseBusd("1"));
      await router.depositToBatch(busd.address, parseBusd("1"), "", {
        value: "0",
      });
      await router.allocateToStrategies();
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert when if set max deposit fee exceeds threshold", async function () {
      // deposit fee threshold is 50 USD
      await expect(
        batch.setDepositFeeSettings([
          defaultDepositFeeSettings.minFeeInUsd,
          parseUniform("51"), // 51 USD
          defaultDepositFeeSettings.feeInBps,
        ])
      ).to.be.revertedWithCustomError(batch, "MaxDepositFeeExceedsThreshold");
    });

    it("should revert when if set min deposit fee exceeds max", async function () {
      await expect(
        batch.setDepositFeeSettings([
          parseUniform("1"), // minFeeInUsd
          parseUniform("0.5"), // maxFeeInUsd
          defaultDepositFeeSettings.feeInBps,
        ])
      ).to.be.revertedWithCustomError(batch, "MinDepositFeeExceedsMax");
    });

    it("should revert when if set deposit fee percentage exceeds percentage threshold", async function () {
      // deposit fee percentage threshold is 3% in BPS
      await expect(
        batch.setDepositFeeSettings(
          [
            defaultDepositFeeSettings.minFeeInUsd,
            defaultDepositFeeSettings.maxFeeInUsd,
            "301",
          ] // 3,01% feeInBps
        )
      ).to.be.revertedWithCustomError(
        batch,
        "DepositFeePercentExceedsFeePercentageThreshold"
      );
    });

    it("should revert when maxFeeInUsd is 0 and feeInBps is set", async function () {
      await expect(
        batch.setDepositFeeSettings([0, 0, 1])
      ).to.be.revertedWithCustomError(
        batch,
        "NotSetMaxFeeInStableWhenFeeInBpsIsSet"
      );
    });

    it("should set deposit fee to zero (initial values) once it was not zero", async function () {
      // set deposit fee as default

      await batch.setDepositFeeSettings([
        defaultDepositFeeSettings.minFeeInUsd,
        defaultDepositFeeSettings.maxFeeInUsd,
        defaultDepositFeeSettings.feeInBps,
      ]);
      // set deposit fee to zero
      await batch.setDepositFeeSettings([
        initialDepositFeeSettings.minFeeInUsd,
        initialDepositFeeSettings.maxFeeInUsd,
        initialDepositFeeSettings.feeInBps,
      ]);

      const batchDepositFeeSettings = await batch.depositFeeSettings();

      // check that deposit fee set as initial values
      expect(batchDepositFeeSettings.minFeeInUsd).to.equal(
        initialDepositFeeSettings.minFeeInUsd
      );
      expect(batchDepositFeeSettings.maxFeeInUsd).to.equal(
        initialDepositFeeSettings.maxFeeInUsd
      );
      expect(batchDepositFeeSettings.feeInBps).to.equal(
        initialDepositFeeSettings.feeInBps
      );
    });

    it("should set deposit settings with correct values", async function () {
      await batch.setDepositFeeSettings([
        defaultDepositFeeSettings.minFeeInUsd,
        defaultDepositFeeSettings.maxFeeInUsd,
        defaultDepositFeeSettings.feeInBps,
      ]);

      const batchDepositFeeSettings = await batch.depositFeeSettings();

      expect(batchDepositFeeSettings.minFeeInUsd).to.equal(
        defaultDepositFeeSettings.minFeeInUsd
      );
      expect(batchDepositFeeSettings.maxFeeInUsd).to.equal(
        defaultDepositFeeSettings.maxFeeInUsd
      );
      expect(batchDepositFeeSettings.feeInBps).to.equal(
        defaultDepositFeeSettings.feeInBps
      );
    });

    it("should set deposit settings with correct values with fixed fee", async function () {
      await batch.setDepositFeeSettings(depositFeeSettingsWithFixedFee);

      const batchDepositFeeSettings = await batch.depositFeeSettings();

      expect(batchDepositFeeSettings.minFeeInUsd).to.equal(
        depositFeeSettingsWithFixedFee.minFeeInUsd
      );
      expect(batchDepositFeeSettings.maxFeeInUsd).to.equal(
        depositFeeSettingsWithFixedFee.minFeeInUsd
      );
      expect(batchDepositFeeSettings.feeInBps).to.equal(
        depositFeeSettingsWithFixedFee.feeInBps
      );
    });
  });

  describe("deposit without deposit fee", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: busd });
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"), "");
      await router.allocateToStrategies();
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert depositToBatch no allowance", async function () {
      await busd.approve(router.address, 0);
      await expect(router.depositToBatch(busd.address, parseBusd("100"), "")).to
        .be.reverted;
    });

    it("should revert depositToBatch if token unsupported", async function () {
      await expect(
        router.depositToBatch(router.address, parseBusd("100"), "")
      ).to.be.revertedWithCustomError(batch, "UnsupportedToken");
    });

    it("should fire Deposit event with exact values (without fee) after deposit to the batch", async function () {
      const amount = parseBusd("100");

      await expect(router.depositToBatch(busd.address, amount, ""))
        .to.emit(router, "Deposit")
        .withArgs(owner.address, busd.address, amount, 0, "");
    });

    it("should depositToBatch create receipt with correct values", async function () {
      let depositAmount = parseBusd("100");
      await router.depositToBatch(busd.address, depositAmount, "");

      let newReceipt = await receiptContract.getReceipt(1);
      expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
      expect(newReceipt.token).to.be.equal(busd.address);
      expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
      expect(newReceipt.cycleId).to.be.equal(1);
      expect(await busd.balanceOf(batch.address)).to.be.equal(depositAmount);
    });
  });

  describe("deposit with fee", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: busd });
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"), "");
      await router.allocateToStrategies();

      // set deposit fee
      await batch.setDepositFeeSettings(defaultDepositFeeSettings);
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should fire Deposit event with exact values (with fee) after deposit", async function () {
      // Set price 1 BUSD = 1 USD
      await oracle.setPrice(busd.address, parseBusd("1"));
      const amount = parseBusd("7000");
      // Get Deposit Fee in BNB
      const depositFeeAmount = await batch.getDepositFeeInBNB(
        ethers.utils.parseUnits("7000", "ether")
      );

      await expect(
        router.depositToBatch(busd.address, amount, "", {
          value: depositFeeAmount,
        })
      )
        .to.emit(router, "Deposit")
        .withArgs(owner.address, busd.address, amount, depositFeeAmount, "");
    });

    it("should deposit tokens with min deposit fee and set correct values to a receipt", async function () {
      // Set price 1 BUSD = 1 USD
      await oracle.setPrice(busd.address, parseBusd("1"));

      const amountDeposited = parseBusd("100");

      // Get Deposit Fee in BNB
      const depositFeeAmount = await batch.getDepositFeeInBNB(
        ethers.utils.parseUnits("100", "ether")
      );
      await router.depositToBatch(busd.address, amountDeposited, "", {
        value: depositFeeAmount,
      });

      // expected values
      const depositAmountUniform = await toUniform(
        amountDeposited,
        busd.address
      );

      // Check receipt
      const newReceipt = await receiptContract.getReceipt(1);
      expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
      expect(newReceipt.token).to.be.equal(busd.address);
      expect(newReceipt.tokenAmountUniform).to.be.equal(
        await toUniform(amountDeposited, busd.address)
      );

      expect(newReceipt.cycleId).to.be.equal(1);

      // Check deposited amount and deposit fee
      const batchBalanceAfter = await busd.balanceOf(batch.address);
      const feeAddress = batch.address;

      const treasuryBalanceAfter = await provider.getBalance(feeAddress);

      expect(batchBalanceAfter).to.be.equal(amountDeposited);
      expect(treasuryBalanceAfter).to.be.equal(depositFeeAmount);
    });
  });

  describe("deposit in other tokens than strategy tokens", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    beforeEach(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);

      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdc });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"), "");
      await router.allocateToStrategies();
    });

    afterEach(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should depositToBatch create receipt with correct values", async function () {
      let depositAmount = parseBusd("100");
      await router.depositToBatch(busd.address, depositAmount, "");

      let newReceipt = await receiptContract.getReceipt(1);
      expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
      expect(newReceipt.token).to.be.equal(busd.address);
      expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
      expect(newReceipt.cycleId).to.be.equal(1);
      expect(await busd.balanceOf(batch.address)).to.be.equal(depositAmount);
    });
  });

  describe("#getDepositFeeInBNB", function () {
    it("should return 0 fee amount when initial deposit settings (no fee)", async function () {
      // set initial deposit fee settings (zero values)
      await batch.setDepositFeeSettings([
        initialDepositFeeSettings.minFeeInUsd,
        initialDepositFeeSettings.maxFeeInUsd,
        initialDepositFeeSettings.feeInBps,
      ]);
      const amount = await toUniform("20", usdc.address); // 20 USDC

      const feeAmount = await batch.getDepositFeeInBNB(amount);

      expect(feeAmount).to.be.equal(0);
    });

    it("should return min deposit fee amount when the deposit fee is set as default", async function () {
      // set deposit fee as default
      await batch.setDepositFeeSettings(defaultDepositFeeSettings);
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const amount = ethers.utils.parseUnits("20", "ether"); // 20 USDC

      const feeAmount = await batch.getDepositFeeInBNB(amount);

      // expect that fee amount is the same as the min fee amount (0.15 USD = 0.15 USDT)
      // 0.15 / 200 = 0.00075
      expect(feeAmount).to.be.equal(
        ethers.utils.parseUnits("0.00075", "ether")
      );
    });

    it("should return max deposit fee amount when the deposit fee is set as default", async function () {
      // set deposit fee as default
      await batch.setDepositFeeSettings(defaultDepositFeeSettings);
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const amount = ethers.utils.parseUnits("15000", "ether"); // 15,000 USDT
      const feeAmount = await batch.getDepositFeeInBNB(amount);

      // expect that fee amount is the same as the max fee amount (1 USD = 1 USDT) / 0.005 BNB
      expect(feeAmount).to.be.equal(ethers.utils.parseUnits("0.005", "ether"));
    });

    it("should return correct deposit fee amount depends on the fee percentage (0.01%) when the deposit fee is set as default", async function () {
      // set deposit fee as default
      await batch.setDepositFeeSettings(defaultDepositFeeSettings);
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const amount = ethers.utils.parseUnits("6000", "ether"); // 6,000 USDT

      const feeAmount = await batch.getDepositFeeInBNB(amount);

      // (0.6 USD = 0.6 USDT = 0.01% of 6,000 USDT) - 0.6 / 200 = 0.003 BNB
      expect(feeAmount).to.be.equal(ethers.utils.parseUnits("0.003", "ether"));
    });

    it("should return correct deposit fee amount depends when the deposit fee is set as fixed", async function () {
      // set deposit fee as fixed (0.5 USD)
      await batch.setDepositFeeSettings(depositFeeSettingsWithFixedFee);
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const amount = ethers.utils.parseUnits("700", "ether"); // 700 USDT

      const feeAmount = await batch.getDepositFeeInBNB(amount);

      // expect that fee amount is the same as the fixed fee amount (0.5 USD = 0.5 USDT) - 0.5/200 = 0.0025
      expect(feeAmount).to.be.equal(ethers.utils.parseUnits("0.0025", "ether"));
    });
  });

  describe("getBatchTotalUsdValue", function () {
    it("happy paths: 1 supported token", async function () {
      await oracle.setPrice(busd.address, parseBusd("0.5"));

      // setup supported tokens
      await admin.addSupportedToken(busd);
      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: busd });

      await router.depositToBatch(busd.address, parseBusd("100.0"), "");
      let { totalBalance, balances } = await router.getBatchValueUsd();
      expect(totalBalance).to.be.equal(parseUniform("50"));
      expect(balances.toString()).to.be.equal(`${parseUniform("50")}`);
    });

    it("3 supported token", async function () {
      await oracle.setPrice(busd.address, parseBusd("0.9"));
      await oracle.setPrice(usdc.address, parseUsdc("0.9"));
      await oracle.setPrice(usdt.address, parseUsdt("1.1"));

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: busd });
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdt });

      await router.depositToBatch(busd.address, parseBusd("100.0"), "");
      await router.depositToBatch(usdc.address, parseUsdc("100.0"), "");
      await router.depositToBatch(usdt.address, parseUsdt("100.0"), "");

      let { totalBalance, balances } = await router.getBatchValueUsd();
      // 0.9 + 0.9 + 1.1 = 2.9
      expect(totalBalance).to.be.equal(parseUniform("290"));
      expect(balances.toString()).to.be.equal(
        `${parseUniform("90")},${parseUniform("90")},${parseUniform("110")}`
      );
    });
  });

  describe("#getSupportedTokensWithPriceInUsd", function () {
    it("0 supported tokens", async function () {
      let supportedTokenPrices = await batch.getSupportedTokensWithPriceInUsd();

      expect(supportedTokenPrices.length).to.be.equal(0);
    });

    it("1 supported token", async function () {
      let price = parseBusd("0.5");
      await oracle.setPrice(busd.address, price);
      let priceDecimals = (await oracle.getTokenUsdPrice(busd.address))
        .decimals;
      // setup supported tokens
      await admin.addSupportedToken(busd);

      let supportedTokenPrices = await batch.getSupportedTokensWithPriceInUsd();

      expect(supportedTokenPrices.length).to.be.equal(1);
      expect(supportedTokenPrices[0].price).to.be.equal(price);
      expect(supportedTokenPrices[0].token).to.be.equal(busd.address);
      expect(supportedTokenPrices[0].priceDecimals).to.be.equal(priceDecimals);
    });

    it("3 supported token", async function () {
      let testData = [
        {
          token: usdc,
          price: parseUsdc("0.7"),
          priceDecimals: await usdc.decimals(),
        },
        {
          token: busd,
          price: parseBusd("0.5"),
          priceDecimals: await busd.decimals(),
        },
        {
          token: usdt,
          price: parseUsdt("0.8"),
          priceDecimals: await usdt.decimals(),
        },
      ];

      for (let i = 0; i < testData.length; i++) {
        await oracle.setPrice(testData[i].token.address, testData[i].price);
      }

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      let supportedTokenPrices = await batch.getSupportedTokensWithPriceInUsd();

      expect(supportedTokenPrices.length).to.be.equal(3);

      for (let i = 0; i < testData.length; i++) {
        expect(supportedTokenPrices[i].price).to.be.equal(testData[i].price);
        expect(supportedTokenPrices[i].token).to.be.equal(
          testData[i].token.address
        );
        expect(supportedTokenPrices[i].priceDecimals).to.be.equal(
          testData[i].priceDecimals
        );
      }
    });
  });

  describe("withdraw", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ batch, router, admin, token: busd });
      await deployFakeStrategy({ batch, router, admin, token: usdc });
      await deployFakeStrategy({ batch, router, admin, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"), "");
      await router.allocateToStrategies();
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("shouldn't be able to withdraw receipt that doesn't belong to you", async function () {
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");
      await expect(
        router.connect(nonReceiptOwner).withdrawFromBatch([1])
      ).to.be.revertedWithCustomError(batch, "NotReceiptOwner");
    });

    it("should burn receipts when withdraw whole amount noted in it", async function () {
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");

      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      expect(receipts.toString()).to.be.eq("1,0");

      await router.withdrawFromBatch([1]);

      receipts = await receiptContract.getTokensOfOwner(owner.address);
      expect(receipts.toString()).to.be.eq("0");
    });

    it("should withdraw whole amount", async function () {
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");

      let oldBalance = await usdc.balanceOf(owner.address);
      await router.withdrawFromBatch([1]);
      let newBalance = await usdc.balanceOf(owner.address);

      expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
    });

    it("should withdraw whole amount without deposit fee", async function () {
      // set deposit fee
      await batch.setDepositFeeSettings(defaultDepositFeeSettings);

      const value = parseUniform("100"); // 100 USD

      const depositFeeAmount = await batch.getDepositFeeInBNB(value);
      await router.depositToBatch(usdt.address, parseUsdt("100"), "", {
        value: depositFeeAmount,
      });

      let oldBalance = await usdt.balanceOf(owner.address);
      await router.withdrawFromBatch([1]);
      let newBalance = await usdt.balanceOf(owner.address);
      expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdt("100"));
    });

    it("should withdraw two receipts and receive tokens noted in them", async function () {
      await router.depositToBatch(busd.address, parseBusd("100"), "");
      await router.depositToBatch(usdt.address, parseUsdt("100"), "");

      // WITHDRAW PART
      oldBalance = await usdt.balanceOf(owner.address);
      oldBalance2 = await busd.balanceOf(owner.address);
      await router.withdrawFromBatch([1, 2]);
      newBalance = await usdt.balanceOf(owner.address);
      newBalance2 = await busd.balanceOf(owner.address);

      expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdt("100"));
      expect(newBalance2.sub(oldBalance2)).to.be.equal(parseBusd("100"));
    });
  });

  describe("#setSupportedToken", function () {
    it("should add supported token", async function () {
      await admin.setSupportedToken(
        usdt.address,
        true,
        usdt.idleStrategy.address
      );
      expect((await router.getSupportedTokens()).toString()).to.be.equal(
        `${usdt.address}`
      );
    });

    it("should be idempotent", async function () {
      await admin.setSupportedToken(
        usdt.address,
        true,
        usdt.idleStrategy.address
      );
      await admin.setSupportedToken(
        usdt.address,
        false,
        ethers.constants.AddressZero
      );
      await admin.setSupportedToken(
        usdt.address,
        true,
        usdt.idleStrategy.address
      );
      expect((await router.getSupportedTokens()).toString()).to.be.equal(
        `${usdt.address}`
      );
    });

    it("should revert when adding the same token twice", async function () {
      await admin.setSupportedToken(
        usdt.address,
        true,
        usdt.idleStrategy.address
      );
      await expect(
        admin.setSupportedToken(usdt.address, true, usdt.idleStrategy.address)
      ).to.be.reverted;
    });

    it("should revert when removing token that is in use by strategy", async function () {
      await admin.setSupportedToken(
        busd.address,
        true,
        busd.idleStrategy.address
      );
      await deployFakeStrategy({ batch, router, admin, token: busd });
      await expect(
        admin.setSupportedToken(
          busd.address,
          false,
          ethers.constants.AddressZero
        )
      ).to.be.reverted;
    });

    it("reverts on an address that is not a token and has no oracle configured for it", async function () {
      const ownerIdleStrategy = await deployProxyIdleStrategy(
        owner,
        batch,
        router,
        admin.address,
        owner,
        "Dummy",
        create2Deployer,
        ProxyBytecode
      );
      await expect(
        admin.setSupportedToken(owner.address, true, ownerIdleStrategy.address)
      ).to.be.reverted;
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
