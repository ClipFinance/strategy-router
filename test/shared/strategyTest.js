const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { commonSetup } = require("./commonSetup");
const { getTokens, skipBlocks, BLOCKS_MONTH, parseAmount, parseUsdt, getDepositToken } = require("../utils");

module.exports = function strategyTest(strategyName, parseAmount, getDepositToken) {
  describe(`Test ${strategyName} strategy`, function () {

    before(async function () {
      [owner, feeAddress] = await ethers.getSigners();

      snapshotId = await provider.send("evm_snapshot");
      await commonSetup();
      depositToken = await getDepositToken();
    });

    after(async function () {
      await provider.send("evm_revert", [snapshotId]);
    });

    it(`deploy ${strategyName}`, async function () {
      strategy = await ethers.getContractFactory(strategyName);
      strategy = await strategy.deploy(router.address);
      await strategy.deployed();
    });

    let amountDeposit = parseAmount("10000");
    let amountWithdraw = parseAmount("5000");

    it("deposit function", async function () {

      let balanceBefore = await depositToken.balanceOf(owner.address);
      await depositToken.transfer(strategy.address, amountDeposit)
      await strategy.deposit(amountDeposit);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      expect(totalTokens).to.be.closeTo(amountDeposit, parseAmount("100"));
      expect(balanceBefore.sub(balanceAfter)).to.be.equal(amountDeposit);
    });

    it("withdraw function", async function () {

      let balanceBefore = await depositToken.balanceOf(owner.address);
      await strategy.withdraw(amountWithdraw);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      expect(totalTokens).to.be.closeTo(amountDeposit.sub(amountWithdraw), parseAmount("100"));
      expect(balanceAfter.sub(balanceBefore)).to.be.closeTo(amountWithdraw, parseAmount("100"));
    });

    it("Withdraw all", async function () {

      amountWithdraw = await strategy.totalTokens();
      let balanceBefore = await depositToken.balanceOf(owner.address);
      await strategy.withdraw(amountWithdraw);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      expect(totalTokens).to.be.closeTo(BigNumber.from(0), parseAmount("1"));
      expect(balanceAfter.sub(balanceBefore)).to.be.closeTo(amountWithdraw, parseAmount("100"));
    });

    it("compound function, and protocol commissions", async function () {

      await depositToken.transfer(strategy.address, amountDeposit)
      await strategy.deposit(amountDeposit);

      // skip blocks
      await skipBlocks(BLOCKS_MONTH);

      // compound, should incsrease totalTokens
      let oldBalance = await strategy.totalTokens();
      let oldFeeBalance = await depositToken.balanceOf(feeAddress.address);
      await strategy.compound();
      let newFeeBalance = await depositToken.balanceOf(feeAddress.address);
      let newBalance = await strategy.totalTokens();

      expect(newFeeBalance).to.be.gt(oldFeeBalance);
      expect(newBalance).to.be.gt(oldBalance);

      // withdraw all
      oldBalance = await depositToken.balanceOf(owner.address);
      await strategy.withdraw(await strategy.totalTokens());
      newBalance = await depositToken.balanceOf(owner.address);

      expect(await strategy.totalTokens()).to.be.within(0, parseAmount("1"));
      expect(newBalance.sub(oldBalance)).to.be.closeTo(amountDeposit, parseAmount("100"));
    });
  });
}