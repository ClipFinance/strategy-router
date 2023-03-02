const { expect } = require("chai");
const { ethers } = require("hardhat");
const { utils } = require("ethers");
const { setupCore, deployDodoStrategy } = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const {
  getLpAmountFromAmount,
  getAmountFromLpAmount,
} = require("../shared/dodo");
const { provider, deploy, skipBlocks } = require("../utils");

describe("Test DodoBase", function () {
  let owner, nonReceiptOwner;
  // mainnet contracts
  let dodoMine, dodoPool;
  // mainnet tokens
  let token, dodo, lpToken;
  // core contracts
  let router, oracle, mockExchange, batch, receiptContract, sharesToken;
  // dodo strategy
  let dodoStrategy;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  const strategyInitialBalance = utils.parseEther("1000000");

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, batch, receiptContract, sharesToken } =
      await setupCore());

    mockExchange = await deploy("MockExchange");

    await router.setAddresses(
      mockExchange.address,
      oracle.address,
      sharesToken.address,
      batch.address,
      receiptContract.address
    );

    token = (await getTokenContract(hre.networkVariables.usdt)).token;

    dodo = (await getTokenContract(hre.networkVariables.dodo)).token;

    lpToken = (await getTokenContract(hre.networkVariables.dodoUsdtLp)).token;

    await mintForkedToken(
      dodo.address,
      owner.address,
      utils.parseEther("10000000000")
    );
    await mintForkedToken(
      token.address,
      owner.address,
      utils.parseEther("10000000000")
    );

    dodoMine = await getContract("IDodoMine", hre.networkVariables.dodoMine);
    dodoPool = await getContract(
      "IDodoSingleAssetPool",
      hre.networkVariables.dodoBusdUsdtPool
    );

    dodoStrategy = await deployDodoStrategy({
      router: router.address,
      token: token.address,
      lpToken: lpToken.address,
      dodoToken: dodo.address,
      pool: dodoPool.address,
      farm: dodoMine.address,
      upgrader: owner.address,
    });

    await token.transfer(dodoStrategy.address, strategyInitialBalance);
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  after(async () => {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("constructor & initialize", function () {
    it("check initial values", async function () {
      expect(await dodoStrategy.depositToken()).to.be.eq(token.address);
      expect(await dodoStrategy.owner()).to.be.eq(owner.address);
    });
  });

  describe("#deposit", function () {
    const amount = utils.parseEther("10000");

    it("revert if msg.sender is not owner", async function () {
      await expect(
        dodoStrategy.connect(nonReceiptOwner).deposit(amount)
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("swap token to LP and deposit to DodoMine", async function () {
      const lpAmount = await getLpAmountFromAmount(
        dodoPool.address,
        lpToken.address,
        true,
        amount
      );
      await dodoStrategy.deposit(amount);

      expect(await token.balanceOf(dodoStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(amount)
      );

      expect(await lpToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(lpAmount);
    });
  });

  describe("#compound", function () {
    const amount = utils.parseEther("10000");

    beforeEach(async () => {
      await dodoStrategy.deposit(amount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        dodoStrategy.connect(nonReceiptOwner).compound()
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Compound DODO reward", async function () {
      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = utils.parseEther("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      // Test when DODO reward is greater than 0.
      expect(dodoRewardAmount).to.greaterThan(0);

      const newStakedLpAmount = await getLpAmountFromAmount(
        dodoPool.address,
        lpToken.address,
        true,
        exchangedTokenAmount
      );

      await dodoStrategy.compound();

      // The Underlying token balance should be same after compound.
      expect(await token.balanceOf(dodoStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(amount)
      );

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodo.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
    });
  });

  describe("#withdrawAll", function () {
    const amount = utils.parseEther("10000");

    beforeEach(async () => {
      await dodoStrategy.deposit(amount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        dodoStrategy.connect(nonReceiptOwner).withdrawAll()
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Withdraw all tokens", async function () {
      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = utils.parseEther("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      const stakedTokenAmount = await getAmountFromLpAmount(
        dodoPool.address,
        lpToken.address,
        true,
        stakedLpAmount
      );

      await dodoStrategy.withdrawAll();

      // The Underlying token balance should zero
      expect(await token.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodo.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodo.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.greaterThan(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
      );
    });
  });

  describe("#withdraw", function () {
    const amount = utils.parseEther("10000");

    beforeEach(async () => {
      await dodoStrategy.deposit(amount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        dodoStrategy.connect(nonReceiptOwner).withdraw(amount)
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Withdraw tokens when remaining token balance is greater than withdraw amount", async function () {
      const withdrawAmount = utils.parseEther("100");
      const currnetOwnerBal = await token.balanceOf(owner.address);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      await dodoStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should zero
      expect(await token.balanceOf(dodoStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(amount).sub(withdrawAmount)
      );

      // Should have same staked balance after withdraw
      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount);

      // Owner should have withdrawn token
      expect(await token.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(withdrawAmount)
      );
    });

    it("Withdraw tokens when remaining token balance is less than withdraw amount", async function () {
      const currentTokenBal = await token.balanceOf(dodoStrategy.address);
      const extraWithdrwalAmount = utils.parseEther("100");
      const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = utils.parseEther("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const lpAmountToWithdraw = await getLpAmountFromAmount(
        dodoPool.address,
        lpToken.address,
        true,
        extraWithdrwalAmount
      );
      const actualWithdrawAmount = await getAmountFromLpAmount(
        dodoPool.address,
        lpToken.address,
        true,
        lpAmountToWithdraw
      );

      const compoundAmount = exchangedTokenAmount.sub(
        extraWithdrwalAmount.sub(actualWithdrawAmount)
      );

      await dodoStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should zero
      expect(await token.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodo.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.greaterThan(stakedLpAmount.sub(lpAmountToWithdraw));

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(withdrawAmount)
      );
    });

    it("Withdraw all tokens if requested amount is higher than total tokens", async function () {
      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = utils.parseEther("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      const stakedTokenAmount = await getAmountFromLpAmount(
        dodoPool.address,
        lpToken.address,
        true,
        stakedLpAmount
      );

      await dodoStrategy.withdraw(
        strategyInitialBalance.add(exchangedTokenAmount)
      );

      // The Underlying token balance should zero
      expect(await token.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodo.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodo.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.greaterThan(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
      );
    });
  });
});
