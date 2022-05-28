const { expect } = require("chai");
const { BigNumber } = require("ethers");
const { parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");


describe("Test ReceiptNFT.walletOfOwner function", function () {
  it("Snapshot evm", async function () {
    snapshotId = await provider.send("evm_snapshot");
    [owner, joe] = await ethers.getSigners();
    provider = ethers.provider;
  });
  it("Deploy ReceiptNFT", async function () {
    receiptContract = await ethers.getContractFactory("ReceiptNFT");
    receiptContract = await receiptContract.deploy();
    arrayToNubmer = arr => arr.map(n => n.toNumber());
    await receiptContract.setManager(owner.address);
  });
  it("Wallet with 0 tokens", async function () {
    expect(await receiptContract.walletOfOwner(owner.address)).to.be.empty;
  });
  it("Wallet with 1 token", async function () {
    await mintReceipt(owner.address);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
    expect(await receiptContract.walletOfOwner(joe.address)).to.be.empty;
  });
  it("Two wallets with 1 token", async function () {
    await mintReceipt(joe.address);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
    expect(arrayToNubmer(await receiptContract.walletOfOwner(joe.address))).to.be.eql([1]);
  });
  it("Two wallets with more tokens", async function () {
    await mintReceipt(owner.address);
    await mintReceipt(joe.address);
    await mintReceipt(owner.address);
    await mintReceipt(joe.address);
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

async function mintReceipt(to) {
  await receiptContract.mint(0, 0, ethers.constants.AddressZero, to);
}