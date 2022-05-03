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
    await router.addStrategy(strategyBiswap.address, ust.address, 5000);
  });


  it("Admin initial deposit", async function () {

    br = await ethers.getContractAt(
      "IUniswapV2Router02",
      "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8"
    );

    async function getSwapAmount(total) {
      let factory = await ethers.getContractAt("IUniswapV2Factory", await br.factory());
      let pair = await ethers.getContractAt(
        "IUniswapV2Pair",
        await factory.getPair(ust.address, busd.address)
      ); // token0 == UST

      let {reserve0, reserve1} = await pair.getReserves();
      let ratio = reserve0.mul(parseEther("1")).div(reserve1);
      console.log("reserves ratio", formatEther(ratio));
      // console.log("ratio", formatEther(ratio.mul(100)));

      // let ret = total.mul(reserve0).div(reserve0.add(reserve1));
      // let feeRat = (BigNumber.from(30)).mul(reserve0).div(reserve0.add(reserve1));
      // ret = ret.mul((BigNumber.from(10000)).sub(feeRat)).div(10000);
      // console.log(feeRat);

      // def get_dy_underlying(i: int128, j: int128, dx: uint256)
      // let half = total.div(2).mul(10030).div(10000);
      let half = total.div(2);
      let otherHalf = total.sub(half);
      let poolACS4UST = await ethers.getContractAt(
        "IAcryptoSPool",
        "0x99c92765EfC472a9709Ced86310D64C4573c4b77"
      );
      let dy = await poolACS4UST.get_dy_underlying(0, 1, half);
      let dy_ratio = (otherHalf).mul(parseEther("1")).div(dy);
      // first time when there was dy/total.div(2) (and similar in loop) it was worked better

      console.log("dy_ratio1", formatEther(dy_ratio));

      for (let i = 0; i < 3; i++) {
        
        if(dy_ratio.lt(ratio)) {
          console.log("ratio <", dy_ratio, ratio);
          // let r = ratio.mul(parseEther("1")).div(dy_ratio);
          let r = parseEther("1").sub(ratio.sub(dy_ratio));
          half = half.mul(r).div(parseEther("1"));
          otherHalf = total.sub(half);
          dy = await poolACS4UST.get_dy_underlying(0, 1, half);
          dy_ratio = otherHalf.mul(parseEther("1")).div(dy);
        } else if (dy_ratio.gt(ratio)) {
          console.log("ratio >", dy_ratio, ratio);
          // let r = ratio.mul(parseEther("1")).div(dy_ratio);
          let r = dy_ratio.sub(ratio).add(parseEther("1"));
          half = half.mul(r).div(parseEther("1"));
          otherHalf = total.sub(half);
          dy = await poolACS4UST.get_dy_underlying(0, 1, half);
          dy_ratio = otherHalf.mul(parseEther("1")).div(dy);
        }
      }

      console.log(formatEther(dy_ratio));

      console.log(reserve0, reserve1);
      let ret = half;
      return ret;
    }
    let depAmount = parseUst("10000");
    await ust.transfer(joe.address, (await ust.balanceOf(owner.address)).sub(depAmount));

    await ust.approve(exchange.address, parseUst("1000000"));
    let swapAmount = await getSwapAmount(depAmount);
    console.log("swapAmount", formatEther(swapAmount));
    await ust.transfer(exchange.address, swapAmount);
    await exchange.swapRouted(
      swapAmount,
      ust.address,
      busd.address,
      owner.address
    );
    let busdAmount = await busd.balanceOf(owner.address);
    let ustAmount = await ust.balanceOf(owner.address);
    console.log("after swap", ustAmount, busdAmount, formatEther(ustAmount.mul(parseEther("1")).div(busdAmount)));

    await ust.approve(br.address, parseUst("1000000"));
    await busd.approve(br.address, parseUst("1000000"));

              // address(ust),
              //   address(busd),
              //   ustAmount,
              //   busdAmount,
              //   0,
              //   0,
              //   address(this),
              //   block.timestamp
    await br.addLiquidity(
      ust.address,
      busd.address,
      ustAmount,
      busdAmount,
      0,
      0,
      owner.address,
      Date.now()
    );

    busdAmount = await busd.balanceOf(owner.address);
    ustAmount = await ust.balanceOf(owner.address);
    console.log(formatEther(ustAmount), formatEther(busdAmount));
  });


  // it("User deposit", async function () {

  //   for (let i = 0; i < 2; i++) {

  //     await router.depositToBatch(ust.address, parseUst("2200"))
  //     await router.depositToBatch(ust.address, parseUst("2200"))
  //     await router.depositToBatch(ust.address, parseUst("700"))
  //     await router.depositToBatch(ust.address, parseUst("700"))

  //     await skipCycleTime();

  //     await router.depositToStrategies();
  //   }
  //   console.log(await receiptContract.walletOfOwner(owner.address));
  // });

  // it("Skip blocks to get BSW rewards AND compound all", async function () {
  //   // compounding biswap twice per 24h not gives profit!
  //   // compounding acryptos twice per 24h gives even less profits!

  //   // only biswap strategy, 1 compound per 24h:
  //   // 11691.634549579642837847
  //   // 12647.927610114806310755 (gain 7.5%)
  //   // once in 2 month compound 12642.637221809520289322

  //   // only acrypts strategy, 1 compound per 24h:
  //   // 11695.36963410516658027
  //   // 11785.875757304756469757 (gain 0.77%)
  //   // compound once a month 11831.92601472858452229 (+1.14 %)

  //   console.log("before year of compounding", formatEther((await router.viewStrategiesBalance()).totalBalance.toString()));
  //   console.log("getBlockNumber: ", await provider.getBlockNumber());
  //   // await skipBlocks(BLOCKS_MONTH * 12);
  //   // await skipCycleTime();

  //   let yearCompounds = 12;
  //   for (let i = 0; i < yearCompounds; i++) {
  //     // await provider.send("evm_increaseTime", [100]);
  //     // await provider.send("evm_mine");


  //     // tokenA.approve(address(poolACS4UST), amountA);

  //     //   int128 _tokenAIndex = coinIds[address(poolACS4UST)][address(tokenA)];
  //     //   int128 _tokenBIndex = coinIds[address(poolACS4UST)][address(tokenB)];

  //       // console.log("_tokenAIndex %s _tokenBIndex %s amountA %s", uint128(_tokenAIndex), uint128(_tokenBIndex), amountA);
  //       // uint256 received = poolACS4UST.exchange_underlying(
  //       //     _tokenAIndex,
  //       //     _tokenBIndex,
  //       //     amountA,
  //       //     0
  //       // );

  //     // ~~~~~~~~~~~ Simulate ust <-> busd swaps ~~~~~~~~~~~ 
  //     await ust.approve(acsUst.address, parseEther("100000000"));
  //     await busd.approve(acsUst.address, parseEther("1000000000"));
  //     await acsUst.exchange_underlying(
  //       0, //ust
  //       1, // busd
  //       parseUst("200000"),
  //       0
  //     );
  //     await acsUst.exchange_underlying(
  //       1, // busd
  //       0, //ust
  //       await busd.balanceOf(owner.address),
  //       0
  //     );

  //     await skipBlocks(BLOCKS_DAY*30);
  //     await router.compoundAll();
  //   }
  //   console.log("getBlockNumber: ", await provider.getBlockNumber());

  //   console.log("after year of compounding", formatEther((await router.viewStrategiesBalance()).totalBalance));
  // });

  // it("Withdraw from strategies", async function () {

  //   let receipts = await receiptContract.walletOfOwner(owner.address);
  //   receipts = receipts.filter(id => id != 0); // ignore nft of admin initial deposit
  //   for (; 0 < receipts.length; ) {

  //     let receiptData = await receiptContract.viewReceipt(receipts[0]);
  //     let oldBalance = await ust.balanceOf(owner.address);
  //     await router.withdrawFromStrategies(receipts[0], ust.address, 10000);
  //     let newBalance = await ust.balanceOf(owner.address);

  //     // console.log("RECEIPT", receiptData)
  //     // expect(newBalance.sub(oldBalance)).to.be.closeTo(
  //     //   (receiptData.amount).mul(parseUst("1")).div(parseEther("1")),
  //     //   parseUst("5")
  //     // );

  //     receipts = receipts.filter(id => id != receipts[0]); 
  //     // await logFarmLPs();
  //   }

  //   console.log(await receiptContract.walletOfOwner(owner.address));

  //   console.log("strategies balance");
  //   printStruct(await router.viewStrategiesBalance());

  //   // should've withdrawn all (excpet admin), so verify that
  //   // expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
  //   // expect(await sharesToken.balanceOf(joe.address)).to.be.equal(0);
  //   // expect(await sharesToken.balanceOf(router.address)).to.be.equal(0);

  //   expect(await ust.balanceOf(strategyAcryptos.address)).to.equal(0);
  //   expect(await ust.balanceOf(strategyBiswap.address)).to.be.lt(parseUst("1"));
  //   expect(await ust.balanceOf(router.address)).to.lt(parseEther("1"));

  // });

});
