const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, skipBlocks, BLOCKS_MONTH } = require("./utils");

// ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~ 
provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 18);
parseUst = (args) => parseUnits(args, 18);
parseUniform = (args) => parseUnits(args, 18);
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 

describe("Test acryptos_ust strategy", function () {

  it("Snapshot evm", async function () {
    snapshotId = await provider.send("evm_snapshot");
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

  it("Deploy Exchange", async function () {

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
    await router.setFeePercent(2000);
    await router.setFeeAddress(bob.address);
  });

  it("Deploy acryptos_ust", async function () {

    // ~~~~~~~~~~~ DEPLOY Acryptos UST strategy ~~~~~~~~~~~ 
    strategy = await ethers.getContractFactory("acryptos_ust");
    strategy = await strategy.deploy(router.address);
    await strategy.deployed();

    lpToken = await strategy.lpToken();
    lpToken = await ethers.getContractAt("ERC20", lpToken);

    farm = await strategy.farm();
    farm = await ethers.getContractAt("IACryptoSFarmV4", farm);

    zapDepositer = await strategy.zapDepositer();
    zapDepositer = await ethers.getContractAt("IZapDepositer", zapDepositer);

  });

  it("Test deposit function", async function () {

    let amountDeposit = parseUst("100");
    await ust.transfer(strategy.address, amountDeposit)
    await strategy.deposit(amountDeposit);

    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);

    let expectedLPs = await zapDepositer.calc_token_amount(
      [amountDeposit, 0, 0, 0, 0], 
      true
    );
    let userInfo = await farm.userInfo(lpToken.address, strategy.address);
    expect(userInfo.amount).to.be.closeTo(
      expectedLPs,
      parseEther("0.1"),
    );
  });
  
  it("Test totalTokens function", async function () {
    expect(await strategy.totalTokens()).to.be.closeTo(
      parseUst("100"),
      parseUst("0.1"),
    );
  });

  it("Test withdraw function", async function () {

    let amountWithdraw = parseUst("50");
    let oldBalance = await ust.balanceOf(owner.address);
    await strategy.withdraw(amountWithdraw);
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUst("50"),
      parseUst("0.1"),
    );
    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);

    let amountLeft = parseUst("50");
    let expectedLPs = await zapDepositer.calc_token_amount(
      [amountLeft, 0, 0, 0, 0], 
      false
    );
    let userInfo = await farm.userInfo(lpToken.address, strategy.address);
    expect(userInfo.amount).to.be.closeTo(
      expectedLPs,
      parseEther("0.1"),
    );

  });

  it("Test totalTokens function", async function () {
    expect(await strategy.totalTokens()).to.be.closeTo(
      parseUst("50"),
      parseUst("0.1"),
    );
  });
  
  it("Withdraw whatever left", async function () {

    let amountWithdraw = await strategy.totalTokens();
    let oldBalance = await ust.balanceOf(owner.address);
    await strategy.withdraw(amountWithdraw);
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUst("50"),
      parseUst("0.1"),
    );
    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);

    let amountLeft = 0;
    let userInfo = await farm.userInfo(lpToken.address, strategy.address);
    expect(userInfo.amount).to.be.within(
      amountLeft,
      parseEther("0.1"),
    );

  });

  it("Test compound", async function () {

    let amountDeposit = parseUst("10000");
    await ust.transfer(strategy.address, amountDeposit)
    await strategy.deposit(amountDeposit);

    // skip blocks
    await skipBlocks(BLOCKS_MONTH);

    // compound, should incsrease totalTokens
    let oldBalance = await strategy.totalTokens();
    let oldFeeBalance = await ust.balanceOf(bob.address);
    await strategy.compound();
    let newFeeBalance = await ust.balanceOf(bob.address);
    let newBalance = await strategy.totalTokens();
    console.log("added after compound", newBalance.sub(oldBalance));

    expect(newFeeBalance).to.be.gt(oldFeeBalance);
    expect(newBalance).to.be.gt(oldBalance);
    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);

    // withdraw all
    oldBalance = await ust.balanceOf(owner.address);
    await strategy.withdraw(await strategy.totalTokens());
    newBalance = await ust.balanceOf(owner.address);

    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);
    expect(await strategy.totalTokens()).to.be.within(0, parseUst("5"));

    let amountLeft = 0;
    let userInfo = await farm.userInfo(lpToken.address, strategy.address);
    // console.log(userInfo);
    console.log("on farm LPs %s, totalTokens %s", userInfo.amount, await strategy.totalTokens());
    expect(userInfo.amount).to.be.within(
      amountLeft,
      parseEther("5.0"),
    );
  });

  it("Random actions", async function () {

    /*
      loop,
        deposit 100
        skip 1 month
        compound
        withdraw 50% of totalTokens
      exit loop
      withdraw 50%
      withdraw all lefover
    */

    for (let i = 0; i < 5; i++) {
      
      // deposit
      let amountDeposit = parseUst("100");
      await ust.transfer(strategy.address, amountDeposit)
      await strategy.deposit(amountDeposit);
  
      // skip blocks
      let MONTH_BLOCKS = 60 * 60 * 24 * 30 / 3; // 1 yearn in block on bnb chain
      MONTH_BLOCKS = "0x" + MONTH_BLOCKS.toString(16);
      await hre.network.provider.send("hardhat_mine", [MONTH_BLOCKS]);
  
      // compound
      let oldBalance = await strategy.totalTokens();
      await strategy.compound();
      let newBalance = await strategy.totalTokens();
      // console.log("added after compound", newBalance.sub(oldBalance));

      // withdraw
      // oldBalance = await strategy.totalTokens();
      await strategy.withdraw((await strategy.totalTokens()).div(2));
      newBalance = await strategy.totalTokens();
      // console.log("leftover after withdarw", newBalance);


    }

    // withdraw all
    oldBalance = await ust.balanceOf(owner.address);
    await strategy.withdraw((await strategy.totalTokens()));
    newBalance = await ust.balanceOf(owner.address);
    // console.log("final leftover after withdarw", newBalance);

    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);
    expect(await strategy.totalTokens()).to.be.within(0, parseUst("5"));

    let amountLeft = 0;
    let userInfo = await farm.userInfo(lpToken.address, strategy.address);
    // console.log(userInfo);
    // console.log("on farm LPs %s, totalTokens %s", userInfo.amount, await strategy.totalTokens());
    expect(userInfo.amount).to.be.within(
      amountLeft,
      parseEther("5.0"),
    );
  });

  it("Revert evm", async function () {
    await provider.send("evm_revert", [snapshotId]);
  });
});

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