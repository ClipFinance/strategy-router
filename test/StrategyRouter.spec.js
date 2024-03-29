const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTestParams,
  setupTokensLiquidityOnPancake,
  deployFakeStrategy,
} = require("./shared/commonSetup");
const {
  parseUniform,
  saturateTokenBalancesInStrategies,
  applySlippageInBps,
  convertFromUsdToTokenAmount,
  provider,
} = require("./utils");

describe("Test StrategyRouter", function () {
  let owner, nonReceiptOwner, feeAddress;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, admin, batch, receiptContract, sharesToken;
  let allocationWindowTime;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, nonReceiptOwner, , , , , , , , feeAddress] =
      await ethers.getSigners();
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

    allocationWindowTime = 1;

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

    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(busd);
    await admin.addSupportedToken(usdt);

    // add fake strategies
    await deployFakeStrategy({ batch, router, admin, token: busd });
    await deployFakeStrategy({ batch, router, admin, token: usdc });
    await deployFakeStrategy({ batch, router, admin, token: usdt });

    await saturateTokenBalancesInStrategies(router);

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1"), "");
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

  it("should allocateToStrategies", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"), "");

    await router.allocateToStrategies();
    let strategiesBalance = await router.getStrategiesValue();
    expect(strategiesBalance.totalBalance).to.be.closeTo(
      parseUniform("100"),
      parseUniform("2")
    );
  });

  it("should withdrawFromStrategies only receipts", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.allocateToStrategies();

    let receiptsShares = await router.calculateSharesFromReceipts([1]);
    let sharesValueUsd = await router.calculateSharesUsdValue(receiptsShares);
    let expectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
      100 // 1% slippage
    );

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies(
      [1],
      usdc.address,
      receiptsShares,
      expectedWithdrawAmount,
      false
    );
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("100"),
      parseUsdc("1")
    );
  });

  it("should withdrawFromStrategies only shares", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.allocateToStrategies();

    let receiptsShares = await router.calculateSharesFromReceipts([1]);
    await router.redeemReceiptsToShares([1]);

    let sharesValueUsd = await router.calculateSharesUsdValue(receiptsShares);
    let expectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
      100 // 1% slippage
    );

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies(
      [],
      usdc.address,
      receiptsShares,
      expectedWithdrawAmount,
      false
    );
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("100"),
      parseUsdc("1")
    );
  });

  it("should withdrawFromStrategies both nft and shares", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.allocateToStrategies();

    await router.redeemReceiptsToShares([1]);

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.calculateSharesFromReceipts([2]);
    let withdrawShares = sharesBalance.add(receiptsShares);

    let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);
    let expectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
      100 // 1% slippage
    );

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies(
      [2],
      usdc.address,
      withdrawShares,
      expectedWithdrawAmount,
      false
    );
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("200"),
      parseUsdc("2")
    );
  });

  it("should withdrawFromStrategies not burn extra receipts", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.allocateToStrategies();

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.calculateSharesFromReceipts([1]);
    let withdrawShares = sharesBalance.add(receiptsShares).div(2);

    let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);
    let expectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
      100 // 1% slippage
    );

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies(
      [1, 2],
      usdc.address,
      withdrawShares,
      expectedWithdrawAmount,
      false
    );
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("2")
    );
    // if this call not revert, that means receipt still exists and not burned
    await expect(receiptContract.getReceipt(1)).to.be.not.reverted;
  });

  it("should withdrawFromStrategies update receipt that is withdrawn partly", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.depositToBatch(busd.address, parseBusd("100"), "");
    await router.allocateToStrategies();

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.calculateSharesFromReceipts([1]);
    let withdrawShares = sharesBalance.add(receiptsShares).div(2);
    let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);
    let expectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
      100 // 1% slippage
    );

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies(
      [1, 2],
      usdc.address,
      withdrawShares,
      expectedWithdrawAmount,
      false
    );
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("2")
    );
    // if this not revert, means receipt still exists and not burned
    let receipt = await receiptContract.getReceipt(1);
    expect(receipt.tokenAmountUniform).to.be.closeTo(
      parseUniform("50"),
      parseUniform("1")
    );
  });

  it("Remove strategy", async function () {
    // deposit to strategies
    await router.depositToBatch(busd.address, parseBusd("10"), "");
    await router.allocateToStrategies();

    // deploy new farm
    const Farm = await ethers.getContractFactory("MockStrategy");
    farm2 = await Farm.deploy(
      usdc.address,
      10000,
      usdc.parse((1_000_000).toString()),
      500, // 5%
      [router.address, batch.address]
    );
    await farm2.deployed();
    await farm2.transferOwnership(router.address);

    // add new farm
    await admin.addStrategy(farm2.address, 1000);

    // remove 2nd farm with index 1
    await admin.removeStrategy(1);
    await admin.rebalanceStrategies();

    // withdraw user shares
    let oldBalance = await usdc.balanceOf(owner.address);
    let receiptsShares = await router.calculateSharesFromReceipts([1]);

    let sharesValueUsd = await router.calculateSharesUsdValue(receiptsShares);
    let expectedWithdrawAmount = applySlippageInBps(
      await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
      100 // 1% slippage
    );

    await router.withdrawFromStrategies(
      [1],
      usdc.address,
      receiptsShares,
      expectedWithdrawAmount,
      false
    );
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("10"),
      parseUniform("1")
    );
  });

  describe("redeemReceiptsToSharesByModerators", function () {
    it("should revert when caller not whitelisted unlocker", async function () {
      [, nonModerator] = await ethers.getSigners();
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await router.allocateToStrategies();
      await expect(
        router.connect(nonModerator).redeemReceiptsToSharesByModerators([1])
      ).to.be.revertedWithCustomError(router, "NotModerator");
    });

    it("should unlock list of 1 receipt", async function () {
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await router.allocateToStrategies();
      let receiptsShares = await router.calculateSharesFromReceipts([1]);

      let oldBalance = await sharesToken.balanceOf(owner.address);
      await admin.redeemReceiptsToSharesByModerators([1]);
      let newBalance = await sharesToken.balanceOf(owner.address);

      expect(newBalance.sub(oldBalance)).to.be.equal(receiptsShares);
      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      expect(receipts.toString()).to.be.equal("0");
    });

    it("should unlock list of 2 receipt same owner", async function () {
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await router.allocateToStrategies();
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let receiptsShares2 = await router.calculateSharesFromReceipts([2]);

      let oldBalance = await sharesToken.balanceOf(owner.address);
      await admin.redeemReceiptsToSharesByModerators([1, 2]);
      let newBalance = await sharesToken.balanceOf(owner.address);
      expect(newBalance.sub(oldBalance)).to.be.equal(
        receiptsShares.add(receiptsShares2)
      );

      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      expect(receipts.toString()).to.be.equal("0");
    });

    it("should unlock list of 2 receipt with different owners", async function () {
      [, , , , owner2] = await ethers.getSigners();
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await busd.transfer(owner2.address, parseBusd("10"));
      await busd.connect(owner2).approve(router.address, parseBusd("10"));
      await router
        .connect(owner2)
        .depositToBatch(busd.address, parseBusd("10"), "");
      await router.allocateToStrategies();
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let receiptsShares2 = await router.calculateSharesFromReceipts([2]);

      let oldBalance = await sharesToken.balanceOf(owner.address);
      let oldBalance2 = await sharesToken.balanceOf(owner2.address);
      await admin.redeemReceiptsToSharesByModerators([1, 2]);
      let newBalance = await sharesToken.balanceOf(owner.address);
      let newBalance2 = await sharesToken.balanceOf(owner2.address);
      expect(newBalance.sub(oldBalance)).to.be.equal(receiptsShares);
      expect(newBalance2.sub(oldBalance2)).to.be.equal(receiptsShares2);

      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      let receipts2 = await receiptContract.getTokensOfOwner(owner2.address);
      expect(receipts.toString()).to.be.equal("0");
      expect(receipts2.toString()).to.be.equal("");
    });

    it("should unlock list of 4 receipt, two different owners", async function () {
      [, , , , owner2] = await ethers.getSigners();
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await router.depositToBatch(busd.address, parseBusd("10"), "");
      await busd.transfer(owner2.address, parseBusd("100"));
      await busd.connect(owner2).approve(router.address, parseBusd("100"));
      await router
        .connect(owner2)
        .depositToBatch(busd.address, parseBusd("10"), "");
      await router
        .connect(owner2)
        .depositToBatch(busd.address, parseBusd("10"), "");
      await router.allocateToStrategies();
      let receiptsShares = await router.calculateSharesFromReceipts([1, 2]);
      let receiptsShares2 = await router.calculateSharesFromReceipts([3, 4]);

      let oldBalance = await sharesToken.balanceOf(owner.address);
      let oldBalance2 = await sharesToken.balanceOf(owner2.address);
      await admin.redeemReceiptsToSharesByModerators([1, 2, 3, 4]);
      let newBalance = await sharesToken.balanceOf(owner.address);
      let newBalance2 = await sharesToken.balanceOf(owner2.address);
      expect(newBalance.sub(oldBalance)).to.be.equal(receiptsShares);
      expect(newBalance2.sub(oldBalance2)).to.be.equal(receiptsShares2);

      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      let receipts2 = await receiptContract.getTokensOfOwner(owner2.address);
      expect(receipts.toString()).to.be.equal("0");
      expect(receipts2.toString()).to.be.equal("");
    });
  });
});
