const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy } = require("./shared/commonSetup");
const { MaxUint256, parseUniform } = require("./utils");


describe("Test StrategyRouter", function () {

  let owner, user1;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // core contracts
  let router, oracle, exchange, batching, receiptContract, sharesToken;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {

    [owner, user1] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batching, receiptContract, sharesToken } = await setupCore());

    // deploy mock tokens 
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

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

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);
    await router.setSupportedToken(usdt.address, true);

    // add fake strategies
    await deployFakeStrategy({ router, token: busd });
    await deployFakeStrategy({ router, token: usdc });
    await deployFakeStrategy({ router, token: usdt });

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1"));
    await router.depositToStrategies();
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

  it("should revert depositToBatch no allowance", async function () {
    await busd.approve(router.address, 0);
    await expect(router.depositToBatch(busd.address, parseBusd("100"))).to.be.reverted;
  });

  it("should revert depositToBatch token not whitelisted", async function () {
    await expect(router.depositToBatch(router.address, parseBusd("100")))
      .to.be.revertedWith("UnsupportedToken");
  });

  it("should depositToBatch create receipt with correct values", async function () {
    let depositAmount = parseBusd("100");
    await router.depositToBatch(busd.address, depositAmount);

    let newReceipt = await receiptContract.getReceipt(1);
    expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
    expect(newReceipt.token).to.be.equal(busd.address);
    expect(newReceipt.amount).to.be.equal(parseUniform("100"));
    expect(newReceipt.cycleId).to.be.equal(1);
    expect(await busd.balanceOf(batching.address)).to.be.equal(depositAmount);
  });

  it("shouldn't be able to withdrawFromBatching receipt that doesn't belong to you", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"))
    await expect(router.connect(user1).withdrawFromBatching([1], usdc.address, [MaxUint256]))
      .to.be.revertedWith("NotReceiptOwner()");
  });

  it("should withdrawFromBatching whole amount", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"));

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
  });

  it("should withdrawFromBatching token y when deposited token x", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
  });

  it("should withdrawFromBatching half of receipt value", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))

    // WITHDRAW PART
    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [parseUniform("50")]);
    newBalance = await usdc.balanceOf(owner.address);

    let receipt = await receiptContract.getReceipt(1);
    expect(receipt.amount).to.be.closeTo(parseUniform("50"), parseUniform("1"));
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
  });

  it("should withdrawFromBatching (and swap tokens x,y into z)", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"));
    await router.depositToBatch(usdc.address, parseUsdc("100"));

    // WITHDRAW PART
    oldBalance = await usdt.balanceOf(owner.address);
    await router.withdrawFromBatching([1,2], usdt.address, [parseUniform("100"), parseUniform("100")]);
    newBalance = await usdt.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdt("200"), parseUsdt("1"));
  });

  it("should withdrawFromBatching correct amount when price changes", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))

    // set price x10
    await oracle.setPrice(busd.address, parseBusd("10"));

    // current balance is 100 BUSD = 1000$
    // but dex's rates aren't changed! so we'll receive only 50usdc instead of 500.
    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [parseUniform("50")]);
    newBalance = await usdc.balanceOf(owner.address);

    let receipt = await receiptContract.getReceipt(1);
    expect(receipt.amount).to.be.closeTo(parseUniform("50"), parseUniform("1"));
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
  });

  it("should depositToStrategies", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))

    await router.depositToStrategies()
    let strategiesBalance = await router.getStrategiesValue()
    expect(strategiesBalance.totalBalance).to.be.closeTo(parseUniform("100"), parseUniform("2"));
  });

  it("should withdrawFromStrategies whole amount", async function () {
    await router.depositToBatch(busd.address, parseBusd("100"))
    await router.depositToStrategies()

    let receiptsShares = await router.receiptsToShares([1]);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies([1], usdc.address, receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
  });

  it("should withdrawFromStrategies both nft and shares", async function () {
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
    let amountFromShares = await router.sharesToUsd(receiptsShares);

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
    let amountFromShares = await router.sharesToUsd(receiptsShares);

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

    let amountReceiptBatch = (await receiptContract.getReceipt(3)).amount;

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([3], [2], usdc.address, [amountReceiptBatch], totalShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("30000"), parseUsdc("1000"));
    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(receiptContract.getReceipt(1)).to.be.reverted;
    expect(receiptContract.getReceipt(2)).to.be.reverted;
    expect(receiptContract.getReceipt(3)).to.be.reverted;
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

});
