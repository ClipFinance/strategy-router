const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, MaxUint256 } = require("./utils");

describe("Test StrategyRouter with fake strategies", function () {

  async function setupTokens() {

    [owner, joe, bob] = await ethers.getSigners();
    // ~~~~~~~~~~~ GET EXCHANGE ROUTER ~~~~~~~~~~~ 
    uniswapRouter = await ethers.getContractAt(
      "IUniswapV2Router02",
      "0x10ED43C718714eb63d5aA57B78B54704E256024E"
    );

    // ~~~~~~~~~~~ GET BUSD ON MAINNET ~~~~~~~~~~~ 
    BUSD = "0xe9e7cea3dedca5984780bafc599bd69add087d56";
    busd = await ethers.getContractAt("ERC20", BUSD);
    // ~~~~~~~~~~~ GET IAcryptoSPool ON MAINNET ~~~~~~~~~~~ 
    ACS4UST = "0x99c92765EfC472a9709Ced86310D64C4573c4b77";
    acsUst = await ethers.getContractAt("IAcryptoSPool", ACS4UST);
    // ~~~~~~~~~~~ GET UST TOKENS ON MAINNET ~~~~~~~~~~~ 
    UST = "0x23396cf899ca06c4472205fc903bdb4de249d6fc";
    ustHolder = "0x05faf555522fa3f93959f86b41a3808666093210";
    ust = await getTokens(UST, ustHolder, parseUst("500000"), owner.address);
    // ~~~~~~~~~~~ GET USDC TOKENS ON MAINNET ~~~~~~~~~~~ 
    USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
    usdcHolder = "0xf977814e90da44bfa03b6295a0616a897441acec";
    usdc = await getTokens(USDC, usdcHolder, parseUsdc("500000"), owner.address);

  };

  before(async function () {
    await setupTokens();
    await setupCore();
    await setupFarms();
    await setupSettings();
    await adminInitialDeposit();
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  async function setupCore() {

    // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~ 
    exchange = await ethers.getContractFactory("Exchange");
    exchange = await exchange.deploy();
    await exchange.deployed();

    // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
    const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
    router = await StrategyRouter.deploy();
    await router.deployed();
    await router.setMinUsdPerCycle(parseUniform("1.0"));
    await router.setExchange(exchange.address);

    // ~~~~~~~~~~~ SETUP GLOBALS ~~~~~~~~~~~ 
    receiptContract = await ethers.getContractAt(
      "ReceiptNFT",
      await router.receiptContract()
    );
    batching = await ethers.getContractAt(
      "Batching",
      await router.batching()
    );
    sharesToken = await ethers.getContractAt(
      "SharesToken",
      await router.sharesToken()
    );
    exchange = await ethers.getContractAt(
      "Exchange",
      await router.exchange()
    );
    CYCLE_DURATION = Number(await router.cycleDuration());
    INITIAL_SHARES = Number(await router.INITIAL_SHARES());
  }

  async function setupFarms() {
    const FarmUnprofitable = await ethers.getContractFactory("MockFarm");
    farmUnprofitable = await FarmUnprofitable.deploy(ust.address, 10000);
    await farmUnprofitable.deployed();
    await farmUnprofitable.transferOwnership(router.address);

    const Farm = await ethers.getContractFactory("MockFarm");
    farm = await Farm.deploy(usdc.address, 10000);
    await farm.deployed();
    await farm.transferOwnership(router.address);
  };

  async function setupSettings() {
    await router.setSupportedStablecoin(usdc.address, true);
    await router.setSupportedStablecoin(ust.address, true);

    await router.addStrategy(farmUnprofitable.address, ust.address, 1000);
    await router.addStrategy(farm.address, usdc.address, 9000);
  };

  async function adminInitialDeposit() {
    await ust.approve(router.address, parseUst("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));

    await router.depositToBatch(ust.address, parseUst("1"));
    await router.depositToStrategies();

    expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  };

  it("depositToBatch", async function () {
    await router.depositToBatch(ust.address, parseUst("100"))
    expect(await ust.balanceOf(batching.address)).to.be.equal(parseUst("100"));
  });

  it("withdrawFromBatching withdout swaps", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
  });

  it("withdrawFromBatching with swaps", async function () {
    await router.depositToBatch(ust.address, parseUst("100"))
    await router.depositToBatch(ust.address, parseUst("100"))

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));

    // WITHDRAW PART
    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([2], usdc.address, parseUst("50"));
    newBalance = await usdc.balanceOf(owner.address);

    let receipt = await receiptContract.viewReceipt(2);

    expect(receipt.amount).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
  });

  it("depositToStrategies", async function () {
    await router.depositToBatch(ust.address, parseUst("100"))

    await router.depositToStrategies()
    let strategiesBalance = await router.viewStrategiesBalance()
    console.log(await usdc.balanceOf(owner.address));
    console.log(await ust.balanceOf(owner.address));
    expect(strategiesBalance.totalBalance).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
  });

  it("withdrawFromStrategies", async function () {
    await router.depositToBatch(ust.address, parseUst("100"))
    await router.depositToStrategies()

    let receiptsShares = await router.receiptsToShares([1]);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies([1], usdc.address, receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
  });

  it("withdrawFromStrategies both nft and shares", async function () {
    await router.depositToBatch(ust.address, parseUst("100"))
    await router.depositToBatch(ust.address, parseUst("100"))
    await router.depositToStrategies()

    await router.unlockShares([1]);

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([2]);
    let withdrawShares = sharesBalance.add(receiptsShares);
    await expect(router.withdrawFromStrategies([2], usdc.address, withdrawShares)).to.be.reverted;

    await sharesToken.approve(router.address, sharesBalance);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromStrategies([2], usdc.address, withdrawShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("200"), parseUsdc("1"));
  });
  
  it("crossWithdrawFromBatching", async function () {
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("100000"));

    let oldBalance = await usdc.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([1]);
    await router.crossWithdrawFromBatching([1], usdc.address, receiptsShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("20"));
  });

  it("crossWithdrawFromBatching both nft and shares", async function () {
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("100000"));

    await router.unlockShares([1]);

    let sharesBalance = await sharesToken.balanceOf(owner.address);
    let receiptsShares = await router.receiptsToShares([2]);
    let withdrawShares = sharesBalance.add(receiptsShares);
    await expect(router.crossWithdrawFromBatching([2], usdc.address, withdrawShares)).to.be.reverted;

    await sharesToken.approve(router.address, sharesBalance);
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.crossWithdrawFromBatching([2], usdc.address, withdrawShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("20000"), parseUsdc("40"));
  });

  it("crossWithdrawFromStrategies", async function () {
    await router.depositToBatch(ust.address, parseUst("100000")); // nft 1
    await router.depositToBatch(ust.address, parseUst("20000")); // 2
    await router.depositToStrategies(); // 120k
    await router.depositToBatch(ust.address, parseUst("10000")); // 3
    await router.depositToBatch(ust.address, parseUst("20000")); // 4

    let receiptsShares = await router.receiptsToShares([2]);
    await router.crossWithdrawFromBatching([2], usdc.address, receiptsShares);
    
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.crossWithdrawFromStrategies([3], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("20"));
  });

  it("withdrawShares", async function () {
    await router.depositToBatch(ust.address, parseUst("100000"));
    await router.depositToStrategies();

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);
    // await sharesToken.approve(router.address, receiptsShares);
    
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawShares(receiptsShares, usdc.address);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100000"), parseUsdc("250"));
  });

  it("crossWithdrawShares", async function () {
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.crossWithdrawShares(receiptsShares, usdc.address);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("20"));
  });

  it("withdrawUniversal - withdraw from batching", async function () {
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("100000"));

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([2], [], usdc.address, parseUst("100000"));
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100000"), parseUsdc("200"));
  });

  it("withdrawUniversal - withdraw shares (by receipt)", async function () {
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    let amountFromShares = await router.sharesToAmount(receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([], [1], usdc.address, parseUst("100000"));
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("20"));
  });

  it("withdrawUniversal - withdraw shares (no receipt)", async function () {
    await router.depositToBatch(ust.address, parseUst("10000"));
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("100000"));

    let receiptsShares = await router.receiptsToShares([1]);
    await router.unlockShares([1]);
    let amountFromShares = await router.sharesToAmount(receiptsShares);

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawUniversal([], [], usdc.address, amountFromShares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("10000"), parseUsdc("20"));
  });

  it("withdrawUniversal - withdraw batch, shares and shares by receipt", async function () {
    await router.depositToBatch(ust.address, parseUst("10000")); // 1
    await router.depositToBatch(ust.address, parseUst("10000")); // 2
    await router.depositToStrategies();
    await router.depositToBatch(ust.address, parseUst("10000")); // 3

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
    console.log(amountWithdraw);
    await router.withdrawUniversal([3], [2], usdc.address, amountWithdraw);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("30000"), parseUsdc("200"));
    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(receiptContract.viewReceipt(1)).to.be.reverted;
    expect(receiptContract.viewReceipt(2)).to.be.reverted;
    expect(receiptContract.viewReceipt(3)).to.be.reverted;
    // console.log("strategies balance", await router.viewStrategiesBalance());
    // console.log("batch balance", await router.viewBatchingBalance());
  });

  it("Remove strategy", async function () {

    console.log("strategies balance", await router.viewStrategiesBalance());

    // deposit to strategies
    await router.depositToBatch(ust.address, parseUst("10"));
    await router.depositToStrategies();
    console.log("strategies balance", await router.viewStrategiesBalance());
    
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
