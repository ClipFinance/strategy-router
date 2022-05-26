const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, MONTH_SECONDS, printStruct, skipCycleAndBlocks, MaxUint256, getBUSD, getUSDC } = require("./utils/utils");

// ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 
provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 18);
parseUsdc = (args) => parseUnits(args, 18);
parseUniform = (args) => parseUnits(args, 18);
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

describe("Test StrategyRouter with two real strategies", function () {


  it("Snapshot evm", async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  after(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  it("Define globals", async function () {

    [owner, joe, bob] = await ethers.getSigners();
    // ~~~~~~~~~~~ GET EXCHANGE ROUTER ~~~~~~~~~~~ 
    uniswapRouter = await ethers.getContractAt(
      "IUniswapV2Router02",
      "0x10ED43C718714eb63d5aA57B78B54704E256024E"
    );

    busd = await getBUSD();
    usdc = await getUSDC();
  });

  it("Deploy StrategyRouter", async function () {

    // ~~~~~~~~~~~ DEPLOY Oracle ~~~~~~~~~~~ 
    // oracle = await ethers.getContractFactory("ChainlinkOracle");
    oracle = await ethers.getContractFactory("FakeOracle");
    oracle = await oracle.deploy();
    await oracle.deployed();

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
    await router.setOracle(oracle.address);

    // ~~~~~~~~~~~ SETUP GLOBALS ~~~~~~~~~~~ 
    batching = await ethers.getContractAt(
      "Batching",
      await router.batching()
    );
    receiptContract = await ethers.getContractAt(
      "ReceiptNFT",
      await router.receiptContract()
    );
    sharesToken = await ethers.getContractAt(
      "SharesToken",
      await router.sharesToken()
    );
    exchange = await ethers.getContractAt(
      "Exchange",
      await router.exchange()
    );

    await router.setCycleDuration(MONTH_SECONDS);
    CYCLE_DURATION = Number(await router.cycleDuration());
    INITIAL_SHARES = Number(await router.INITIAL_SHARES());

  });

  it("Deploy biswap_busd_usdt", async function () {

    // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
    strategyBiswap2 = await ethers.getContractFactory("biswap_busd_usdt");
    strategyBiswap2 = await strategyBiswap2.deploy(router.address);
    await strategyBiswap2.deployed();
    await strategyBiswap2.transferOwnership(router.address);
  });

  it("Deploy biswap_usdc_usdt", async function () {

    // ~~~~~~~~~~~ DEPLOY strategy ~~~~~~~~~~~ 
    strategyBiswap = await ethers.getContractFactory("biswap_usdc_usdt");
    strategyBiswap = await strategyBiswap.deploy(router.address);
    await strategyBiswap.deployed();
    await strategyBiswap.transferOwnership(router.address);
  });

  it("Add strategies and stablecoins", async function () {
    await router.setSupportedStablecoin(busd.address, true);
    await router.setSupportedStablecoin(usdc.address, true);

    await router.addStrategy(strategyBiswap2.address, busd.address, 5000);
    await router.addStrategy(strategyBiswap.address, usdc.address, 5000);
  });


  it("Admin initial deposit", async function () {
    await usdc.approve(router.address, parseUsdc("1000000"));

    await router.depositToBatch(usdc.address, parseUsdc("100"));
    await skipCycleAndBlocks();
    await router.depositToStrategies();
    await skipCycleAndBlocks();

    expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  });

  it("User deposit", async function () {

    await router.depositToBatch(usdc.address, parseUsdc("100"))

    expect(await usdc.balanceOf(batching.address)).to.be.closeTo(
      parseUsdc("100"),
      parseUsdc("0.1")
    );
  });

  it("User withdraw half from current cycle", async function () {
    let receipt = await receiptContract.viewReceipt(1);
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, receipt.amount.div(2));
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("0.2")
    );
  });

  it("User withdraw other half from current cycle", async function () {
    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, MaxUint256);
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
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();
    expect((await router.viewStrategiesValue()).totalBalance).to.be.closeTo(
      parseUniform("200"),
      parseUniform("1.5")
    );
  });

  it("User deposit", async function () {
    await router.depositToBatch(usdc.address, parseUsdc("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();

    expect((await router.viewStrategiesValue()).totalBalance).to.be.closeTo(
      parseUniform("300"),
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
    await printStruct(await receiptContract.viewReceipt(3));
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
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  });

  it("Farms should be empty on withdraw all multiple times", async function () {

    for (let i = 0; i < 5; i++) {
      await router.depositToBatch(usdc.address, parseUsdc("10"));
      await skipCycleAndBlocks();
      await router.depositToStrategies();
      let receipts = await receiptContract.walletOfOwner(owner.address);
      receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
      let shares = await router.receiptsToShares([receipts[0]]);
      await router.withdrawFromStrategies([receipts[0]], usdc.address, shares);

      // console.log("strategies balance");
      // printStruct(await router.viewStrategiesValue());
    }

    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  });

  it("Remove strategy", async function () {

    // deposit to strategies
    await router.depositToBatch(usdc.address, parseUsdc("10"));
    await skipCycleAndBlocks();
    await router.depositToStrategies();

    // deploy new strategy
    const Farm = await ethers.getContractFactory("biswap_busd_usdt");
    farm2 = strategyBiswap = await Farm.deploy(router.address);
    await farm2.deployed();
    await farm2.transferOwnership(router.address);

    // add new farm
    await router.addStrategy(farm2.address, usdc.address, 1000);

    // remove 2nd farm with index 1
    await router.removeStrategy(1);

    // withdraw user shares
    let receipts = await receiptContract.walletOfOwner(owner.address);
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
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  });

  it("Test rebalance function", async function () {

    // console.log("strategies balance", await router.viewStrategiesValue());

    // deposit to strategies
    await router.updateStrategy(0, 1000);
    await router.updateStrategy(1, 9000);

    await router.rebalanceStrategies();

    let { balances, totalBalance } = await router.viewStrategiesValue();
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
    await skipCycleAndBlocks();
    // await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    // await provider.send("evm_mine");
    await router.depositToStrategies();

    // user deposit
    await router.depositToBatch(usdc.address, parseUsdc("100"));
    await router.depositToBatch(usdc.address, parseUsdc("100"));
    // // deposit to strategies
    await skipCycleAndBlocks();
    await router.depositToStrategies();

    let receipts = await receiptContract.walletOfOwner(owner.address);
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

    receipts = await receiptContract.walletOfOwner(owner.address);


    // await router.withdrawShares(1, usdc.address);
    expect(await usdc.balanceOf(strategyBiswap2.address)).to.equal(0);
    expect(await usdc.balanceOf(strategyBiswap.address)).to.be.lt(parseUsdc("1"));
    expect(await usdc.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.within(0, 10);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  });

});

