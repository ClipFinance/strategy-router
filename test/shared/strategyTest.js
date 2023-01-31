const { expect } = require("chai");
const { parseUnits, parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupCore, setupParamsOnBNB, setupTokens } = require("./commonSetup");
const { skipBlocks, BLOCKS_MONTH, deploy } = require("../utils");
const { BigNumber } = require("ethers");


module.exports = function strategyTest(strategyName) {
  describe(`Test ${strategyName} strategy`, function () {

    let owner, feeAddress;
    // core contracts
    let router, oracle, exchange;
    let strategy;
    // strategy's deposit token
    let depositToken;
    // helper function to parse deposit token amounts
    let parseAmount;

    let amountDeposit;
    let amountWithdraw;
    let snapshotId;

    before(async function () {
      [owner,,,,,,,,,,feeAddress] = await ethers.getSigners();

      snapshotId = await provider.send("evm_snapshot");

      // deploy core contracts
      ({ router, oracle, exchange } = await setupCore());

      // setup params for testing
      await setupParamsOnBNB(router, oracle, exchange);

      // get tokens on bnb chain for testing
      await setupTokens();

      // deploy strategy to test
      // strategy = await deploy(strategyName, router.address);
      let StrategyFactory = await ethers.getContractFactory(strategyName)
      strategy = await upgrades.deployProxy(StrategyFactory, [owner.address], {
        kind: 'uups',
        constructorArgs: [router.address],
      });
      await strategy.deployed();

      // get deposit token and parse helper function
      depositToken = await ethers.getContractAt("ERC20", await strategy.depositToken());
      let decimals = await depositToken.decimals();
      parseAmount = (amount) => parseUnits(amount, decimals);
    });

    after(async function () {
      await provider.send("evm_revert", [snapshotId]);
    });

    it("deposit function", async function () {
      amountDeposit = parseAmount("10000");

      let balanceBefore = await depositToken.balanceOf(owner.address);
      await depositToken.transfer(strategy.address, amountDeposit)
      await strategy.deposit(amountDeposit);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      expect(totalTokens).to.be.closeTo(amountDeposit, parseAmount("100"));
      expect(balanceBefore.sub(balanceAfter)).to.be.equal(amountDeposit);
    });

    it("withdraw function", async function () {
      amountWithdraw = parseAmount("5000");

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
      await strategy.compound();
      let newBalance = await strategy.totalTokens();

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
