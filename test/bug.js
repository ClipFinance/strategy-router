const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, skipCycleTime, printStruct, logFarmLPs, BLOCKS_MONTH, skipBlocks, BLOCKS_DAY } = require("./utils");

// ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 
provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 18);
parseUst = (args) => parseUnits(args, 18);
parseUniform = (args) => parseUnits(args, 18);
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

describe("Trying to find source of bug", function () {


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
    // ~~~~~~~~~~~ GET BSW TOKENS ON MAINNET ~~~~~~~~~~~ 
    BSW = "0x965F527D9159dCe6288a2219DB51fc6Eef120dD1";
    bswHolder = "0x000000000000000000000000000000000000dead";
    bsw = await getTokens(BSW, bswHolder, parseEther("10000000"), owner.address);

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

    await router.setCycleDuration(1);
    CYCLE_DURATION = Number(await router.cycleDuration());
    INITIAL_SHARES = await router.INITIAL_SHARES();

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
    // await router.addStrategy(strategyBiswap.address, ust.address, 5000);
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

    for (let i = 0; i < 2; i++) {
      
      await router.depositToBatch(ust.address, parseUst("2200"))
      await router.depositToBatch(ust.address, parseUst("2200"))
      await router.depositToBatch(ust.address, parseUst("700"))
      await router.depositToBatch(ust.address, parseUst("700"))
      
      await skipCycleTime();
      
      await router.depositToStrategies();
    }
    console.log(await receiptContract.walletOfOwner(owner.address));
  });

  it("Skip blocks to get BSW rewards AND compound all", async function () {
    // compounding biswap twice per 24h not gives profit!
    // compounding acryptos twice per 24h gives even less profits!

    // only biswap strategy, 1 compound per 24h:
    // 11691.634549579642837847
    // 12647.927610114806310755 (gain 7.5%)
    // once in 2 month compound 12642.637221809520289322

    // only acrypts strategy, 1 compound per 24h:
    // 11695.36963410516658027
    // 11785.875757304756469757 (gain 0.77%)
    // compound once a month 11831.92601472858452229 (+1.14 %)

    console.log("before year of compounding", formatEther((await router.viewStrategiesBalance()).totalBalance.toString()));
    console.log("getBlockNumber: ", await provider.getBlockNumber());
    // await skipBlocks(BLOCKS_MONTH * 12);
    // await skipCycleTime();

    let yearCompounds = 30*12;
    for (let i = 0; i < yearCompounds; i++) {
      // await provider.send("evm_increaseTime", [100]);
      // await provider.send("evm_mine");


      // tokenA.approve(address(poolACS4UST), amountA);

      //   int128 _tokenAIndex = coinIds[address(poolACS4UST)][address(tokenA)];
      //   int128 _tokenBIndex = coinIds[address(poolACS4UST)][address(tokenB)];

        // console.log("_tokenAIndex %s _tokenBIndex %s amountA %s", uint128(_tokenAIndex), uint128(_tokenBIndex), amountA);
        // uint256 received = poolACS4UST.exchange_underlying(
        //     _tokenAIndex,
        //     _tokenBIndex,
        //     amountA,
        //     0
        // );

      // ~~~~~~~~~~~ Simulate ust <-> busd swaps ~~~~~~~~~~~ 
      await ust.approve(acsUst.address, parseEther("100000000"));
      await busd.approve(acsUst.address, parseEther("1000000000"));
      await acsUst.exchange_underlying(
        0, //ust
        1, // busd
        parseUst("200000"),
        0
      );
      await acsUst.exchange_underlying(
        1, // busd
        0, //ust
        await busd.balanceOf(owner.address),
        0
      );

      await skipBlocks(BLOCKS_DAY);
      await router.compoundAll();
    }
    console.log("getBlockNumber: ", await provider.getBlockNumber());

    console.log("after year of compounding", formatEther((await router.viewStrategiesBalance()).totalBalance));
  });

  it("Withdraw from strategies", async function () {

    let receipts = await receiptContract.walletOfOwner(owner.address);
    receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
    for (; 0 < receipts.length; ) {
      
      let receiptData = await receiptContract.viewReceipt(receipts[0]);
      let oldBalance = await ust.balanceOf(owner.address);
      await router.withdrawByReceipt(receipts[0], ust.address, 10000);
      let newBalance = await ust.balanceOf(owner.address);

      // console.log("RECEIPT", receiptData)
      // expect(newBalance.sub(oldBalance)).to.be.closeTo(
      //   (receiptData.amount).mul(parseUst("1")).div(parseEther("1")),
      //   parseUst("5")
      // );

      receipts = receipts.filter(id => id != receipts[0]); 
      // await logFarmLPs();
    }

    console.log(await receiptContract.walletOfOwner(owner.address));

    console.log("strategies balance");
    printStruct(await router.viewStrategiesBalance());

    // should've withdrawn all (excpet admin), so verify that
    // expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
    // expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
    // expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);

    expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
    expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
    expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  });

  // it("Farms should be empty on withdraw all multiple times", async function () {

  //   console.log("strategies balance", await router.viewStrategiesBalance());
    
  //   await logFarmLPs();

  //   for (let i = 0; i < 55; i++) {
  //     await router.depositToBatch(ust.address, parseUst("10"));
  //     await skipCycleTime();
  //     await router.depositToStrategies();
  //     let receipts = await receiptContract.walletOfOwner(owner.address);
  //     receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
  //     // console.log(receipts);
  //     await router.withdrawByReceipt(receipts[0], ust.address, 10000);

  //     console.log("strategies balance");
  //     printStruct(await router.viewStrategiesBalance());
  //     await logFarmLPs();
  //   }

  //   console.log("strategy router ust %s", await ust.balanceOf(router.address));
  //   console.log("strategyBiswap ust %s", await ust.balanceOf(strategyBiswap.address));
  //   console.log("strategyAcryptos ust %s", await ust.balanceOf(strategyAcryptos.address));
  //   console.log("strategyBiswap busd %s", await busd.balanceOf(strategyBiswap.address));

  //   expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
  //   expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
  //   expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  // });

  // it("User withdraw other half from current cycle", async function () {
  //   let oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawFromBatching(1, ust.address, 0);
  //   let newBalance = await ust.balanceOf(owner.address);

  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("50"),
  //     parseUsdc("0.2")
  //   );
  // });

  // it("User deposit", async function () {
  //   await router.depositToBatch(ust.address, parseUst("100"));
  // });

  // it("Deposit to strategies", async function () {
  //   await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  //   await provider.send("evm_mine");

  //   await router.depositToStrategies();
  //   expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
  //     parseUniform("200"),
  //     parseUniform("0.5")
  //   );
  // });

  // it("User deposit", async function () {
  //   await router.depositToBatch(ust.address, parseUst("100"));
  // });

  // it("Deposit to strategies", async function () {
  //   await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  //   await provider.send("evm_mine");

  //   await router.depositToStrategies();

  //   expect((await router.viewStrategiesBalance()).totalBalance).to.be.closeTo(
  //     parseUniform("300"),
  //     parseUniform("0.5")
  //   );
  // });

  // it("Withdraw half from strategies", async function () {
  //   let receipt = await receiptContract.viewReceipt(2);
  //   let oldBalance = await ust.balanceOf(owner.address);
  //   // console.log(receipt.amount.div(2));
  //   await router.withdrawByReceipt(2, ust.address, 5000);
  //   let newBalance = await ust.balanceOf(owner.address);

  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("50"),
  //     parseUniform("0.5")
  //   );
  // });

  // it("Withdraw other half from strategies", async function () {
  //   let shares = await sharesToken.balanceOf(owner.address);
  //   let oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawShares(shares, ust.address);
  //   let newBalance = await ust.balanceOf(owner.address);

  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("50"),
  //     parseUniform("0.5")
  //   );
  // });

  // it("Withdraw from strategies", async function () {
  //   await printStruct(await receiptContract.viewReceipt(3));
  //   let oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawByReceipt(3, ust.address, 10000);
  //   let newBalance = await ust.balanceOf(owner.address);

  //   await logFarmLPs();
  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("100"),
  //     parseUniform("1.0")
  //   );

  //   // should've withdrawn all (excpet admin), so verify that
  //   expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
  //   expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
  //   expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  // });

  // it("Farms should be empty on withdraw all multiple times", async function () {

  //   console.log("strategies balance", await router.viewStrategiesBalance());
    
  //   await logFarmLPs();

  //   for (let i = 0; i < 5; i++) {
  //     await router.depositToBatch(ust.address, parseUst("10"));
  //     await skipCycleTime();
  //     await router.depositToStrategies();
  //     let receipts = await receiptContract.walletOfOwner(owner.address);
  //     receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
  //     // console.log(receipts);
  //     await router.withdrawByReceipt(receipts[0], ust.address, 10000);

  //     console.log("strategies balance");
  //     printStruct(await router.viewStrategiesBalance());
  //     await logFarmLPs();
  //   }

  //   console.log("strategy router ust %s", await ust.balanceOf(router.address));
  //   console.log("strategyBiswap ust %s", await ust.balanceOf(strategyBiswap.address));
  //   console.log("strategyAcryptos ust %s", await ust.balanceOf(strategyAcryptos.address));
  //   console.log("strategyBiswap busd %s", await busd.balanceOf(strategyBiswap.address));

  //   expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
  //   expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
  //   expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  // });

  // it("Remove strategy", async function () {

  //   console.log("strategies balance", await router.viewStrategiesBalance());

  //   // deposit to strategies
  //   await router.depositToBatch(ust.address, parseUst("10"));
  //   await skipCycleTime();
  //   await router.depositToStrategies();
  //   console.log("strategies balance", await router.viewStrategiesBalance(), await receiptContract.walletOfOwner(owner.address));

  //   // deploy new acryptos farm
  //   const Farm = await ethers.getContractFactory("acryptos_ust");
  //   farm2 = strategyBiswap = await Farm.deploy(router.address);
  //   await farm2.deployed();
  //   await farm2.transferOwnership(router.address);

  //   // add new farm
  //   await router.addStrategy(farm2.address, ust.address, 1000);

  //   // remove 2nd farm with index 1
  //   await router.removeStrategy(1);

  //   // withdraw user shares
  //   let receipts = await receiptContract.walletOfOwner(owner.address);
  //   console.log(receipts);
  //   receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
  //   let oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawByReceipt(receipts[0], ust.address, 10000);
  //   let newBalance = await ust.balanceOf(owner.address);
  //   expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     parseUsdc("10"),
  //     parseUniform("0.5")
  //   );


  //   expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
  //   expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
  //   expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  // });

  // it("Test rebalance function", async function () {

  //   // console.log("strategies balance", await router.viewStrategiesBalance());
  //   await logFarmLPs();

  //   // deposit to strategies
  //   await router.updateStrategy(0, 1000);
  //   await router.updateStrategy(1, 9000);

  //   await router.rebalance(usdc.address);

  //   let { balances, totalBalance } = await router.viewStrategiesBalance();
  //   // strategies should be balanced as 10% and 90%
  //   expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(10, 1);
  //   expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(90, 1);
  //   console.log("strategies balance");
  //   printStruct(await router.viewStrategiesBalance());

  //   await logFarmLPs();
  // });

  // it("Scenario", async function () {

  //   ////////
  //   // user deposit
  //   await router.depositToBatch(ust.address, parseUst("100000"));
  //   await router.depositToBatch(ust.address, parseUst("100000"));
  //   // deposit to strategies
  //   await skipCycleTime();
  //   // await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  //   // await provider.send("evm_mine");
  //   await router.depositToStrategies();

  //   // user deposit
  //   await router.depositToBatch(ust.address, parseUst("100"));
  //   await router.depositToBatch(ust.address, parseUsdc("100"));
  //   // // deposit to strategies
  //   await skipCycleTime();
  //   await router.depositToStrategies();

  //   let receipts = await receiptContract.walletOfOwner(owner.address);
  //   console.log("owner receipts", receipts);
  //   // withdraw by receipt
  //   let oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawByReceipt(10, ust.address, 10000);
  //   let newBalance = await ust.balanceOf(owner.address);
  //   console.log("withdrawByReceipt %s", newBalance.sub(oldBalance));

  //   oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawByReceipt(11, ust.address, 10000);
  //   newBalance = await ust.balanceOf(owner.address);
  //   console.log("withdrawByReceipt %s", newBalance.sub(oldBalance));

  //   // unlock shares and withdraw tokens by shares
  //   await router.unlockSharesFromNFT(12);
  //   let sharesUnlocked = await sharesToken.balanceOf(owner.address);
  //   console.log("sharesUnlocked", sharesUnlocked);

  //   oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawShares(sharesUnlocked, ust.address);
  //   newBalance = await ust.balanceOf(owner.address);
  //   console.log("withdrawByReceipt %s", newBalance.sub(oldBalance));

  //   await router.unlockSharesFromNFT(13);
  //   sharesUnlocked = await sharesToken.balanceOf(owner.address);
  //   console.log("sharesUnlocked", sharesUnlocked);
  //   oldBalance = await ust.balanceOf(owner.address);
  //   await router.withdrawShares(sharesUnlocked, ust.address);
  //   newBalance = await ust.balanceOf(owner.address);
  //   console.log("withdrawByReceipt %s", newBalance.sub(oldBalance));
  //   // TODO: after each withdraw the admin's initial amount getting down...
  //   // initially it was 99... but here its become 98!
  //   // It can be seen even better by looking at output of the previous test block (with loop)
  //   // as on every iteration initial balance getting down by 0.01 or so...
  //   // TODO: there is 1 share left on contract... probably related to the bug described above
  //   console.log("strategies balance");
  //   printStruct(await router.viewStrategiesBalance());
  //   console.log("strategyBiswap ust %s", await ust.balanceOf(strategyBiswap.address));
  //   console.log("strategyAcryptos ust %s", await ust.balanceOf(strategyAcryptos.address));
  //   console.log("strategyBiswap busd %s", await busd.balanceOf(strategyBiswap.address));

  //   receipts = await receiptContract.walletOfOwner(owner.address);
  //   console.log("owner receipts", receipts);

  //   await logFarmLPs();

  //   expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
  //   expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
  //   expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  //   expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);
  //   expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);

  // });

});
