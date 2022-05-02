const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, MaxUint256 } = require("./utils");

// ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 
provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 18);
parseUst = (args) => parseUnits(args, 18);
parseUniform = (args) => parseUnits(args, 18);
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

describe("Test StrategyRouter with fake strategies", function () {

  // it("Snapshot evm", async function () {
  //   snapshotId = await provider.send("evm_snapshot");
  // });

  // after(async function () {
  //   await provider.send("evm_revert", [snapshotId]);
  // });

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

  // beforeEach(async function () {
  //   // await provider.send("evm_revert", [snapshotId]);
  //   // snapshotId = await provider.send("evm_snapshot");
  // });

  beforeEach(async function () {
    await setupTokens();
    await setupCore();
    await setupFarms();
    await setupSettings();
    await adminInitialDeposit();
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

    const Farm = await ethers.getContractFactory("MockFarm");
    farm = await Farm.deploy(usdc.address, 20000);
    await farm.deployed();
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

    // admin initial deposit seems to be fix for a problem, 
    // if you deposit and withdraw multiple times (without initial deposit)
    // then pps and shares become broken (they increasing because of dust always left on farms)
    await router.depositToBatch(ust.address, parseUst("100"));
    await skipCycleTime();
    await router.depositToStrategies();
    await skipCycleTime();

    expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  };

  it("depositToBatch", async function () {
    await router.depositToBatch(ust.address, parseUst("100"))
    expect(await ust.balanceOf(router.address)).to.be.equal(parseUst("100"));
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

    let oldBalance = await usdc.balanceOf(owner.address);
    await router.withdrawFromBatching([1], usdc.address, MaxUint256);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
  });

  // it("Deposit to strategies", async function () {
  //   await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  //   await provider.send("evm_mine");

  //   await router.depositToStrategies();
  //   expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
  //     parseUniform("290"),
  //     parseUniform("1.0")
  //   );
  // });

  // it("User deposit", async function () {
  //   await router.depositToBatch(ust.address, parseUst("100"));
  // });

  // it("Send funds to farm to simulate balance growth", async function () {
  //   await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));
  // });

  // it("Deposit to strategies", async function () {
  //   await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  //   await provider.send("evm_mine");

  //   await router.depositToStrategies();

  //   expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
  //     parseUniform("660"),
  //     parseUniform("3.0")
  //   );
  // });

  // it("Withdraw other half from strategies", async function () {
  //   let shares = await sharesToken.balanceOf(owner.address);
  //   let oldBalance = await usdc.balanceOf(owner.address);
  //   await router.withdrawShares(shares, usdc.address);
  //   let newBalance = await usdc.balanceOf(owner.address);

  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("96"),
  //     parseUniform("1.0")
  //   );
  // });

  // it("Withdraw from strategies", async function () {
  //   await printStruct(await receiptContract.viewReceipt(3));
  //   let oldBalance = await usdc.balanceOf(owner.address);
  //   await router.withdrawFromStrategies(3, usdc.address, 10000);
  //   let newBalance = await usdc.balanceOf(owner.address);

  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("100"),
  //     parseUniform("1.0")
  //   );

  //   // should've withdrawn all (excpet admin), so verify that

  //   expect(await ust.balanceOf(farm.address)).to.equal(0);
  //   expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
  //   expect(await ust.balanceOf(router.address)).to.equal(0);
  //   expect(await usdc.balanceOf(router.address)).to.equal(0);

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  //   expect(await ust.balanceOf(farmUnprofitable.address)).to.be.closeTo(
  //     parseUst("16"), 
  //     parseUst("1")
  //   );
  //   expect(await usdc.balanceOf(farm.address)).to.be.closeTo(
  //     parseUsdc("170"), 
  //     parseUsdc("1")
  //   );
  // });

  // it("Farms should be empty on withdraw all multiple times", async function () {

  //   console.log("strategies balance", await router.viewStrategiesBalance());
    

  //   for (let i = 0; i < 5; i++) {
  //     await router.depositToBatch(ust.address, parseUst("10"));
  //     await skipCycleTime();
  //     await router.depositToStrategies();
  //     await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));
  //     let receipts = await receiptContract.walletOfOwner(owner.address);
  //     receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
  //     console.log(receipts);
  //     await router.withdrawFromStrategies(receipts[0], usdc.address, 10000);
      
  //     console.log("strategies balance", await router.viewStrategiesBalance(), await receiptContract.walletOfOwner(owner.address));
  //   }

  //   expect(await ust.balanceOf(farm.address)).to.equal(0);
  //   expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
  //   expect(await ust.balanceOf(router.address)).to.equal(0);
  //   expect(await usdc.balanceOf(router.address)).to.equal(0);

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  //   // admin initial deposit
  //   expect(await ust.balanceOf(farmUnprofitable.address)).to.be.closeTo(
  //     parseUst("21"), 
  //     parseUst("1")
  //   );
  //   expect(await usdc.balanceOf(farm.address)).to.be.closeTo(
  //     parseUsdc("5682"), 
  //     parseUsdc("1")
  //   );
  // });

  // it("Remove strategy", async function () {

  //   console.log("strategies balance", await router.viewStrategiesBalance());

  //   // deposit to strategies
  //   await router.depositToBatch(ust.address, parseUst("10"));
  //   await skipCycleTime();
  //   await router.depositToStrategies();
  //   console.log("strategies balance", await router.viewStrategiesBalance(), await receiptContract.walletOfOwner(owner.address));
    

  //   let simulateGrowthAmount = (await farm.totalTokens()).sub(await usdc.balanceOf(farm.address));
  //   simulateGrowthAmount = simulateGrowthAmount.mul(3); // removeStrategy calls compound
  //   await usdc.transfer(farm.address, simulateGrowthAmount);

  //   // deploy new farm
  //   const Farm = await ethers.getContractFactory("MockFarm");
  //   farm2 = await Farm.deploy(usdc.address, 10000);
  //   await farm2.deployed();

  //   // add new farm
  //   await router.addStrategy(farm2.address, usdc.address, 1000);

  //   // remove 2nd farm with index 1
  //   await router.removeStrategy(1);

  //   // withdraw user shares
  //   let receipts = await receiptContract.walletOfOwner(owner.address);
  //   console.log('1', receipts);
  //   receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
  //   let oldBalance = await usdc.balanceOf(owner.address);
  //   await router.withdrawFromStrategies(receipts[0], usdc.address, 10000);
  //   let newBalance = await usdc.balanceOf(owner.address);
  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("21"),
  //     parseUniform("1.0")
  //   );


  //   expect(await ust.balanceOf(farm.address)).to.equal(0);
  //   expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
  //   expect(await ust.balanceOf(router.address)).to.equal(0);
  //   expect(await usdc.balanceOf(router.address)).to.equal(0);

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  //   // expect(await ust.balanceOf(farmUnprofitable.address)).to.be.closeTo(
  //   //   parseUst("22361"), 
  //   //   parseUst("1")
  //   // );
  //   // expect(await usdc.balanceOf(farm.address)).to.be.closeTo(
  //   //   parseUsdc("10987"), 
  //   //   parseUsdc("1")
  //   // );
  // });

  // it("Test rebalance function", async function () {

  //   // console.log("strategies balance", await router.viewStrategiesBalance());

  //   // deposit to strategies
  //   await router.updateStrategy(0, 1000);
  //   await router.updateStrategy(1, 9000);

  //   await router.rebalance(usdc.address);

  //   let {balances, totalBalance} = await router.viewStrategiesBalance();
  //   // strategies should be balanced as 10% and 90%
  //   expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(10, 1);
  //   expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(90, 1);
  //   // console.log("strategies balance", await router.viewStrategiesBalance());
  // });

  // it("Scenario", async function () {

    //////////
    // // user deposit
    // await router.depositToBatch(ust.address, parseUst("100"));
    // // await router.depositToBatch(usdc.address, parseUsdc("100"));
    // // deposit to strategies
    // await skipCycleTime();
    // await router.depositToStrategies();

    // // user deposit
    // // await router.depositToBatch(ust.address, parseUst("100"));
    // // await router.depositToBatch(usdc.address, parseUsdc("100"));
    // // // deposit to strategies
    // // await skipCycleTime();
    // // await router.depositToStrategies();

    // // simulate growth on farm
    // await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));

    // let receipts = await receiptContract.walletOfOwner(owner.address);
    // console.log(receipts);
    // // withdraw by receipt
    // await router.withdrawFromStrategies(3, usdc.address, 10000);
    // await router.withdrawFromStrategies(4, ust.address, 10000);

    // // convert receipts to shares and withdraw using shares
    // await router.unlockSharesFromNFT(5);
    // let sharesUnlocked = await sharesToken.balanceOf(owner.address);
    // console.log("sharesUnlocked", sharesUnlocked);
    // await router.withdrawShares(sharesUnlocked, ust.address);

    // await router.unlockSharesFromNFT(6);
    // sharesUnlocked = await sharesToken.balanceOf(owner.address);
    // console.log("sharesUnlocked", sharesUnlocked);
    // await router.withdrawShares(sharesUnlocked, usdc.address);

    // console.log("strategies balance", await router.viewStrategiesBalance());

  //   expect(await ust.balanceOf(farm.address)).to.equal(0);
  //   expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
  //   expect(await ust.balanceOf(router.address)).to.equal(0);
  //   expect(await usdc.balanceOf(router.address)).to.equal(0);

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  //   expect(await ust.balanceOf(farmUnprofitable.address)).to.be.within(0, 3e3);
  //   expect(await usdc.balanceOf(farm.address)).to.be.within(0, 10);
  // });

});

async function skipCycleTime() {
  await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  await provider.send("evm_mine");

  // skip blocks (div by 3 coz its bsc simulation)
  let MONTH_BLOCKS = CYCLE_DURATION / 3;
  MONTH_BLOCKS = "0x" + MONTH_BLOCKS.toString(16);
  await hre.network.provider.send("hardhat_mine", [MONTH_BLOCKS]);
}

function printStruct(struct) {
  let obj = struct;
  let out = {};
  for (let key in obj) {
    if (!Number.isInteger(Number(key))) {
      out[key] = obj[key];
    }
  }
  console.log(out);
}