const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupTokens, setupCore, setupParamsOnBNB } = require("./shared/commonSetup");
const { skipTimeAndBlocks, MaxUint256, deploy, provider } = require("./utils");


describe("Test StrategyRouter with two real strategies on bnb chain", function () {

  let owner;
  // mock tokens with different decimals
  let usdc, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd;
  // core contracts
  let router, oracle, exchange, batching, receiptContract, sharesToken;
  let cycleDuration;
  let strategyBiswap, strategyBiswap2;

  let snapshotId;

  before(async function () {

    [owner] = await ethers.getSigners();
    snapshotId = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batching, receiptContract, sharesToken } = await setupCore());

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
    strategyBiswap2 = await deploy("BiswapBusdUsdt", router.address);
    await strategyBiswap2.transferOwnership(router.address);

    strategyBiswap = await deploy("BiswapUsdcUsdt", router.address);
    await strategyBiswap.transferOwnership(router.address);

    await router.addStrategy(strategyBiswap2.address, busd.address, 5000);
    await router.addStrategy(strategyBiswap.address, usdc.address, 5000);

    // admin initial deposit to set initial shares and pps
    await router.depositToBatch(busd.address, parseBusd("1"));
    await router.depositToStrategies();
  });

  after(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });


  it("User deposit", async function () {

    await router.depositToBatch(usdc.address, parseUsdc("100"))

    expect(await usdc.balanceOf(batching.address)).to.be.closeTo(
      parseUsdc("100"),
      parseUsdc("0.1")
    );
  });

  it("User withdraw half from current cycle", async function () {
    let receipt = await receiptContract.getReceipt(1);
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [receipt.amount.div(2)]);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("0.2")
    );
  });

  it("User withdraw other half from current cycle", async function () {
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("0.2")
    );
  });

  it("User deposit", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"));
  });

  it("Deposit to strategies", async function () {
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);

    await router.depositToStrategies();
    expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
      parseUniform("100"),
      parseUniform("1.5")
    );
  });

  it("User deposit", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"));
  });

  it("Deposit to strategies", async function () {
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);

    await router.depositToStrategies();

    expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
      parseUniform("200"),
      parseUniform("2.0")
    );
  });

  it("Withdraw half from strategies", async function () {
    let oldBalance = await usdc.balanceOf(owner.address);
    let shares = await router.receiptsToShares([2]);
    await router.withdrawFromStrategies([2], usdc.address, shares.div(2));
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUniform("2.0")
    );
  });

  it("Withdraw other half from strategies", async function () {
    let shares = await sharesToken.balanceOf(owner.address);
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawShares(shares, usdc.address);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUniform("2.0")
    );
  });

  it("Withdraw from strategies", async function () {

    let oldBalance = await usdc.balanceOf(owner.address);
    let shares = await router.receiptsToShares([3]);
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
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  });

  it("Farms should be empty on withdraw all multiple times", async function () {

    for (let i = 0; i < 5; i++) {
      await router.depositToBatch(usdc.address, parseUsdc("10"));
      await skipTimeAndBlocks(cycleDuration, cycleDuration/3);
      await router.depositToStrategies();
      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
      let shares = await router.receiptsToShares([receipts[0]]);
      await router.withdrawFromStrategies([receipts[0]], usdc.address, shares);

      // console.log("strategies balance");
      // printStruct(await router.getStrategiesValue());
    }

    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);

  });

  it("Remove strategy", async function () {

    // deposit to strategies
    await router.depositToBatch(usdc.address, parseUsdc("10"));
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);
    await router.depositToStrategies();

    // deploy new strategy
    const Farm = await ethers.getContractFactory("BiswapBusdUsdt");
    farm2 = strategyBiswap = await Farm.deploy(router.address);
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
    let shares = await router.receiptsToShares([receipts[0]]);
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
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  });

  it("Test rebalance function", async function () {

    // console.log("strategies balance", await router.getStrategiesValue());

    // deposit to strategies
    await router.updateStrategy(0, 1000);
    await router.updateStrategy(1, 9000);

    await router.rebalanceStrategies();

    let { balances, totalBalance } = await router.getStrategiesValue();
    // strategies should be balanced as 10% and 90%
    expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(10, 1);
    expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(90, 1);

  });

  it("Scenario", async function () {

    ////////
    // user deposit
    await router.depositToBatch(usdc.address, parseUsdc("100000"));
    await router.depositToBatch(usdc.address, parseUsdc("100000"));
    // deposit to strategies
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);
    await router.depositToStrategies();

    // user deposit
    await router.depositToBatch(usdc.address, parseUsdc("100"));
    await router.depositToBatch(usdc.address, parseUsdc("100"));
    // // deposit to strategies
    await skipTimeAndBlocks(cycleDuration, cycleDuration/3);
    await router.depositToStrategies();

    let receipts = await receiptContract.getTokensOfOwner(owner.address);
    // withdraw by receipt
    let oldBalance = await usdc.balanceOf(owner.address);
    let shares = await router.receiptsToShares([10]);
    await router.withdrawFromStrategies([10], usdc.address, shares);
    let newBalance = await usdc.balanceOf(owner.address);

    oldBalance = await usdc.balanceOf(owner.address);
    shares = await router.receiptsToShares([11]);
    await router.withdrawFromStrategies([11], usdc.address, shares);
    newBalance = await usdc.balanceOf(owner.address);

    // unlock shares and withdraw tokens by shares
    await router.unlockShares([12]);
    let sharesUnlocked = await sharesToken.balanceOf(owner.address);

    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawShares(sharesUnlocked, usdc.address);
    newBalance = await usdc.balanceOf(owner.address);

    await router.unlockShares([13]);
    sharesUnlocked = await sharesToken.balanceOf(owner.address);
    oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawShares(sharesUnlocked, usdc.address);
    newBalance = await usdc.balanceOf(owner.address);

    receipts = await receiptContract.getTokensOfOwner(owner.address);


    // await router.withdrawShares(1, usdc.address);
    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.within(0, 10);
  });

});

