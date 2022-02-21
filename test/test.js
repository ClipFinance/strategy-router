const { expect, should, use } = require("chai");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");

// UNISWAP_ROUTER = "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429";
UNISWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 8);
parseUst = (args) => parseUnits(args, 18);

describe("StrategyRouter", function () {

  it("Define globals", async function () {

    [owner, joe, bob] = await ethers.getSigners();

    // ~~~~~~~~~~~ DEPLOY MOCK STRATEGIES ~~~~~~~~~~~ 

    const IStrategy = await hre.artifacts.readArtifact("IStrategy");
    mockStrategy = await waffle.deployMockContract(owner, IStrategy.abi);
    mockStrategy2 = await waffle.deployMockContract(owner, IStrategy.abi);

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

    const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
    router = await StrategyRouter.deploy();
    await router.deployed();
    receiptContract = await ethers.getContractAt(
      "ReceiptNFT", 
      await router.receiptContract()
    );
    CYCLE_DURATION = Number(await router.CYCLE_DURATION());
  });

  it("Add strategies and stablecoins", async function () {
    await router.addSupportedStablecoin(usdc.address);
    await router.addSupportedStablecoin(ust.address);
    await expect(router.addSupportedStablecoin(ust.address)).to.be.reverted;

    await router.addStrategy(mockStrategy.address, ust.address, 1000);
    await router.addStrategy(mockStrategy2.address, usdc.address, 9000);
  });

  it("User deposit", async function () {
    await ust.approve(router.address, parseUst("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await router.depositToBatch(ust.address, parseUst("100"));


    await printStruct(await router.cycles(0));
    await printStruct(await receiptContract.viewReceipt(0));

    // expect(await router.shares()).to.be.equal(await router.INITIAL_SHARES());
  });

  it("User withdraw from current cycle", async function () {
    await router.withdrawDebtToUsers(0);

    await printStruct(await router.cycles(0));
    await printStruct(await receiptContract.viewReceipt(0));
  });

  it("User deposit", async function () {
    // await ust.approve(router.address, parseUst("1000000"));
    // await usdc.approve(router.address, parseUsdc("1000000"));
    await router.depositToBatch(ust.address, parseUst("100"));

    await printStruct(await router.cycles(0));
    await printStruct(await receiptContract.viewReceipt(0));

    // expect(await router.shares()).to.be.equal(await router.INITIAL_SHARES());
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();

    await printStruct(await router.cycles(0));

    console.log(await receiptContract.viewReceipt(0));

  });

});

function printStruct(struct) {
    let obj = struct;
    let out = {};
    for (let key in obj) {
      if(!Number.isInteger(Number(key))) {
        out[key] = obj[key];
      } 
    }
    console.log(out);
}