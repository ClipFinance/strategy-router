const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");

// ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 
provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 6);
parseUst = (args) => parseUnits(args, 18);
parseUniform = (args) => parseUnits(args, 18);
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

describe("Test StrategyRouter contract", function () {

  it("Define globals", async function () {

    [owner, joe, bob] = await ethers.getSigners();

    // ~~~~~~~~~~~ GET UST TOKENS ON MAINNET ~~~~~~~~~~~ 

    UST = "0xa47c8bf37f92aBed4A126BDA807A7b7498661acD";
    ust = await ethers.getContractAt("ERC20", UST);

    ustHolder = "0xD6216fC19DB775Df9774a6E33526131dA7D19a2c";
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [ustHolder],
    });
    ustHolder = await ethers.getSigner(ustHolder);
    await ust.connect(ustHolder).transfer(
      owner.address,
      parseUnits("100000", 18)
    );

    // ~~~~~~~~~~~ GET USDC TOKENS ON MAINNET ~~~~~~~~~~~ 

    USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    usdc = await ethers.getContractAt("ERC20", USDC);

    usdcHolder = "0xE78388b4CE79068e89Bf8aA7f218eF6b9AB0e9d0";
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [usdcHolder],
    });
    usdcHolder = await ethers.getSigner(usdcHolder);
    await usdc.connect(usdcHolder).transfer(
      owner.address,
      parseUnits("100000", 6)
    );
  });

  it("Deploy StrategyRouter", async function () {

    // ~~~~~~~~~~~ DEPLOY StrategyRouter ~~~~~~~~~~~ 
    const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
    router = await StrategyRouter.deploy();
    await router.deployed();
    await router.setMinUsdPerCycle(parseUniform("1.0"));

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
    CYCLE_DURATION = Number(await router.CYCLE_DURATION());
    INITIAL_SHARES = Number(await router.INITIAL_SHARES());

    // console.log(await exchange.estimateGas.test(parseUst("10"), ust.address, usdc.address));
    // console.log(await exchange.test(parseUsdc("1000"), usdc.address, ust.address));
    // console.log(await exchange.test(parseUst("1000"), ust.address, usdc.address));
  });

  it("Deploy fake farms", async function () {
    const FarmUnprofitable = await ethers.getContractFactory("MockFarm");
    farmUnprofitable = await FarmUnprofitable.deploy(ust.address, 10000);
    await farmUnprofitable.deployed();

    const Farm = await ethers.getContractFactory("MockFarm");
    farm = await Farm.deploy(usdc.address, 20000);
    await farm.deployed();
  });

  it("Add strategies and stablecoins", async function () {
    await router.setSupportedStablecoin(usdc.address, true);
    await router.setSupportedStablecoin(ust.address, true);

    await router.addStrategy(farmUnprofitable.address, ust.address, 1000);
    await router.addStrategy(farm.address, usdc.address, 9000);
  });

  
  it("Admin initial deposit", async function () {
    await ust.approve(router.address, parseUst("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));

    let pools = await exchange.findCurvePools(router.address, ust.address, parseUst("100"));
    // admin initial deposit seems to be fix for a problem, 
    // if you deposit and withdraw multiple times (without initial deposit)
    // then pps and shares become broken (they increasing because of dust always left on farms)
    await router.depositToBatch(pools, ust.address, parseUst("100"));
    await skipCycleTime();
    await router.depositToStrategies();
    await skipCycleTime();

    expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  });

  it("User deposit", async function () {

    let pools = await exchange.findCurvePools(router.address, ust.address, parseUst("100"));
    await router.depositToBatch(pools, ust.address, parseUst("100"))

    expect(await ust.balanceOf(router.address)).to.be.closeTo(
      parseUst("10"),
      parseUst("0.3")
    );
    expect(await usdc.balanceOf(router.address)).to.be.closeTo(
      parseUsdc("90"),
      parseUsdc("0.3")
    );
  });

  it("User withdraw half from current cycle", async function () {
    let receipt = await receiptContract.viewReceipt(1);
    let oldBalance = await usdc.balanceOf(owner.address);
    let pools = await exchange.findCurvePools(router.address, usdc.address, parseUsdc("100"));
    await router.withdrawFromBatching(pools, 1, usdc.address, receipt.amount.div(2));
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("1.0")
    );
  });

  it("User withdraw other half from current cycle", async function () {
    let oldBalance = await usdc.balanceOf(owner.address);
    let pools = await exchange.findCurvePools(router.address, usdc.address, parseUsdc("100"));
    await router.withdrawFromBatching(pools, 1, usdc.address, 0);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("1.0")
    );
  });

  it("User deposit", async function () {
    let pools = await exchange.findCurvePools(router.address, ust.address, parseUst("100"));
    await router.depositToBatch(pools, ust.address, parseUst("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();
    expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
      parseUniform("290"),
      parseUniform("1.0")
    );
  });

  it("User deposit", async function () {
    let pools = await exchange.findCurvePools(router.address, ust.address, parseUst("100"));
    await router.depositToBatch(pools, ust.address, parseUst("100"));
  });

  it("Send funds to farm to simulate balance growth", async function () {
    await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();

    expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
      parseUniform("660"),
      parseUniform("3.0")
    );
  });

  it("Withdraw half from strategies", async function () {
    let receipt = await receiptContract.viewReceipt(2);
    let oldBalance = await usdc.balanceOf(owner.address);
    let pools = await exchange.findCurvePools(router.address, usdc.address, parseUsdc("100"));
    await router.withdrawByReceipt(pools, 2, usdc.address, receipt.amount.div(2));
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("95"),
      parseUniform("1.0")
    );
  });

  it("Withdraw other half from strategies", async function () {
    let shares = await sharesToken.balanceOf(owner.address);
    let oldBalance = await usdc.balanceOf(owner.address);
    let pools = await exchange.findCurvePools(router.address, usdc.address, parseUsdc("100"));
    await router.withdrawShares(pools, shares, usdc.address);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("95"),
      parseUniform("1.0")
    );
  });

  it("Withdraw from strategies", async function () {
    await printStruct(await receiptContract.viewReceipt(3));
    let oldBalance = await usdc.balanceOf(owner.address);
    let pools = await exchange.findCurvePools(router.address, usdc.address, parseUsdc("100"));
    await router.withdrawByReceipt(pools, 3, usdc.address, 0);
    let newBalance = await usdc.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("100"),
      parseUniform("1.0")
    );

    // should've withdrawn all (excpet admin), so verify that

    expect(await ust.balanceOf(farm.address)).to.equal(0);
    expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
    expect(await ust.balanceOf(router.address)).to.equal(0);
    expect(await usdc.balanceOf(router.address)).to.equal(0);

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(INITIAL_SHARES);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

    expect(await ust.balanceOf(farmUnprofitable.address)).to.be.closeTo(
      parseUst("16"), 
      parseUst("1")
    );
    expect(await usdc.balanceOf(farm.address)).to.be.closeTo(
      parseUsdc("170"), 
      parseUsdc("1")
    );
  });

  it("Farms should be empty on withdraw all multiple times", async function () {

    console.log("strategies balance", await router.viewStrategiesBalance());
    

    for (let i = 0; i < 5; i++) {
      let pools = await exchange.findCurvePools(router.address, ust.address, parseUst("100"));
      await router.depositToBatch(pools, ust.address, parseUst("10"));
      await skipCycleTime();
      await router.depositToStrategies();
      await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));
      let receipts = await receiptContract.walletOfOwner(owner.address);
      receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
      console.log(receipts);
      pools = await exchange.findCurvePools(router.address, usdc.address, parseUsdc("100"));
      await router.withdrawByReceipt(pools, receipts[0], usdc.address, 0);
      
      console.log("strategies balance", await router.viewStrategiesBalance(), await receiptContract.walletOfOwner(owner.address));
    }

    expect(await ust.balanceOf(farm.address)).to.equal(0);
    expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
    expect(await ust.balanceOf(router.address)).to.equal(0);
    expect(await usdc.balanceOf(router.address)).to.equal(0);

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(INITIAL_SHARES);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

    // admin initial deposit
    expect(await ust.balanceOf(farmUnprofitable.address)).to.be.closeTo(
      parseUst("21"), 
      parseUst("1")
    );
    expect(await usdc.balanceOf(farm.address)).to.be.closeTo(
      parseUsdc("5719"), 
      parseUsdc("1")
    );
  });

  it("Remove strategy", async function () {

    console.log("strategies balance", await router.viewStrategiesBalance());
    
    for (let i = 0; i < 2; i++) {
      let pools = await exchange.findCurvePools(router.address, ust.address, parseUst("100"));
      await router.depositToBatch(pools, ust.address, parseUst("10"));
      await skipCycleTime();
      await router.depositToStrategies();
      await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));
      // let receipts = await receiptContract.walletOfOwner(owner.address);
      // receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
      // console.log(receipts);
      // await router.withdrawByReceipt(receipts[0], usdc.address, 0);
      
      console.log("strategies balance", await router.viewStrategiesBalance(), await receiptContract.walletOfOwner(owner.address));
    }

    expect(await ust.balanceOf(farm.address)).to.equal(0);
    expect(await usdc.balanceOf(farmUnprofitable.address)).to.be.equal(0);
    expect(await ust.balanceOf(router.address)).to.equal(0);
    expect(await usdc.balanceOf(router.address)).to.equal(0);

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(INITIAL_SHARES);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

    expect(await ust.balanceOf(farmUnprofitable.address)).to.be.closeTo(
      parseUst("21"), 
      parseUst("1")
    );
    expect(await usdc.balanceOf(farm.address)).to.be.closeTo(
      parseUsdc("5719"), 
      parseUsdc("1")
    );
  });

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
    // await router.withdrawByReceipt(3, usdc.address, 0);
    // await router.withdrawByReceipt(4, ust.address, 0);

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

