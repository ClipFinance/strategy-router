const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupTokens, setupCore, setupParamsOnBNB } = require("./shared/commonSetup");
const { skipTimeAndBlocks, MaxUint256, deploy, provider, parseUniform } = require("./utils");


describe("Test StrategyRouter with two real strategies on bnb chain (happy scenario)", function () {

  let owner, user2;
  // mock tokens with different decimals
  let usdc, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd;
  // core contracts
  let router, oracle, exchange, batch, receiptContract, sharesToken;
  let cycleDuration;
  let strategyBiswap, strategyBiswap2;

  let snapshotId;

  before(async function () {

    [owner, user2] = await ethers.getSigners();
    snapshotId = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());

    // setup params for testing
    await setupParamsOnBNB(router, oracle, exchange);
    cycleDuration = await router.cycleDuration();

    // get tokens on bnb chain for testing
    ({usdc, busd, parseUsdc, parseBusd} = await setupTokens());

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));

    // deploy strategies
    let StrategyFactory = await ethers.getContractFactory("BiswapBusdUsdt");
    strategyBiswap2 = await upgrades.deployProxy(StrategyFactory, [owner.address], {
      kind: 'uups',
      constructorArgs: [router.address],
    });
    await strategyBiswap2.deployed();
    await strategyBiswap2.transferOwnership(router.address);

    StrategyFactory = await ethers.getContractFactory("BiswapUsdcUsdt");
    strategyBiswap = await upgrades.deployProxy(StrategyFactory, [owner.address], {
      kind: 'uups',
      constructorArgs: [router.address],
    });
    await strategyBiswap.deployed();
    await strategyBiswap.transferOwnership(router.address);

    await router.addStrategy(strategyBiswap2.address, busd.address, 5000);
    await router.addStrategy(strategyBiswap.address, usdc.address, 5000);

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1"));
    await router.allocateToStrategies();
  });

  after(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });


  it("User deposit #1", async function () {

    await router.depositToBatch(usdc.address, parseUsdc("100"))

    // historically have this test with some delta
    expect(await usdc.balanceOf(batch.address)).to.be.closeTo(
      parseUsdc("100"),
      parseUsdc("0.1")
    );
    // returns exactly back, because we have simplified withdraw from batch
    expect(await usdc.balanceOf(batch.address)).to.be.equal(parseUsdc("100"));
  });

  it("User withdraw from current cycle", async function () {
    let receipt = await receiptContract.getReceipt(1);
    let oldBalance = await usdc.balanceOf(owner.address);
    await expect(router.withdrawFromBatch([1])).to.emit(router, 'WithdrawFromBatch')
        .withArgs(owner.address, [1], [usdc.address], [parseUsdc("100")]);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
  });

  it("2 users did multiple deposits and 1 user withdraws everything from current cycle", async function () {

    // was withdrawn in last previous test
    await expect(receiptContract.getReceipt(1)).revertedWith("NonExistingToken");

    await usdc.transfer(user2.address, parseUsdc("60"));
    await usdc.connect(user2).approve(router.address, parseUsdc("60"));
    await router.connect(user2).depositToBatch(usdc.address, parseUsdc("60"))

    let oldUsdcBal = await usdc.balanceOf(owner.address);
    let oldBusdBal = await busd.balanceOf(owner.address);

    await router.depositToBatch(usdc.address, parseUsdc("50"))
    await router.depositToBatch(busd.address, parseBusd("120"))
    await router.depositToBatch(usdc.address, parseUsdc("75"))

    // 3 receipts were just created, but the 4th one was initial admin deposit of 1 busd that is already allocated
    // to strategies, but since it was not removed, receipt is still there.
    expect(await receiptContract.balanceOf(owner.address)).to.equal(4);

    // 125 usdc and 120 busd in batch
    let batchUsdcBalance = await usdc.balanceOf(batch.address);
    let batchBusdBalance = await busd.balanceOf(batch.address);
    expect(batchUsdcBalance).to.be.equal(parseUsdc("185")); // 50+75=125 usdc of owner & 60 usdc of user2
    expect(batchBusdBalance).to.be.equal(parseBusd("120"));

    await expect(router.withdrawFromBatch([3, 4, 5])).to.emit(router, 'WithdrawFromBatch')
        .withArgs(
            owner.address,
            [3, 4, 5],
            [usdc.address, busd.address, usdc.address],
            [parseUsdc("50"), parseBusd("120"), parseUsdc("75")]
        );

    let newUsdcBal = await usdc.balanceOf(owner.address);
    let newBusdBal = await busd.balanceOf(owner.address);

    // 3 receipts from batch were burned during withdraw, so only 1 receipt is left allocated to strategy
    expect(await receiptContract.balanceOf(owner.address)).to.equal(1);
    // on position 0
    expect((await receiptContract.getTokensOfOwner(owner.address)).toString()).to.equal("0");

    // 1 receipt in batch belonging to user2
    expect(await receiptContract.balanceOf(user2.address)).to.equal(1);

    // old balance of user before deposit to batch andas  we withdraw everything from batch, we get initial balance
    expect(newUsdcBal).to.be.equal(oldUsdcBal);
    expect(newBusdBal).to.be.equal(oldBusdBal);
  });

  it("User deposit #2", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"));
  });

  it("Deposit to strategies", async function () {
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);

    await router.allocateToStrategies();

    expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
      parseUniform("160"), // 161.063235184928086817
      parseUniform("1.5")
    );
  });

  it("User deposit #3", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"));
  });

  it("Deposit to strategies", async function () {
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);

    await router.allocateToStrategies();

    expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
      parseUniform("260"), // 261.102493729346097917
      parseUniform("2.0")
    );
  });

  it("Withdraw from strategies", async function () {
    let oldBalance = await usdc.balanceOf(owner.address);
    let shares = await router.calculateSharesFromReceipts([2]);
    await router.withdrawFromStrategies([2], usdc.address, shares);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("100"),
      parseUniform("2.0")
    );
  });

  it("Withdraw from strategies again", async function () {

    let oldBalance = await usdc.balanceOf(owner.address);
    let shares = await router.calculateSharesFromReceipts([3]);
    await router.withdrawFromStrategies([3], usdc.address, shares);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("100"),
      parseUniform("2.0")
    );

    // should've withdrawn all (excpet admin), so verify that
    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.closeTo(parseEther("1"), parseEther("0.01"));
  });

  it("Farms should be empty on withdraw all multiple times", async function () {

    for (let i = 0; i < 5; i++) {
      await router.depositToBatch(usdc.address, parseUsdc("10"));
      await skipTimeAndBlocks(cycleDuration, cycleDuration/3);
      await router.allocateToStrategies();
      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
      let shares = await router.calculateSharesFromReceipts([receipts[0]]);
      await router.withdrawFromStrategies([receipts[0]], usdc.address, shares);

      // console.log("strategies balance");
      // printStruct(await router.getStrategiesValue());
    }

    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.closeTo(parseEther("1"), parseEther("0.01"));

  });

  it("Remove strategy", async function () {

    // deposit to strategies
    await router.depositToBatch(usdc.address, parseUsdc("10"));
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);
    await router.allocateToStrategies();

    // deploy new strategy
    let StrategyFactory = await ethers.getContractFactory("BiswapBusdUsdt");
    farm2 = await upgrades.deployProxy(StrategyFactory, [owner.address], {
      kind: 'uups',
      constructorArgs: [router.address],
    });
    await farm2.deployed();
    await farm2.transferOwnership(router.address);

    // add new farm
    await router.addStrategy(farm2.address, usdc.address, 1000);

    // remove 2nd farm with index 1
    await router.removeStrategy(1);

    // withdraw user shares
    let receipts = await receiptContract.getTokensOfOwner(owner.address);
    receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
    let oldBalance = await usdc.balanceOf(owner.address);
    let shares = await router.calculateSharesFromReceipts([receipts[0]]);
    await router.withdrawFromStrategies([receipts[0]], usdc.address, shares);
    let newBalance = await usdc.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("10"),
      parseUniform("2.0")
    );


    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.closeTo(parseEther("1"), parseEther("0.01"));
  });

  it("Test rebalance function", async function () {

    // console.log("strategies balance", await router.getStrategiesValue());

    // deposit to strategies
    await router.updateStrategy(0, 1000);
    await router.updateStrategy(1, 9000);

    await router.rebalanceStrategies();

    let { balances, totalBalance } = await router.getStrategiesValue();
    // console.log(totalBalance, balances);
    // strategies should be balanced as 10% and 90%
    expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(10, 1);
    expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(90, 1);

  });


});

