const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTokensLiquidityOnPancake,
  setupTestParams,
  deployFakeStrategy,
} = require("../shared/commonSetup");
const { skipTimeAndBlocks, provider } = require("../utils");

// This test only tests behavior of automation mechanic (checkUpkeep and performUpkeep methods)
// All other accompanied functionality (i.e withdrawFulfill() or withdrawAndDistribute() business logic like its currentCycle
// increment mechanics) is tested elsewhere
describe("BatchOut upkeep automation", function () {
  let owner, user1, user2;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, admin, batch, receiptContract;
  let cycleWithdrawWindowTime = 3600; // 1 hour
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, user1, user2] = await ethers.getSigners();
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

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, admin, usdc, usdt, busd);

    // setup infinite allowance
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(usdt);

    // add fake strategies
    await deployFakeStrategy({ batch, router, admin, token: usdc });
    await deployFakeStrategy({ batch, router, admin, token: usdt });

    // Make deposit from user 1 to protocol in usdc
    await usdc.transfer(user1.address, parseUsdc("5000"));
    await usdc.connect(user1).approve(router.address, parseUsdc("5000"));
    await router
      .connect(user1)
      .depositToBatch(usdc.address, parseUsdc("5000"), "");

    // Make deposit from user 2 to protocol in usdt
    await usdt.transfer(user2.address, parseUsdt("5000"));
    await usdt.connect(user2).approve(router.address, parseUsdt("5000"));
    await router
      .connect(user2)
      .depositToBatch(usdt.address, parseUsdt("5000"), "");

    // Perform allocation to strategies
    await router.allocateToStrategies();

    // Set withdrawal window time to 1 hour
    await batchOut.setWithdrawWindowTime(cycleWithdrawWindowTime);
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

  describe("Test automation of withdrawal with batchOut (without notFulfilledCycleIds)", function () {
    it("Should behave like initial state", async () => {
      const currentCycleInfo = await batchOut.cycleInfo(
        await batchOut.currentCycleId()
      );

      // Countdown not started
      const currentCycleFirstWithdrawRequestAt = currentCycleInfo.startAt;
      expect(currentCycleFirstWithdrawRequestAt).to.be.equal(0);

      // Pending shares is zero
      const currentPendingShares = currentCycleInfo.pendingShareWithdraw;
      expect(currentPendingShares).to.be.equal(0);

      // Withdraws requests is zero
      const currentCycleWithdrawRequests = currentCycleInfo.withdrawRequests;
      expect(currentCycleWithdrawRequests).to.be.equal(0);

      // Not fulfilled cycle ids is empty
      const notFulfilledCycleIds = await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIds.length).to.be.equal(0);

      // checkUpkeep returns false
      const [upkeepRunning] = await batchOut.checkUpkeep([]);
      expect(upkeepRunning).to.be.equal(false);

      // performUpkeep execution fails
      await expect(batchOut.performUpkeep([])).to.be.reverted;
    });

    it("Should successfully check and then execute performUpkeep without notFulfilledCycleIds", async () => {
      // Make withdraw request from user 1
      const receipts = await receiptContract.getTokensOfOwner(user1.address);
      const shares = await router.calculateSharesFromReceipts(receipts);
      await batchOut
        .connect(user1)
        .scheduleWithdrawal(user1.address, usdc.address, receipts, shares);

      const currentCycleInfo = await batchOut.cycleInfo(
        await batchOut.currentCycleId()
      );

      // Countdown has started
      const currentCycleFirstWithdrawRequestAt = currentCycleInfo.startAt;
      expect(currentCycleFirstWithdrawRequestAt).to.not.be.equal(0);

      // Pending shares is not zero
      const currentPendingShares = currentCycleInfo.pendingShareWithdraw;
      expect(currentPendingShares).to.not.be.equal(0);

      // Withdraws requests is not zero
      const currentCycleWithdrawRequests = currentCycleInfo.withdrawRequests;
      expect(currentCycleWithdrawRequests).to.not.be.equal(0);

      // Not fulfilled cycle ids is empty
      const notFulfilledCycleIds = await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIds.length).to.be.equal(0);

      // Move on the time to half of cycleWithdrawWindowTime
      let timeToSkip = cycleWithdrawWindowTime / 2;
      await skipTimeAndBlocks(timeToSkip, timeToSkip / 3);

      // Check checkUpkeep returns false, because countdown has not finished yet
      [upkeepRunning] = await batchOut.checkUpkeep([]);
      expect(upkeepRunning).to.be.equal(false);

      // Next move on the time to cycleWithdrawWindowTime + 1 minute
      timeToSkip += 60;
      await skipTimeAndBlocks(timeToSkip, timeToSkip / 3);

      // Check checkUpkeep returns true
      [upkeepRunning] = await batchOut.checkUpkeep([]);
      expect(upkeepRunning).to.be.equal(true);

      await expect(batchOut.performUpkeep([])).to.not.be.reverted;
    });

    it("Should successfully check and then execute performUpkeep with notFulfilledCycleIds", async () => {
      // Make withdraw request from user 2
      const receipts = await receiptContract.getTokensOfOwner(user2.address);
      const shares = await router.calculateSharesFromReceipts(receipts);
      await batchOut
        .connect(user2)
        .scheduleWithdrawal(user2.address, usdt.address, receipts, shares);

      // Not fulfilled cycle ids is empty
      const notFulfilledCycleIds = await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIds.length).to.be.equal(0);

      // Check checkUpkeep returns false
      let [upkeepRunning] = await batchOut.checkUpkeep([]);
      expect(upkeepRunning).to.be.equal(false);

      // Call executeBatchWithdrawFromStrategyWithSwap method to make notFulfilledCycleIds not empty
      await batchOut.executeBatchWithdrawFromStrategyWithSwap();

      // Check checkUpkeep returns true
      [upkeepRunning] = await batchOut.checkUpkeep([]);
      expect(upkeepRunning).to.be.equal(true);

      // Not fulfilled cycle ids is not empty
      const notFulfilledCycleIdsAfter =
        await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIdsAfter.length).to.not.be.equal(0);

      // Current cycle id is not in notFulfilledCycleIds
      const currentCycleId = await batchOut.currentCycleId();
      expect(notFulfilledCycleIdsAfter).to.not.include(currentCycleId);

      const currentCycleInfo = await batchOut.cycleInfo(currentCycleId);

      // Countdown has not started
      const currentCycleFirstWithdrawRequestAt = currentCycleInfo.startAt;
      expect(currentCycleFirstWithdrawRequestAt).to.be.equal(0);

      // Pending shares is zero
      const currentPendingShares = currentCycleInfo.pendingShareWithdraw;
      expect(currentPendingShares).to.be.equal(0);

      // Withdraws requests is empty
      const currentCycleWithdrawRequests = currentCycleInfo.withdrawRequests;
      expect(currentCycleWithdrawRequests).to.be.equal(0);

      await expect(batchOut.performUpkeep([])).to.not.be.reverted;

      // Check that notFulfilledCycleIds is empty after performUpkeep
      const notFulfilledCycleIdsAfterPerformUpkeep =
        await batchOut.getNotFulfilledCycleIds();
      expect(notFulfilledCycleIdsAfterPerformUpkeep.length).to.be.equal(0);
    });
  });
});
