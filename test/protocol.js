const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");

// ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 
provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 18);
parseUst = (args) => parseUnits(args, 18);
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

    // ~~~~~~~~~~~ GET BUSD ON MAINNET ~~~~~~~~~~~ 

    BUSD = "0xe9e7cea3dedca5984780bafc599bd69add087d56";
    busd = await ethers.getContractAt("ERC20", BUSD);

    // ~~~~~~~~~~~ GET UST TOKENS ON MAINNET ~~~~~~~~~~~ 

    UST = "0x23396cf899ca06c4472205fc903bdb4de249d6fc";
    ust = await ethers.getContractAt("ERC20", UST);

    ustHolder = "0x05faf555522fa3f93959f86b41a3808666093210";
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [ustHolder],
    });
    ustHolder = await ethers.getSigner(ustHolder);
    await network.provider.send("hardhat_setBalance", [
      ustHolder.address.toString(),
      "0x" + Number(parseEther("1").toHexString(2)).toString(2),
    ]);
    await ust.connect(ustHolder).transfer(
      owner.address,
      parseUst("500000")
    );

    // ~~~~~~~~~~~ GET USDC TOKENS ON MAINNET ~~~~~~~~~~~ 

    USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
    usdc = await ethers.getContractAt("ERC20", USDC);

    usdcHolder = "0xf977814e90da44bfa03b6295a0616a897441acec";
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [usdcHolder],
    });
    usdcHolder = await ethers.getSigner(usdcHolder);
    await usdc.connect(usdcHolder).transfer(
      owner.address,
      parseUsdc("500000")
    );

  });

  it("Deploy StrategyRouter", async function () {

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

    await router.setCycleDuration(60 * 60 * 24 * 30);
    CYCLE_DURATION = Number(await router.cycleDuration());
    INITIAL_SHARES = Number(await router.INITIAL_SHARES());

    // console.log(await exchange.estimateGas.test(parseUst("10"), ust.address, usdc.address));
    // console.log(await exchange.test(parseUsdc("1000"), usdc.address, ust.address));
    // console.log(await exchange.test(parseUst("1000"), ust.address, usdc.address));
  });

  it("Deploy acryptos_ust", async function () {

    // ~~~~~~~~~~~ DEPLOY Acryptos UST strategy ~~~~~~~~~~~ 
    strategyAcryptos = await ethers.getContractFactory("acryptos_ust");
    strategyAcryptos = await strategyAcryptos.deploy(router.address);
    await strategyAcryptos.deployed();
    await strategyAcryptos.transferOwnership(router.address);

    lpTokenAcryptos = await strategyAcryptos.lpToken();
    lpTokenAcryptos = await ethers.getContractAt("ERC20", lpTokenAcryptos);

    farmAcryptos = await strategyAcryptos.farm();
    farmAcryptos = await ethers.getContractAt("IACryptoSFarmV4", farmAcryptos);

    // zapDepositer = await strategy.zapDepositer();
    // zapDepositer = await ethers.getContractAt("IZapDepositer", zapDepositer);

  });

  it("Deploy biswap_ust_busd", async function () {

    // ~~~~~~~~~~~ DEPLOY Acryptos UST strategy ~~~~~~~~~~~ 
    strategyBiswap = await ethers.getContractFactory("biswap_ust_busd");
    strategyBiswap = await strategyBiswap.deploy(router.address);
    await strategyBiswap.deployed();
    await strategyBiswap.transferOwnership(router.address);

    lpTokenBiswap = await strategyBiswap.lpToken();
    lpTokenBiswap = await ethers.getContractAt("ERC20", lpTokenBiswap);

    farmBiswap = await strategyBiswap.farm();
    farmBiswap = await ethers.getContractAt("IBiswapFarm", farmBiswap);

    poolIdBiswap = await strategyBiswap.poolId();

  });

  it("Add strategies and stablecoins", async function () {
    await router.setSupportedStablecoin(ust.address, true);

    await router.addStrategy(strategyAcryptos.address, ust.address, 5000);
    await router.addStrategy(strategyBiswap.address, ust.address, 5000);
  });


  it("Admin initial deposit", async function () {
    await ust.approve(router.address, parseUst("1000000"));

    // admin initial deposit seems to be fix for a problem, 
    // if you deposit and withdraw multiple times (without initial deposit)
    // then pps and shares become broken (they increasing because of dust always left on farms)
    await router.depositToBatch(ust.address, parseUst("100"));
    await skipCycleTime();
    await router.depositToStrategies();
    await skipCycleTime();

    await logFarmLPs();

    expect(await sharesToken.totalSupply()).to.be.equal(INITIAL_SHARES);
  });

  it("User deposit", async function () {

    await router.depositToBatch(ust.address, parseUst("100"))

    expect(await ust.balanceOf(router.address)).to.be.closeTo(
      parseUst("100"),
      parseUst("0.1")
    );
  });

  it("User withdraw half from current cycle", async function () {
    let receipt = await receiptContract.viewReceipt(1);
    let oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawFromBatching(1, ust.address, receipt.amount.div(2));
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("0.2")
    );
  });

  it("User withdraw other half from current cycle", async function () {
    let oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawFromBatching(1, ust.address, 0);
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUsdc("0.2")
    );
  });

  it("User deposit", async function () {
    await router.depositToBatch(ust.address, parseUst("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();
    expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
      parseUniform("200"),
      parseUniform("0.5")
    );
  });

  it("User deposit", async function () {
    await router.depositToBatch(ust.address, parseUst("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();

    expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
      parseUniform("300"),
      parseUniform("0.5")
    );
  });

  it("Withdraw half from strategies", async function () {
    let receipt = await receiptContract.viewReceipt(2);
    let oldBalance = await ust.balanceOf(owner.address);
    // console.log(receipt.amount.div(2));
    await router.withdrawFromStrategies(2, ust.address, 5000);
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUniform("0.5")
    );
  });

  it("Withdraw other half from strategies", async function () {
    let shares = await sharesToken.balanceOf(owner.address);
    let oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawShares(shares, ust.address);
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("50"),
      parseUniform("0.5")
    );
  });

  it("Withdraw from strategies", async function () {
    await printStruct(await receiptContract.viewReceipt(3));
    let oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawFromStrategies(3, ust.address, 10000);
    let newBalance = await ust.balanceOf(owner.address);

    await logFarmLPs();
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("100"),
      parseUniform("1.0")
    );

    // should've withdrawn all (excpet admin), so verify that
    expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
    expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
    expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  });

  it("Farms should be empty on withdraw all multiple times", async function () {

    console.log("strategies balance", await router.viewStrategiesBalance());
    
    await logFarmLPs();

    for (let i = 0; i < 5; i++) {
      await router.depositToBatch(ust.address, parseUst("10"));
      await skipCycleTime();
      await router.depositToStrategies();
      let receipts = await receiptContract.walletOfOwner(owner.address);
      receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
      // console.log(receipts);
      await router.withdrawFromStrategies(receipts[0], ust.address, 10000);

      console.log("strategies balance");
      printStruct(await router.viewStrategiesBalance());
      await logFarmLPs();
    }

    console.log("strategy router ust %s", await ust.balanceOf(router.address));
    console.log("strategyBiswap ust %s", await ust.balanceOf(strategyBiswap.address));
    console.log("strategyAcryptos ust %s", await ust.balanceOf(strategyAcryptos.address));
    console.log("strategyBiswap busd %s", await busd.balanceOf(strategyBiswap.address));

    expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
    expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
    expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  });

  it("Remove strategy", async function () {

    console.log("strategies balance", await router.viewStrategiesBalance());

    // deposit to strategies
    await router.depositToBatch(ust.address, parseUst("10"));
    await skipCycleTime();
    await router.depositToStrategies();
    console.log("strategies balance", await router.viewStrategiesBalance(), await receiptContract.walletOfOwner(owner.address));

    // deploy new acryptos farm
    const Farm = await ethers.getContractFactory("acryptos_ust");
    farm2 = strategyBiswap = await Farm.deploy(router.address);
    await farm2.deployed();
    await farm2.transferOwnership(router.address);

    // add new farm
    await router.addStrategy(farm2.address, ust.address, 1000);

    // remove 2nd farm with index 1
    await router.removeStrategy(1);

    // withdraw user shares
    let receipts = await receiptContract.walletOfOwner(owner.address);
    console.log(receipts);
    receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
    let oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawFromStrategies(receipts[0], ust.address, 10000);
    let newBalance = await ust.balanceOf(owner.address);
    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUsdc("10"),
      parseUniform("0.5")
    );


    expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
    expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
    expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  });

  it("Test rebalance function", async function () {

    // console.log("strategies balance", await router.viewStrategiesBalance());
    await logFarmLPs();

    // deposit to strategies
    await router.updateStrategy(0, 1000);
    await router.updateStrategy(1, 9000);

    await router.rebalance(usdc.address);

    let { balances, totalBalance } = await router.viewStrategiesBalance();
    // strategies should be balanced as 10% and 90%
    expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(10, 1);
    expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(90, 1);
    console.log("strategies balance");
    printStruct(await router.viewStrategiesBalance());

    await logFarmLPs();
  });

  it("Scenario", async function () {

    ////////
    // user deposit
    await router.depositToBatch(ust.address, parseUst("100000"));
    await router.depositToBatch(ust.address, parseUst("100000"));
    // deposit to strategies
    await skipCycleTime();
    // await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    // await provider.send("evm_mine");
    await router.depositToStrategies();

    // user deposit
    await router.depositToBatch(ust.address, parseUst("100"));
    await router.depositToBatch(ust.address, parseUsdc("100"));
    // // deposit to strategies
    await skipCycleTime();
    await router.depositToStrategies();

    let receipts = await receiptContract.walletOfOwner(owner.address);
    console.log("owner receipts", receipts);
    // withdraw by receipt
    let oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawFromStrategies(10, ust.address, 10000);
    let newBalance = await ust.balanceOf(owner.address);
    console.log("withdrawFromStrategies %s", newBalance.sub(oldBalance));

    oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawFromStrategies(11, ust.address, 10000);
    newBalance = await ust.balanceOf(owner.address);
    console.log("withdrawFromStrategies %s", newBalance.sub(oldBalance));

    // unlock shares and withdraw tokens by shares
    await router.unlockSharesFromNFT(12);
    let sharesUnlocked = await sharesToken.balanceOf(owner.address);
    console.log("sharesUnlocked", sharesUnlocked);

    oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawShares(sharesUnlocked, ust.address);
    newBalance = await ust.balanceOf(owner.address);
    console.log("withdrawFromStrategies %s", newBalance.sub(oldBalance));

    await router.unlockSharesFromNFT(13);
    sharesUnlocked = await sharesToken.balanceOf(owner.address);
    console.log("sharesUnlocked", sharesUnlocked);
    oldBalance = await ust.balanceOf(owner.address);
    await router.withdrawShares(sharesUnlocked, ust.address);
    newBalance = await ust.balanceOf(owner.address);
    console.log("withdrawFromStrategies %s", newBalance.sub(oldBalance));
    console.log("strategies balance");
    printStruct(await router.viewStrategiesBalance());
    console.log("strategyBiswap ust %s", await ust.balanceOf(strategyBiswap.address));
    console.log("strategyAcryptos ust %s", await ust.balanceOf(strategyAcryptos.address));
    console.log("strategyBiswap busd %s", await busd.balanceOf(strategyBiswap.address));

    receipts = await receiptContract.walletOfOwner(owner.address);
    console.log("owner receipts", receipts);

    await logFarmLPs();

    // await router.withdrawShares(1, ust.address);
    expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
    expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
    expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

    expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
    expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  });

});


async function logFarmLPs() {
    userInfo = await farmAcryptos.userInfo(lpTokenAcryptos.address, strategyAcryptos.address);
    console.log("acryptos farm lp tokens %s", userInfo.amount);
    userInfo = await farmBiswap.userInfo(poolIdBiswap, strategyBiswap.address);
    console.log("biswap farm lp tokens %s", userInfo.amount);
}
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