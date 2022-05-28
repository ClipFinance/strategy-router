const { expect } = require("chai");
const { BigNumber } = require("ethers");
const { parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");


describe("Test ReceiptNFT.walletOfOwner function", function () {

  before(async function () {
    provider = ethers.provider;
    snapshotId = await provider.send("evm_snapshot");
    [owner, joe] = await ethers.getSigners();
  });

  after(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  it("Deploy ReceiptNFT", async function () {
    receiptContract = await ethers.getContractFactory("ReceiptNFT");
    receiptContract = await receiptContract.deploy();
    arrayToNubmer = arr => arr.map(n => n.toNumber());
    await receiptContract.init(owner.address, owner.address);
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
});

async function mintReceipt(to) {
  await receiptContract.mint(0, 0, ethers.constants.AddressZero, to);
}