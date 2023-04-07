const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTokensLiquidityOnPancake,
  setupTestParams,
  deployFakeStrategy,
} = require("./shared/commonSetup");
const { provider, parseUniform, deployProxyIdleStrategy, toUniform, fromUniform } = require("./utils");

describe("Test Batch", function () {
  let owner, nonReceiptOwner;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // core contracts
  let router, oracle, exchange, batch, receiptContract, sharesToken;
  // deposit settings
  let depositSettings;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batch, receiptContract, sharesToken } =
      await setupCore());

    depositSettings = {
      minValue: parseUniform("0.15"),
      minFee: parseUniform("0.15"),
      maxFee: parseUniform("1"),
      feePercentage: 1, // is 0.01% in BPS
      feeTreasury: hre.networkVariables.depositFeeTreasuryForTests,
    };

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(router));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd);

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

  describe("setDepositSettings", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ router, token: busd });
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert when min deposit fee is above min deposit value", async function () {
      await expect(batch.setDepositSettings({
       ...depositSettings,
       minValue: parseUniform("0.01"),
       minFee: parseUniform("0.02"),
     })).to.be.revertedWithCustomError(batch, "MinDepositFeeExceedsMinValue");
   });

    it("should revert when if set max deposit fee exceeds trheshold", async function () {
      // deposit fee threshold is 10 USD
      await expect(
        batch.setDepositSettings({
          ...depositSettings,
          maxFee: parseUniform("11"), // 11 USD
        })
      ).to.be.revertedWithCustomError(batch, "MaxDepositFeeExceedsThreshold");
    });

    it("should revert when if set min deposit fee exceeds max", async function () {
      await expect(
        batch.setDepositSettings({
          ...depositSettings,
          minValue: parseUniform("1"),
          minFee: parseUniform("1"),
          maxFee: parseUniform("0.5"),
        })
      ).to.be.revertedWithCustomError(batch, "MinDepositFeeExceedsMax");
    });

    it("should revert when if set deposit fee percentage exceeds max percentage (3% at the moment)", async function () {
      // max deposit fee percentage is 3% in BPS
      await expect(
        batch.setDepositSettings({
          ...depositSettings,
          feePercentage: 301, // 3,01%
        })
      ).to.be.revertedWithCustomError(batch, "DepositFeePercentExceedsMaxPercentage");
    });

    it("should revert when a fee percent or a max fee is zero if one of them is greater than zero", async function () {
      await expect(
        batch.setDepositSettings({
          ...depositSettings,
          feePercentage: 0,
          maxFee: parseUniform("1"),
        })
      ).to.be.revertedWithCustomError(batch, "DepositFeePercentOrMaxFeeCanNotBeZeroIfOneOfThemExists");

      await expect(
        batch.setDepositSettings({
          ...depositSettings,
          minFee: 0,
          maxFee: 0,
          feePercentage: 1,
        })
      ).to.be.revertedWithCustomError(batch, "DepositFeePercentOrMaxFeeCanNotBeZeroIfOneOfThemExists");
    });

    it("should revert when set zero address as fee treasury with max fee and fee percentage values are not zero", async function () {
      await expect(
        batch.setDepositSettings({
          ...depositSettings,
          feeTreasury: ethers.constants.AddressZero,
        })
      ).to.be.revertedWithCustomError(batch, "DepositFeeTreasuryNotSet");
    });

    it("can set zero address as treasury address if set deposit max fee and fee percentage are zero values", async function () {
      await batch.setDepositSettings({
        ...depositSettings,
        minFee: 0,
        maxFee: 0,
        feePercentage: 0,
        feeTreasury: ethers.constants.AddressZero,
      });

      expect(
        (await batch.depositSettings()).feeTreasury
      ).to.be.equal(ethers.constants.AddressZero);
    });

    it("should set deposit settings with correct values", async function () {
      await batch.setDepositSettings(depositSettings);

      const batchDepositSettings = await batch.depositSettings();

      expect(batchDepositSettings.minValue).to.equal(depositSettings.minValue);
      expect(batchDepositSettings.minFee).to.equal(depositSettings.minFee);
      expect(batchDepositSettings.maxFee).to.equal(depositSettings.maxFee);
      expect(batchDepositSettings.feePercentage).to.equal(depositSettings.feePercentage);
      expect(batchDepositSettings.feeTreasury).to.equal(depositSettings.feeTreasury);
    });

  });

  describe("deposit", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ router, token: busd });
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();

    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert depositToBatch no allowance", async function () {
      await busd.approve(router.address, 0);
      await expect(router.depositToBatch(busd.address, parseBusd("100"))).to.be.reverted;
    });

    it("should revert depositToBatch if token unsupported", async function () {
      await expect(
        router.depositToBatch(router.address, parseBusd("100"))
      ).to.be.revertedWithCustomError(router, "UnsupportedToken");
    });

    it("should depositToBatch create receipt with correct values", async function () {
      let depositAmount = parseBusd("100");
      await router.depositToBatch(busd.address, depositAmount);

      let newReceipt = await receiptContract.getReceipt(1);
      expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
      expect(newReceipt.token).to.be.equal(busd.address);
      expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
      expect(newReceipt.cycleId).to.be.equal(1);
      expect(await busd.balanceOf(batch.address)).to.be.equal(depositAmount);
    });

    it("should revert when user deposit depegged token that numerically match minimum amount", async function () {
      // set minimum deposit value to 1 USD
      await batch.setDepositSettings({
        minValue: parseUniform("1.0"),
        minFee: 0,
        maxFee: 0,
        feePercentage: 0,
        feeTreasury: ethers.constants.AddressZero
      });
      await oracle.setPrice(busd.address, parseBusd("0.1"));
      await expect(
        router.depositToBatch(busd.address, parseBusd("2.0"))
      ).to.be.revertedWithCustomError(batch, "DepositUnderMinimum");
    });

  });

  describe("deposit with fee", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ router, token: busd });
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();

      // set deposit fee
      await batch.setDepositSettings(depositSettings);
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert when user deposit value less than sum of min value and min fee with default deposit settings", async function () {
      // use value < $0.30 ($0.15 (min value) + $0.15 (min fee))
      const value = parseUniform("0.29");
      const amount = await getTokenAmount(usdc.address, value);

      // expect that deposit will revert because of min deposit fee subtraction from the deposit value
      // which will result in the actual deposit value not being enough to meet the minimum deposit value
      // $0.29 - $0.15 (min fee) = $0.14 < $0.15 (min value)
      await expect(
        router.depositToBatch(usdc.address, amount)
      ).to.be.revertedWithCustomError(batch, "DepositUnderMinimum");
    });

    it("should fire DepositWithFee event after deposit with exact values", async function () {
      const amount = parseBusd("100");

      const {
        depositAmount,
        depositFeeAmount,
      } = await calculateExpectedDepositStates(amount, busd.address);

      await expect(
        router.depositToBatch(busd.address, amount)
      ).to
        .emit(batch, "DepositWithFee")
        .withArgs(
          owner.address,
          busd.address,
          depositAmount,
          depositFeeAmount,
        );
    });

    it("should deposit tokens with min deposit fee and set correct values to a receipt", async function () {
      const amount = parseBusd("100");

      const {
        depositAmount,
        depositAmountUniform,
        depositFeeAmount,
      } = await calculateExpectedDepositStates(amount, busd.address);

      await router.depositToBatch(busd.address, amount);

      // Check receipt
      const newReceipt = await receiptContract.getReceipt(1);
      expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
      expect(newReceipt.token).to.be.equal(busd.address);
      expect(newReceipt.tokenAmountUniform).to.be.equal(depositAmountUniform);
      expect(newReceipt.cycleId).to.be.equal(1);

      // Check deposited amount and deposit fee
      const batchBalanceAfter = await busd.balanceOf(batch.address);
      const treasuryBalanceAfter = await busd.balanceOf(depositSettings.feeTreasury);
      expect(batchBalanceAfter).to.be.equal(depositAmount);
      expect(treasuryBalanceAfter).to.be.equal(depositFeeAmount);
      expect(await getTokenValue(busd.address, treasuryBalanceAfter)).to.be.equal(depositSettings.minFee);
    });

    it("should take the minimum fee value ($0.15) until $1,500 ($1,000)", async function () {
      const value = parseUniform("1000");
      const amount = await getTokenAmount(usdc.address, value);

      await router.depositToBatch(usdc.address, amount);

      const treasuryBalanceAfter = await usdc.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(usdc.address, treasuryBalanceAfter)).to.be.equal(depositSettings.minFee);
    });

    it("should take the minimum fee value ($0.15) until $1,500 ($1,490)", async function () {
      const value = parseUniform("1490");
      const amount = await getTokenAmount(usdt.address, value);

      await router.depositToBatch(usdt.address, amount);

      const treasuryBalanceAfter = await usdt.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(usdt.address, treasuryBalanceAfter)).to.be.equal(depositSettings.minFee);
    });

    it("should take a 0.01% fee value between $1,500 and $10,000 ($1,501)", async function () {
      const value = parseUniform("1501");
      const expectedFeeValue = parseUniform("0.1501"); // 0.1501 USD is 0.01% of 1,501 USD
      const amount = await getTokenAmount(busd.address, value);

      await router.depositToBatch(busd.address, amount);

      const treasuryBalanceAfter = await busd.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(busd.address, treasuryBalanceAfter)).to.be.equal(expectedFeeValue);
    });

    it("should take a 0.01% fee value between $1,500 and $10,000 ($5,000)", async function () {
      const value = parseUniform("5000");
      const expectedFeeValue = parseUniform("0.5"); // 0.5 USD is 0.01% of 5,000 USD
      const amount = await getTokenAmount(usdt.address, value);

      await router.depositToBatch(usdt.address, amount);

      const treasuryBalanceAfter = await usdt.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(usdt.address, treasuryBalanceAfter)).to.be.equal(expectedFeeValue);
    });

    it("should take a 0.01% fee value between $1,500 and $10,000 ($9,990)", async function () {
      const value = parseUniform("9990");
      const expectedFeeValue = parseUniform("0.999"); // 0.999 USD is 0.01% of 9,990 USD
      const amount = await getTokenAmount(usdc.address, value);

      await router.depositToBatch(usdc.address, amount);

      const treasuryBalanceAfter = await usdc.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(usdc.address, treasuryBalanceAfter)).to.be.equal(expectedFeeValue);
    });

    it("should take the max fee value ($1) above $10,000 ($11,000)", async function () {
      const value = parseUniform("11000");
      const amount = await getTokenAmount(busd.address, value);

      await router.depositToBatch(busd.address, amount);

      const treasuryBalanceAfter = await busd.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(busd.address, treasuryBalanceAfter)).to.be.equal(depositSettings.maxFee);
    });

    it("should take the max fee value ($1) above $10,000 ($50,000)", async function () {
      const value = parseUniform("50000");
      const amount = await getTokenAmount(usdt.address, value);

      await router.depositToBatch(usdt.address, amount);

      const treasuryBalanceAfter = await usdt.balanceOf(depositSettings.feeTreasury);
      expect(await getTokenValue(usdt.address, treasuryBalanceAfter)).to.be.equal(depositSettings.maxFee);
    });

  });

  describe("deposit in other tokens than strategy tokens", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    beforeEach(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);

      // add fake strategies
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdc });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();
    });

    afterEach(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should depositToBatch create receipt with correct values", async function () {
      let depositAmount = parseBusd("100");
      await router.depositToBatch(busd.address, depositAmount);

      let newReceipt = await receiptContract.getReceipt(1);
      expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
      expect(newReceipt.token).to.be.equal(busd.address);
      expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
      expect(newReceipt.cycleId).to.be.equal(1);
      expect(await busd.balanceOf(batch.address)).to.be.equal(depositAmount);
    });
  });

  describe("getDepositFeeAndValue", function () {

    it("should return 0 fee amount when deposit settings is not set and the token price is 1 USD", async function () {
      const value = parseUniform("20"); // 20 USD
      const amount = parseUsdc("20"); // 20 USDC

      const [feeAmount, depositValue] = await batch.getDepositFeeAndValue(amount, usdc.address);

      expect(feeAmount).to.be.equal(0);
      expect(depositValue).to.be.equal(value);
    });

    it("should return 0 deposit fee amount and value when default deposit settings and the token price is 0", async function () {
      // set deposit fee as default
      await batch.setDepositSettings(depositSettings);

      // set 0 price for USDC to get 0 value
      await oracle.setPrice(usdc.address, 0);
      const amount = parseUsdc("20"); // 20 USDC

      const [feeAmount, depositValue] = await batch.getDepositFeeAndValue(amount, usdc.address);

      expect(feeAmount).to.be.equal(0);
      expect(depositValue).to.be.equal(0);
    });

    it("should return min deposit fee amount when the deposit fee is set as default", async function () {
      // set deposit fee as default
      await batch.setDepositSettings(depositSettings);

      const amount = parseUsdt("20"); // 20 USDT

      const {
        depositFeeAmount,
        depositValue: value,
      } = await calculateExpectedDepositStates(amount, usdt.address);

      const [feeAmount, depositValue] = await batch.getDepositFeeAndValue(amount, usdt.address);

      // expect that fee amount is the same as the min fee amount
      expect(feeAmount).to.be.equal(depositFeeAmount);
      expect(depositValue).to.be.equal(value);
    });

    it("should return max deposit fee amount when the deposit fee is set as default", async function () {
      // set deposit fee as default
      await batch.setDepositSettings(depositSettings);

      const amount = parseUsdt("15000"); // 15,000 USDT

      const {
        depositFeeAmount,
        depositValue: value,
      } = await calculateExpectedDepositStates(amount, usdt.address);

      const [feeAmount, depositValue] = await batch.getDepositFeeAndValue(amount, usdt.address);

      // expect that fee amount is the same as the max fee amount
      expect(feeAmount).to.be.equal(depositFeeAmount);
      expect(depositValue).to.be.equal(value);
    });

    it("should return correct deposit fee amount depends on the fee percentage (0.01%) when the deposit fee is set as default", async function () {
      // set deposit fee as default
      await batch.setDepositSettings(depositSettings);

      const amount = parseUsdt("5000"); // 5,000 USDT
      const expectedFeeAmount = parseUsdt("0.5"); // 0.01% fee of 5,000 USDT

      const {
        depositValue: value,
      } = await calculateExpectedDepositStates(amount, usdt.address);

      const [feeAmount, depositValue]= await batch.getDepositFeeAndValue(amount, usdt.address);

      expect(feeAmount).to.be.equal(expectedFeeAmount);
      expect(depositValue).to.be.equal(value);
    });
  });

  describe("getBatchTotalUsdValue", function () {

    it("happy paths: 1 supported token", async function () {
      await oracle.setPrice(busd.address, parseBusd("0.5"));

      // setup supported tokens
      await router.addSupportedToken(busd);
      // add fake strategies
      await deployFakeStrategy({ router, token: busd });

      await router.depositToBatch(busd.address, parseBusd("100.0"));
      let { totalBalance, balances } = await router.getBatchValueUsd();
      expect(totalBalance).to.be.equal(parseUniform("50"));
      expect(balances.toString()).to.be.equal(`${parseUniform("50")}`);
    });

    it("3 supported token", async function () {
      await oracle.setPrice(busd.address, parseBusd("0.9"));
      await oracle.setPrice(usdc.address, parseUsdc("0.9"));
      await oracle.setPrice(usdt.address, parseUsdt("1.1"));

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ router, token: busd });
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdt });

      await router.depositToBatch(busd.address, parseBusd("100.0"));
      await router.depositToBatch(usdc.address, parseUsdc("100.0"));
      await router.depositToBatch(usdt.address, parseUsdt("100.0"));

      let { totalBalance, balances } = await router.getBatchValueUsd();
      // 0.9 + 0.9 + 1.1 = 2.9
      expect(totalBalance).to.be.equal(parseUniform("290"));
      expect(balances.toString()).to.be.equal(
        `${parseUniform("90")},${parseUniform("90")},${parseUniform("110")}`
      );
    });
  });

  describe("withdraw", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    before(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(busd);
      await router.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ router, token: busd });
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();
    });

    after(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("shouldn't be able to withdraw receipt that doesn't belong to you", async function () {
      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await expect(
        router.connect(nonReceiptOwner).withdrawFromBatch([1])
      ).to.be.revertedWithCustomError(batch, "NotReceiptOwner");
    });

    it("should burn receipts when withdraw whole amount noted in it", async function () {
      await router.depositToBatch(usdc.address, parseUsdc("100"));

      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      expect(receipts.toString()).to.be.eq("1,0");

      await router.withdrawFromBatch([1]);

      receipts = await receiptContract.getTokensOfOwner(owner.address);
      expect(receipts.toString()).to.be.eq("0");
    });

    it("should withdraw whole amount", async function () {
      await router.depositToBatch(usdc.address, parseUsdc("100"));

      let oldBalance = await usdc.balanceOf(owner.address);
      await router.withdrawFromBatch([1]);
      let newBalance = await usdc.balanceOf(owner.address);

      expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
    });

    it("should withdraw whole amount without deposit fee", async function () {
      // set deposit fee
      await batch.setDepositSettings(depositSettings);

      const value = parseUniform("100"); // 100 USD
      const amount = await getTokenAmount(usdt.address, value);
      const amountFee = await getTokenAmount(usdt.address, depositSettings.minFee); // min deposit fee in usdt

      await router.depositToBatch(usdt.address, amount);

      let oldBalance = await usdt.balanceOf(owner.address);
      await router.withdrawFromBatch([1]);
      let newBalance = await usdt.balanceOf(owner.address);

      const expectedAmount = amount.sub(amountFee);
      // use closeTo with 1 delta because of division in the getTokenAmount function
      expect(newBalance.sub(oldBalance)).to.be.closeTo(expectedAmount, 1);
    });

    it("should withdraw two receipts and receive tokens noted in them", async function () {
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.depositToBatch(usdt.address, parseUsdt("100"));

      // WITHDRAW PART
      oldBalance = await usdt.balanceOf(owner.address);
      oldBalance2 = await busd.balanceOf(owner.address);
      await router.withdrawFromBatch([1, 2]);
      newBalance = await usdt.balanceOf(owner.address);
      newBalance2 = await busd.balanceOf(owner.address);

      expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdt("100"), parseUsdt("1"));
      expect(newBalance2.sub(oldBalance2)).to.be.closeTo(parseBusd("100"), parseBusd("1"));
    });
  });

  describe("setSupportedToken", function () {
    it("should add supported token", async function () {
      await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
      expect((await router.getSupportedTokens()).toString()).to.be.equal(
        `${usdt.address}`
      );
    });

    it("should be idempotent", async function () {
      await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
      await router.setSupportedToken(usdt.address, false, ethers.constants.AddressZero);
      await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
      expect((await router.getSupportedTokens()).toString()).to.be.equal(
        `${usdt.address}`
      );
    });

    it("should revert when adding the same token twice", async function () {
      await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
      await expect(
        router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address)
      ).to.be.reverted;
    });

    it("should revert when removing token that is in use by strategy", async function () {
      await router.setSupportedToken(busd.address, true, busd.idleStrategy.address);
      await deployFakeStrategy({ router, token: busd });
      await expect(
        router.setSupportedToken(busd.address, false, ethers.constants.AddressZero)
      ).to.be.reverted;
    });

    it("reverts on an address that is not a token and has no oracle configured for it", async function () {
      const ownerIdleStrategy = await deployProxyIdleStrategy(owner, router, owner)
      await expect(
        router.setSupportedToken(owner.address, true, ownerIdleStrategy.address)
      ).to.be.reverted;
    });
  });

  // amount is in token decimals
  // returns value in uniform decimals
  const getTokenValue = async (tokenAddress, amount) => {
    const [price, priceDecimals] = await oracle.getTokenUsdPrice(tokenAddress);
    const pricePrecision = ethers.BigNumber.from(10).pow(priceDecimals);

    return toUniform(
      amount.mul(price).div(pricePrecision),
      tokenAddress
    );
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

  const calculateExpectedDepositStates = async (amount, depositTokenAddress) => {
    const value = await getTokenValue(depositTokenAddress, amount);

    const depositSettings = await batch.depositSettings();
    if (
        depositSettings.maxFee.gt(0) && depositSettings.feePercentage.gt(0)
        && value.gt(0)
    ) {

      const MAX_BPS = ethers.BigNumber.from(10000); // is 100% in BPS

      let depositFeeValue = value.mul(depositSettings.feePercentage).div(MAX_BPS);
      if (depositFeeValue.lt(depositSettings.minFee)) {
          depositFeeValue = depositSettings.minFee;
      } else if (depositFeeValue.gt(depositSettings.maxFee)) {
          depositFeeValue = depositSettings.maxFee;
      }

      const depositValue = value.sub(depositFeeValue);

      const depositAmount = amount.mul(depositValue).div(value);
      const depositFeeAmount = amount.sub(depositAmount);

      return {
        depositAmount,
        depositAmountUniform: await toUniform(depositAmount, depositTokenAddress),
        depositFeeAmount,
        depositValue,
        depositFeeValue
      };

    } else return {
      depositAmount: amount,
      depositAmountUniform: await toUniform(amount, depositTokenAddress),
      depositFeeAmount: ethers.BigNumber.from(0),
      depositValue: value,
      depositFeeValue: ethers.BigNumber.from(0)
    };

  }
});
