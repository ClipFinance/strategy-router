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

describe("Test biswap_ust_busd strategy", function () {

  it("Snapshot evm", async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  it("Define globals", async function () {

    [owner, joe, bob] = await ethers.getSigners();
    // ~~~~~~~~~~~ GET EXCHANGE ROUTER ~~~~~~~~~~~ 
    uniswapRouter = await ethers.getContractAt(
      "IUniswapV2Router02",
      "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8"
    );

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


    BUSD = "0xe9e7cea3dedca5984780bafc599bd69add087d56";
    busd = await ethers.getContractAt("ERC20", BUSD);
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

  });

  it("Deploy biswap_ust_busd", async function () {

    // ~~~~~~~~~~~ DEPLOY Acryptos UST strategy ~~~~~~~~~~~ 
    strategy = await ethers.getContractFactory("biswap_ust_busd");
    strategy = await strategy.deploy(router.address);
    await strategy.deployed();

    lpToken = await strategy.lpToken();
    lpToken = await ethers.getContractAt("ERC20", lpToken);

    farm = await strategy.farm();
    farm = await ethers.getContractAt("IBiswapFarm", farm);

    poolId = await strategy.poolId();

  });

  it("Test deposit function", async function () {

    let amountDeposit = parseUst("100");
    await ust.approve(strategy.address, amountDeposit)
    await strategy.deposit(amountDeposit);

    expect(await ust.balanceOf(strategy.address)).to.be.equal(0);
    expect(await busd.balanceOf(strategy.address)).to.be.equal(0);
    expect(await lpToken.balanceOf(strategy.address)).to.be.equal(0);


    let userInfo = await farm.userInfo(poolId, strategy.address);
    expect(userInfo.amount).to.be.closeTo(
      parseEther("50"),
      parseEther("1.0"),
    );
  });
  
  it("Test totalTokens function", async function () {
    expect(await strategy.totalTokens()).to.be.closeTo(
      parseUst("100"),
      parseUst("0.2"),
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

    let userInfo = await farm.userInfo(poolId, strategy.address);
    expect(userInfo.amount).to.be.closeTo(
      parseEther("25"),
      parseEther("0.5"),
    );

  });

  it("Test totalTokens function", async function () {
    expect(await strategy.totalTokens()).to.be.closeTo(
      parseUst("50"),
      parseUst("0.2"),
    );
  });
  
  it("Withdraw whatever left", async function () {

    let amountWithdraw = await strategy.totalTokens();
    let oldBalance = await ust.balanceOf(owner.address);
    await strategy.withdraw(amountWithdraw);
    let newBalance = await ust.balanceOf(owner.address);

    expect(newBalance.sub(oldBalance)).to.be.closeTo(
      parseUst("50"),
      parseUst("0.2"),
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
    await ust.approve(strategy.address, amountDeposit)
    await strategy.deposit(amountDeposit);

    // skip blocks
    let MONTH_BLOCKS = 60 * 60 * 24 * 30 * 12 / 3; // 1 yearn in block on bnb chain
    MONTH_BLOCKS = "0x" + MONTH_BLOCKS.toString(16);
    await hre.network.provider.send("hardhat_mine", [MONTH_BLOCKS]);

    // compound, should incsrease totalTokens
    let oldBalance = await strategy.totalTokens();
    await strategy.compound();
    let newBalance = await strategy.totalTokens();

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
    console.log("on farm LPs %s, totalTokens %s", userInfo.amount, await strategy.totalTokens());
    expect(userInfo.amount).to.be.within(
      amountLeft,
      parseEther("1.0"),
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
      await ust.approve(strategy.address, amountDeposit)
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
    console.log("on farm LPs %s, totalTokens %s", userInfo.amount, await strategy.totalTokens());
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