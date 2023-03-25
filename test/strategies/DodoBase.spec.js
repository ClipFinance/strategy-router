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
  getAmountFromLpAmount
} = require("../shared/dodo");
const { provider, deploy, skipBlocks } = require("../utils");

describe("Test DodoBase", function () {

  let owner, nonReceiptOwner;
  // mainnet contracts
  let dodoMine, dodoPool;
  // mainnet tokens
  let usdtToken, dodoToken, lpToken;
  // core contracts
  let router, oracle, mockExchange, batch, receiptContract, sharesToken;
  // dodo strategy
  let dodoStrategy;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  let parseUsdt, parseDodo;

  let testUsdtAmount;
  let strategyInitialBalance;

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

    ({token: usdtToken, parseToken: parseUsdt} = await getTokenContract(hre.networkVariables.usdt));
    ({token: dodoToken, parseToken: parseDodo} = await getTokenContract(hre.networkVariables.dodo));

    lpToken = (await getTokenContract(hre.networkVariables.dodoUsdtLp)).token;

    await mintForkedToken(
      dodoToken.address,
      owner.address,
      parseDodo("10000000000")
    );
    await mintForkedToken(
      usdtToken.address,
      owner.address,
      parseUsdt("10000000000")
    );

    dodoMine = await getContract("IDodoMine", hre.networkVariables.dodoMine);
    dodoPool = await getContract(
      "IDodoSingleAssetPool",
      hre.networkVariables.dodoBusdUsdtPool
    );

    dodoStrategy = await deployDodoStrategy({
      router: router.address,
      token: usdtToken.address,
      lpToken: lpToken.address,
      dodoToken: dodoToken.address,
      pool: dodoPool.address,
      farm: dodoMine.address,
      upgrader: owner.address,
    });

    testUsdtAmount = parseUsdt("10000");
    strategyInitialBalance = parseUsdt("1000000");
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
      expect(await dodoStrategy.depositToken()).to.be.eq(usdtToken.address);
      expect(await dodoStrategy.owner()).to.be.eq(owner.address);

      expect(await dodoStrategy.strategyRouter()).to.be.eq(router.address);
      expect(await dodoStrategy.dodoToken()).to.be.eq(dodoToken.address);
      expect(await dodoStrategy.pool()).to.be.eq(
        dodoPool.address
      );
      expect(await dodoStrategy.farm()).to.be.eq(
        dodoMine.address
      );
      expect(await dodoStrategy.lpToken()).to.be.eq(lpToken.address);
    });
  });

  describe("#deposit", function () {

    it("revert if msg.sender is not owner", async function () {
      await expect(
        dodoStrategy.connect(nonReceiptOwner).deposit(testUsdtAmount)
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
        testUsdtAmount
      );
      await usdtToken.transfer(dodoStrategy.address, strategyInitialBalance);
      await dodoStrategy.deposit(testUsdtAmount);

      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(testUsdtAmount)
      );

      expect(await lpToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(lpAmount);
    });    

    it("do not revert when amount is 0", async function () {
      await dodoStrategy.deposit(0);
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      await usdtToken.transfer(dodoStrategy.address, strategyInitialBalance);
      await dodoStrategy.deposit(0);
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(strategyInitialBalance);
    });
  });

  describe("#compound", function () {
    beforeEach(async () => {
      await usdtToken.transfer(dodoStrategy.address, strategyInitialBalance);
      await dodoStrategy.deposit(testUsdtAmount);
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

      const exchangedTokenAmount = parseUsdt("100");
      await usdtToken.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      // Test when DODO reward is greater than 0.
      expect(dodoRewardAmount).to.greaterThan(0);

      const currentTokenBalance = await usdtToken.balanceOf(dodoStrategy.address);
      const newStakedLpAmount = await getLpAmountFromAmount(
        dodoPool.address,
        lpToken.address,
        true,
        exchangedTokenAmount.add(currentTokenBalance)
      );

      await dodoStrategy.compound();

      // The Underlying token balance should be zero after compound.
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodoToken.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
    });
  });

  describe("#withdrawAll", function () {
    beforeEach(async () => {
      await usdtToken.transfer(dodoStrategy.address, strategyInitialBalance);
      await dodoStrategy.deposit(testUsdtAmount);
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

      const exchangedTokenAmount = parseUsdt("100");
      await usdtToken.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

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
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodoToken.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await usdtToken.balanceOf(owner.address)).to.be.greaterThan(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
      );
    });
  });

  describe("#withdraw", function () {
    beforeEach(async () => {
      await usdtToken.transfer(dodoStrategy.address, strategyInitialBalance);
      await dodoStrategy.deposit(testUsdtAmount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        dodoStrategy.connect(nonReceiptOwner).withdraw(testUsdtAmount)
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Withdraw tokens when remaining token balance is greater than withdraw amount", async function () {
      const withdrawAmount = parseUsdt("100");
      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      await dodoStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should zero
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(testUsdtAmount).sub(withdrawAmount)
      );

      // Should have same staked balance after withdraw
      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount);

      // Owner should have withdrawn token
      expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(withdrawAmount)
      );
    });

    it("Withdraw tokens when remaining token balance is less than withdraw amount", async function () {
      const currentTokenBal = await usdtToken.balanceOf(dodoStrategy.address);
      const extraWithdrwalAmount = parseUsdt("100");
      const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = parseUsdt("100");
      await usdtToken.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

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
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.greaterThan(stakedLpAmount.sub(lpAmountToWithdraw));

      // Owner should have all tokens.
      expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(withdrawAmount)
      );
    });

    it("Withdraw all tokens if requested amount is higher than total tokens", async function () {
      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = parseUsdt("100");
      await usdtToken.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

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
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodoToken.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await usdtToken.balanceOf(owner.address)).to.be.greaterThan(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
      );
    });
  });
});