describe("Test walletOfOwner function", function () {
  it("Snapshot evm", async function () {
    snapshotId = await provider.send("evm_snapshot");
  });
  it("Deploy ReceiptNFT", async function () {
    receiptContract = await ethers.getContractFactory("ReceiptNFT");
    receiptContract = await receiptContract.deploy();
    arrayToNubmer = arr => arr.map(n => n.toNumber());
  });
  it("Wallet with 0 tokens", async function () {
    expect(await receiptContract.walletOfOwner(owner.address)).to.be.empty;
  });
  it("Wallet with 1 token", async function () {
    await receiptContract.mint(0, 0, owner.address);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
    expect(await receiptContract.walletOfOwner(joe.address)).to.be.empty;
  });
  it("Two wallets with 1 token", async function () {
    await receiptContract.mint(0, 0, joe.address);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(joe.address))).to.be.eql([1]);
  });
  it("Two wallets with more tokens", async function () {
    await receiptContract.mint(0, 0, owner.address);
    await receiptContract.mint(0, 0, joe.address);
    await receiptContract.mint(0, 0, owner.address);
    await receiptContract.mint(0, 0, joe.address);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([4, 2, 0]);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(joe.address))).to.be.eql([5, 3, 1]);
  });

  // it("Measure amount of tokens needed to return or iterate to break function", async function () {
  //   for (let i = 0; i < 10000; i++) {
  //     await receiptContract.mint(0, 0, owner.address);
  //   }
  //   await receiptContract.mint(0, 0, joe.address);
  //   let walletOfOwner = arrayToNubmer(await receiptContract.walletOfOwner(joe.address));
  //   console.log(walletOfOwner);
  //   walletOfOwner = arrayToNubmer(await receiptContract.walletOfOwner(owner.address));
  //   console.log(walletOfOwner);
  //   // expect().to.be.eql([4,2,0]);
  // });

  it("Revert evm", async function () {
    await provider.send("evm_revert", [snapshotId]);
  });
});

async function skipCycleTime() {
  await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  await provider.send("evm_mine");
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