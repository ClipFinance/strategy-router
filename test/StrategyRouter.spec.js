const { expect, should, use } = require("chai");
const { BigNumber, logger, utils } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { setupTokens, setupCore, adminInitialDeposit, setupFakeTokens, setupFakeTokensLiquidity, setupTestParams } = require("./shared/commonSetup");
const { MaxUint256, deploy, parseUniform } = require("./utils");


describe("Test StrategyRouter", function () {

  let usdc, usdt, busd;
  let parseUsdc, parseBusd, parseUsdt;

  before(async function () {
    await setupCore();
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());
    await setupFakeTokensLiquidity();
    await setupTestParams();

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

    // setup supported stables
    await router.setSupportedStablecoin(usdc.address, true);
    await router.setSupportedStablecoin(busd.address, true);
    await router.setSupportedStablecoin(usdt.address, true);

    // add fake strategies
    let strategy1 = await deploy("MockStrategy", busd.address, 10000);
    await strategy1.transferOwnership(router.address);
    await router.addStrategy(strategy1.address, busd.address, 1000);

    let strategy2 = await deploy("MockStrategy", usdc.address, 10000);
    await strategy2.transferOwnership(router.address);
    await router.addStrategy(strategy2.address, usdc.address, 9000);

    let strategy3 = await deploy("MockStrategy", usdt.address, 10000);
    await strategy3.transferOwnership(router.address);
    await router.addStrategy(strategy3.address, usdt.address, 9000);

    await adminInitialDeposit();
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  it("depositToBatch no allowance", async function () {
    // remove allowance
    await busd.approve(router.address, 0);
    await expect(router.depositToBatch(busd.address, parseBusd("100"))).to.be.reverted;
  });

  it("depositToBatch token not whitelisted", async function () {
    await expect(router.depositToBatch(router.address, parseBusd("100")))
      .to.be.revertedWith("UnsupportedStablecoin");
  });

  it("depositToBatch", async function () {
    let depositAmount = parseBusd("100");
    await router.depositToBatch(busd.address, depositAmount);

    let newReceipt = await receiptContract.viewReceipt(1);
    expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
    expect(newReceipt.token).to.be.equal(busd.address);
    expect(newReceipt.amount).to.be.equal(parseUniform("100"));
    expect(newReceipt.cycleId).to.be.equal(1);
    expect(await busd.balanceOf(batching.address)).to.be.equal(depositAmount);
  });

  // TODO:
  // deposit 100, withdraw 50
  // deposit 100, withdraw 150 (more than deposited)
  // precondition: minimum deposit 50. deposit 50, withdraw 25. what to expect?
  // withdraw nft that doesn't belong to you
  // withdraw $1. what is minimum withdrawal amount?
  // deposit token X, trying to withdraw token Y
  //   token Y withdrawing amount is larger than deposited token X amount
  //   token Y withdrawing amount is less than minimum deposit amount
  it("withdrawFromBatching withdout swaps", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
  });

  // deposit x, withdraw in token y
  // what if stablecoins value is different
  // what if oracle gives another stablecoin is different 1000 times? (different rates)
  // what if token X has 0, 2, 6, 9, 18 decimals, token Y has 0, 2, 6, 9, 18 decimals and vice versa (different decimals)
  // different rate and decimals
  it("withdrawFromBatching with swaps", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))
    await router.depositToBatch(busd.address, parseBusd("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));

    // WITHDRAW PART
    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([2], usdc.address, [parseUsdc("50")]);
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
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("500"));
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
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("20000"), parseUsdc("2000"));

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
    await router.crossWithdrawFromStrategies([3], usdc.address, [MaxUint256]);
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
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100000"), parseUsdc("10000"));
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
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("500"));

  });

  it("withdrawUniversal - withdraw from batching", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([2], [], usdc.address, [parseUsdc("100000")], 0);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100000"), parseUsdc("20000"));
  });

  it("withdrawUniversal - withdraw shares (by receipt)", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    let amountFromShares = await router.sharesToValue(receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([], [1], usdc.address, [], receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("600"));
  });

  it("withdrawUniversal - withdraw shares (no receipt)", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);
    let amountFromShares = await router.sharesToValue(receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([], [], usdc.address, [], receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("500"));
  });

  it("withdrawUniversal - withdraw batch, shares and shares by receipt", async function () {
    await router.depositToBatch(busd.address, parseBusd("10000")); // 1
    await router.depositToBatch(busd.address, parseBusd("10000")); // 2
    await router.depositToStrategies();
    await router.depositToBatch(busd.address, parseBusd("10000")); // 3

    let withdrawShares = await router.receiptsToShares([1])
    await router.unlockShares([1]);
    let withdrawSharesFromReceipt = await router.receiptsToShares([2]);
    let totalShares = withdrawShares.add(withdrawSharesFromReceipt);

    let amountReceiptBatch = (await receiptContract.viewReceipt(3)).amount;

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([3], [2], usdc.address, [amountReceiptBatch], totalShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("30000"), parseUsdc("1000"));
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
    const Farm = await ethers.getContractFactory("MockStrategy");
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
