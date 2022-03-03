const { expect, should, use } = require("chai");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");

provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 6);
parseUst = (args) => parseUnits(args, 18);
priceDecimals = 8;
parsePrice = (args) => parseUnits(args, priceDecimals);

describe("StrategyRouter", function () {

  it("Define globals", async function () {

    [owner, joe, bob] = await ethers.getSigners();

    // ~~~~~~~~~~~ DEPLOY MOCKS ~~~~~~~~~~~ 

    const ChainLinkOracle = await hre.artifacts.readArtifact("ChainlinkOracle");
    mockOracle = await waffle.deployMockContract(owner, ChainLinkOracle.abi);

    // ~~~~~~~~~~~ GET UST TOKENS ~~~~~~~~~~~ 

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

    // ~~~~~~~~~~~ GET USDC TOKENS ~~~~~~~~~~~ 

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
    await router.setMinUsdPerCycle(parsePrice("1.0"));

    // ~~~~~~~~~~~ GET MORE GLOBALS ~~~~~~~~~~~ 
    receiptContract = await ethers.getContractAt(
      "ReceiptNFT",
      await router.receiptContract()
    );
    CYCLE_DURATION = Number(await router.CYCLE_DURATION());
  });

  it("Deploy fake farms", async function () {
    const FarmUnprofitable = await ethers.getContractFactory("FarmUnprofitable");
    farmUnprofitable = await FarmUnprofitable.deploy(ust.address);
    await farmUnprofitable.deployed();

    const Farm = await ethers.getContractFactory("Farm");
    farm = await Farm.deploy(usdc.address);
    await farm.deployed();
  });

  it("Mock oracle", async function () {
    await router.setOracle(mockOracle.address);
  });

  it("Add strategies and stablecoins", async function () {
    await router.addSupportedStablecoin(usdc.address);
    await router.addSupportedStablecoin(ust.address);
    await expect(router.addSupportedStablecoin(ust.address)).to.be.reverted;

    await router.addStrategy(farmUnprofitable.address, ust.address, 1000);
    await router.addStrategy(farm.address, usdc.address, 9000);
  });

  it("Mock oracle prices", async function () {
    await setOraclePriceUSDC("1.0006");
    await setOraclePriceUST("0.9986");
  });

  it("User deposit", async function () {
    await ust.approve(router.address, parseUst("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await router.depositToBatch(ust.address, parseUst("100"));

    // await printStruct(await router.cycles(0));
    // await printStruct(await receiptContract.viewReceipt(0));

    // expect(await router.shares()).to.be.equal(await router.INITIAL_SHARES());
  });

  it("User withdraw from current cycle", async function () {
    await router.withdrawDebtToUsers(0);
  });

  it("User deposit", async function () {
    await router.depositToBatch(ust.address, parseUst("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();
  });

  it("User deposit", async function () {
    await router.depositToBatch(ust.address, parseUst("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");


    await router.depositToStrategies();

    // await printStruct(await router.cycles(0));
    // console.log(await receiptContract.viewReceipt(0));
  });

  it("Send funds to farm to simulate balance growth", async function () {
    await usdc.transfer(farm.address, parseUsdc("50"));
  });

  it("Withdraw from strategies", async function () {
    await router.withdrawDebtToUsers(1);
  });

});

async function setOraclePriceUSDC(price) {
  await mockOracle.mock.getAssetUsdPrice
    .withArgs(usdc.address)
    .returns(parsePrice(price), priceDecimals);
}

async function setOraclePriceUST(price) {
  await mockOracle.mock.getAssetUsdPrice
    .withArgs(ust.address)
    .returns(parsePrice(price), priceDecimals);
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