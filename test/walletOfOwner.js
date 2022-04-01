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

describe("Test ReceiptNFT.walletOfOwner function", function () {
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