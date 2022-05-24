const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, skipBlocks, BLOCKS_MONTH, parseAmount, parseUsdt, getDepositToken } = require("./utils");

module.exports = function strategyTest(strategyName, parseAmount, getDepositToken) {
  describe(`Test ${strategyName} strategy`, function () {

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

      depositToken = await getDepositToken();
    });

    it("Deploy Exchange and router", async function () {
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
      let oldFeeBalance = await depositToken.balanceOf(bob.address);
      await strategy.compound();
      let newFeeBalance = await depositToken.balanceOf(bob.address);
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

    it("Revert evm", async function () {
      await provider.send("evm_revert", [snapshotId]);
    });
  });
}
