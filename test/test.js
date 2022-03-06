const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");

provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 6);
parseUst = (args) => parseUnits(args, 18);
uniformDecimals = 18;
parseUniform = (args) => parseUnits(args, uniformDecimals);

describe("StrategyRouter", function () {

  it("Define globals", async function () {

    [owner, joe, bob] = await ethers.getSigners();

    // ~~~~~~~~~~~ DEPLOY MOCKS ~~~~~~~~~~~ 

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
    await router.setMinUsdPerCycle(parseUniform("1.0"));

    // ~~~~~~~~~~~ GET MORE GLOBALS ~~~~~~~~~~~ 
    receiptContract = await ethers.getContractAt(
      "ReceiptNFT",
      await router.receiptContract()
    );
    sharesToken = await ethers.getContractAt(
      "SharesToken",
      await router.sharesToken()
    );
    CYCLE_DURATION = Number(await router.CYCLE_DURATION());
    INITIAL_SHARES = Number(await router.INITIAL_SHARES());
  });

  it("Deploy fake farms", async function () {
    const FarmUnprofitable = await ethers.getContractFactory("FarmUnprofitable");
    farmUnprofitable = await FarmUnprofitable.deploy(ust.address);
    await farmUnprofitable.deployed();

    const Farm = await ethers.getContractFactory("Farm");
    farm = await Farm.deploy(usdc.address);
    await farm.deployed();
  });

  it("Add strategies and stablecoins", async function () {
    await router.addSupportedStablecoin(usdc.address);
    await router.addSupportedStablecoin(ust.address);
    await expect(router.addSupportedStablecoin(ust.address)).to.be.reverted;

    await router.addStrategy(farmUnprofitable.address, ust.address, 1000);
    await router.addStrategy(farm.address, usdc.address, 9000);
  });

  it("User deposit", async function () {
    await ust.approve(router.address, parseUst("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));

    await router.depositToBatch(ust.address, parseUst("100"))

    expect(await ust.balanceOf(router.address)).to.be.closeTo(
      parseUst("10"), 
      parseUst("0.5")
    );
    expect(await usdc.balanceOf(router.address)).to.be.closeTo(
      parseUsdc("90"), 
      parseUsdc("0.5")
    );
  });

  it("User withdraw half from current cycle", async function () {
    let receipt = await receiptContract.viewReceipt(0);
    await router.withdrawDebtToUsers(0, receipt.amount.div(2));
  });

  it("User withdraw other half from current cycle", async function () {
    await router.withdrawDebtToUsers(0, await sharesToken.balanceOf(owner.address));
  });

  it("User deposit", async function () {
    await router.depositToBatch(ust.address, parseUst("100"));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();
    expect(await router.shares()).to.be.equal(INITIAL_SHARES);
    expect((await router.netAssetValueAll()).totalNetAssetValue).to.be.closeTo(
      parseUniform("100"), 
      parseUniform("0.5")
    );
  });

  it("User deposit", async function () {
    await router.depositToBatch(ust.address, parseUst("100"));
  });

  it("Send funds to farm to simulate balance growth", async function () {
    await usdc.transfer(farm.address, await usdc.balanceOf(farm.address));
  });

  it("Deposit to strategies", async function () {
    await provider.send("evm_increaseTime", [CYCLE_DURATION]);
    await provider.send("evm_mine");

    await router.depositToStrategies();

    expect((await router.netAssetValueAll()).totalNetAssetValue).to.be.closeTo(
      parseUniform("290"), 
      parseUniform("1.0")
    );
  });

  it("Withdraw half from strategies", async function () {
    let receipt = await receiptContract.viewReceipt(1);
    await router.withdrawDebtToUsers(1, receipt.amount.div(2));
  });

  it("Withdraw other half from strategies", async function () {
    let receipt = await receiptContract.viewReceipt(1);
    // withdraw whatever leftover, should also burn nft
    await router.withdrawShares(await sharesToken.balanceOf(owner.address));
  });

  it("Withdraw from strategies", async function () {
    await printStruct(await receiptContract.viewReceipt(2));
    await router.withdrawDebtToUsers(2, 0);

    expect(await ust.balanceOf(farm.address)).to.equal(0);
    expect(await usdc.balanceOf(farm.address)).to.within(0, 10);
    expect(await ust.balanceOf(router.address)).to.equal(0);
    expect(await usdc.balanceOf(router.address)).to.equal(0);
  });

  describe("walletOfOwner", function () {
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
      await receiptContract.mint(0, 0, receiptContract.address, owner.address);
      expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
      expect(await receiptContract.walletOfOwner(joe.address)).to.be.empty;
    });
    it("Two wallets with 1 token", async function () {
      await receiptContract.mint(0, 0, receiptContract.address, joe.address);
      expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
      expect(arrayToNubmer(await receiptContract.walletOfOwner(joe.address))).to.be.eql([1]);
    });
    it("Two wallets with more tokens", async function () {
      await receiptContract.mint(0, 0, receiptContract.address, owner.address);
      await receiptContract.mint(0, 0, receiptContract.address, joe.address);
      await receiptContract.mint(0, 0, receiptContract.address, owner.address);
      await receiptContract.mint(0, 0, receiptContract.address, joe.address);
      expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([4,2,0]);
      expect(arrayToNubmer(await receiptContract.walletOfOwner(joe.address))).to.be.eql([5,3,1]);
    });
    it("Revert evm", async function () {
      await provider.send("evm_revert", [snapshotId]);
    });
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