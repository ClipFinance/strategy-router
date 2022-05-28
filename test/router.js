const { expect, should, use } = require("chai");
const { BigNumber, logger } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const {commonSetup, adminInitialDeposit} = require("./utils/commonSetup");
const { getTokens, MaxUint256, getBUSD, getUSDC, parseBusd } = require("./utils/utils");


describe("Test StrategyRouter with fake strategies", function () {

  before(async function () {
    await commonSetup();

    // setup supported stables
    await router.setSupportedStablecoin(usdc.address, true);
    await router.setSupportedStablecoin(busd.address, true);

    // add two strategies with fake farms
    const FarmUnprofitable = await ethers.getContractFactory("MockFarm");
    farmUnprofitable = await FarmUnprofitable.deploy(busd.address, 10000);
    await farmUnprofitable.deployed();
    await farmUnprofitable.transferOwnership(router.address);

    const Farm = await ethers.getContractFactory("MockFarm");
    farm = await Farm.deploy(usdc.address, 10000);
    await farm.deployed();
    await farm.transferOwnership(router.address);

    await router.addStrategy(farmUnprofitable.address, busd.address, 1000);
    await router.addStrategy(farm.address, usdc.address, 9000);
    
    await adminInitialDeposit();
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  it("depositToBatch", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))
    expect(await busd.balanceOf(batching.address)).to.be.equal(parseBusd("100"));
  });

  it("withdrawFromBatching withdout swaps", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
  });

  it("withdrawFromBatching with swaps", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))
    await router.depositToBatch(busd.address, parseBusd("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));

    // WITHDRAW PART
    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([2], usdc.address, parseBusd("50"));
    newBalance = await usdc.balanceOf(owner.address);

    let receipt = await receiptContract.viewReceipt(2);

    expect(receipt.amount).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
  });

  it("depositToStrategies", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))

    await router.depositToStrategies()
    let strategiesBalance = await router.viewStrategiesValue()
    expect(strategiesBalance.totalBalance).to.be.closeTo(parseUsdc("100"), parseUsdc("2"));
  });

  it("withdrawFromStrategies", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))
    await router.depositToStrategies()

    let receiptsShares = await router.receiptsToShares([1]);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies([1], usdc.address, receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
  });

  it("withdrawFromStrategies both nft and shares", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))
    await router.depositToBatch(busd.address, parseBusd("100"))
    await router.depositToStrategies()

    await router.unlockShares([1]);

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([2]);
    let withdrawShares = sharesBalance.add(receiptsShares);


    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies([2], usdc.address, withdrawShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("200"), parseUsdc("2"));
  });

  it("crossWithdrawFromBatching", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let oldBalance = await usdc.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([1]);
    await router.crossWithdrawFromBatching([1], usdc.address, receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("200"));
  });

  it("crossWithdrawFromBatching both nft and shares", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    await router.unlockShares([1]);

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([2]);
    let withdrawShares = sharesBalance.add(receiptsShares);


    let oldBalance = await usdc.balanceOf(owner.address);
    await router.crossWithdrawFromBatching([2], usdc.address, withdrawShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("20000"), parseUsdc("400"));

  });

  it("crossWithdrawFromStrategies", async function () {
    await router.depositToBatch(busd.address, parseBusd("100000")); // nft 1
    await router.depositToBatch(busd.address, parseBusd("20000")); // 2
    await router.depositToStrategies(); // 120k
    await router.depositToBatch(busd.address, parseBusd("10000")); // 3
    await router.depositToBatch(busd.address, parseBusd("20000")); // 4

    let receiptsShares = await router.receiptsToShares([2]);
    await router.crossWithdrawFromBatching([2], usdc.address, receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.crossWithdrawFromStrategies([3], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("200"));

  });

  it("withdrawShares", async function () {
    await router.depositToBatch(busd.address, parseBusd("100000"));
    await router.depositToStrategies();

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawShares(receiptsShares, usdc.address);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100000"), parseUsdc("2500"));
  });

  it("crossWithdrawShares", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.crossWithdrawShares(receiptsShares, usdc.address);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("200"));

  });

  it("withdrawUniversal - withdraw from batching", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([2], [], usdc.address, parseBusd("100000"));
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100000"), parseUsdc("2000"));
  });

  it("withdrawUniversal - withdraw shares (by receipt)", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    let amountFromShares = await router.sharesToAmount(receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([], [1], usdc.address, parseBusd("100000"));
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("200"));
  });

  it("withdrawUniversal - withdraw shares (no receipt)", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);
    let amountFromShares = await router.sharesToAmount(receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([], [], usdc.address, amountFromShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("200"));
  });

  it("withdrawUniversal - withdraw batch, shares and shares by receipt", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000")); // 1
    await router.depositToBatch(busd.address, parseBusd("10000")); // 2
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("10000")); // 3

    let amountFromShares = await router.sharesToAmount(
      await router.receiptsToShares([1])
    );
    await router.unlockShares([1]);

    let amountReceiptStrats = await router.sharesToAmount(
      await router.receiptsToShares([2])
    );
    let amountReceiptBatch = (await receiptContract.viewReceipt(3)).amount;
    let amountWithdraw = amountFromShares.add(amountReceiptBatch).add(amountReceiptStrats);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([3], [2], usdc.address, amountWithdraw);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("30000"), parseUsdc("300"));
    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(receiptContract.viewReceipt(1)).to.be.reverted;
    expect(receiptContract.viewReceipt(2)).to.be.reverted;
    expect(receiptContract.viewReceipt(3)).to.be.reverted;
  });

  it("Remove strategy", async function () {


    // deposit to strategies
    await router.depositToBatch(busd.address, parseBusd("10"));
    await router.depositToStrategies();

    // deploy new farm
    const Farm = await ethers.getContractFactory("MockFarm");
    farm2 = await Farm.deploy(usdc.address, 10000);
    await farm2.deployed();
    await farm2.transferOwnership(router.address);

    // add new farm
    await router.addStrategy(farm2.address, usdc.address, 1000);

    // remove 2nd farm with index 1
    await router.removeStrategy(1);
    await router.rebalanceStrategies();

    // withdraw user shares
    let oldBalance = await usdc.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([1]);
    await router.withdrawFromStrategies([1], usdc.address, receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("10"),
      parseUniform("1")
    );

  });

  it("Test rebalance function", async function () {
    // see rebalance.js
  });

});
