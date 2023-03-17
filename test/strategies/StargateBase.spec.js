const { expect } = require("chai");
const { ethers } = require("hardhat");
const { utils } = require("ethers");
const { setupCore, deployStargateStrategy } = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const {
  getLpAmountFromAmount,
} = require("../shared/stargate");
const { provider, deploy, skipBlocks } = require("../utils");

describe("Test StargateBase", function () {
  const USDT_POOL_ID = 2;
  const USDT_LP_FARM_ID = 0;

  let owner, alice;
  // mainnet contracts
  let stargateFarm, stargateRouter;
  // mainnet tokens
  let token, stg, lpToken;
  // core contracts
  let router, oracle, mockExchange, batch, receiptContract, sharesToken;
  // stg strategy
  let stargateStrategy;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  let parseUsdt;
  let testUsdtAmount;

  const strategyInitialBalance = utils.parseEther("1000000");

  before(async function () {
    [owner, alice] = await ethers.getSigners();
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

    const tokenInfo = await getTokenContract(hre.networkVariables.usdt);
    token = tokenInfo.token;
    parseUsdt = tokenInfo.parseToken;
    testUsdtAmount = parseUsdt("10000");

    stg = (await getTokenContract(hre.networkVariables.stg)).token;

    lpToken = (await getTokenContract(hre.networkVariables.stargateUsdtLpPool))
      .token;

    await mintForkedToken(
      stg.address,
      owner.address,
      utils.parseEther("10000000000")
    );
    await mintForkedToken(
      token.address,
      owner.address,
      parseUsdt("10000000000")
    );

    stargateRouter = await getContract(
      "IStargateRouter",
      hre.networkVariables.stargateRouter
    );
    stargateFarm = await getContract(
      "IStargateFarm",
      hre.networkVariables.stargateFarm
    );
    lpToken = await getContract(
      "IStargatePool",
      hre.networkVariables.stargateUsdtLpPool
    );

    stargateStrategy = await deployStargateStrategy({
      router: router.address,
      token: token.address,
      lpToken: lpToken.address,
      stgToken: stg.address,
      stargateRouter: stargateRouter.address,
      stargateFarm: stargateFarm.address,
      poolId: USDT_POOL_ID,
      farmId: USDT_LP_FARM_ID,
      upgrader: owner.address,
    });

    await token.transfer(stargateStrategy.address, strategyInitialBalance);
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
      expect(await stargateStrategy.depositToken()).to.be.eq(token.address);
      expect(await stargateStrategy.strategyRouter()).to.be.eq(router.address);
      expect(await stargateStrategy.stgToken()).to.be.eq(stg.address);
      expect(await stargateStrategy.stargateRouter()).to.be.eq(
        stargateRouter.address
      );
      expect(await stargateStrategy.stargateFarm()).to.be.eq(
        stargateFarm.address
      );
      expect(await stargateStrategy.lpToken()).to.be.eq(lpToken.address);
      expect(await stargateStrategy.poolId()).to.be.eq(USDT_POOL_ID);
      expect(await stargateStrategy.farmId()).to.be.eq(USDT_LP_FARM_ID);
      expect(await stargateStrategy.owner()).to.be.eq(owner.address);
    });
  });

  describe("#deposit", function () {
    it("revert if msg.sender is not owner", async function () {
      await expect(
        stargateStrategy.connect(alice).deposit(testUsdtAmount)
      ).to.be.revertedWithCustomError(
        stargateStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("swap token to LP and deposit to stargate farm", async function () {
      const lpAmount = await getLpAmountFromAmount(lpToken.address, testUsdtAmount);
      await stargateStrategy.deposit(testUsdtAmount);

      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(testUsdtAmount)
      );

      expect(await lpToken.balanceOf(stargateStrategy.address)).to.be.equal(0);

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(lpAmount);
    });

    it("do not revert when amount is 0", async function () {
      await stargateStrategy.deposit(0);

      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(
        strategyInitialBalance
      );
    });
  });

  describe("#compound", function () {
    beforeEach(async () => {
      await stargateStrategy.deposit(testUsdtAmount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        stargateStrategy.connect(alice).compound()
      ).to.be.revertedWithCustomError(
        stargateStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Compound STG reward", async function () {
      const stakedLpAmount = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      const exchangedTokenAmount = parseUsdt("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      await skipBlocks(10);

      const stgRewardAmount = await stargateFarm.pendingStargate(
        USDT_LP_FARM_ID,
        stargateStrategy.address
      );

      // Test when STG reward is greater than 0.
      expect(stgRewardAmount).to.greaterThan(0);

      const newStakedLpAmount = await getLpAmountFromAmount(
        lpToken.address,
        exchangedTokenAmount
      );

      await stargateStrategy.compound();

      // The Underlying token balance should be same after compound.
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(testUsdtAmount)
      );

      // Mock Exchange contract should received STG reward amount.
      expect(await stg.balanceOf(mockExchange.address)).to.be.greaterThan(
        stgRewardAmount
      );

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
    });
  });

  describe("#withdrawAll", function () {
    beforeEach(async () => {
      await stargateStrategy.compound();
      await stargateStrategy.deposit(testUsdtAmount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        stargateStrategy.connect(alice).withdrawAll()
      ).to.be.revertedWithCustomError(
        stargateStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Withdraw all tokens", async function () {
      const stakedLpAmount = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      const exchangedTokenAmount = parseUsdt("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const stgRewardAmount = await stargateFarm.pendingStargate(
        USDT_LP_FARM_ID,
        stargateStrategy.address
      );

      const stakedTokenAmount = await lpToken.amountLPtoLD(stakedLpAmount);

      await stargateStrategy.withdrawAll();

      // The Underlying token balance should zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      // STG token balance should zero
      expect(await stg.balanceOf(stargateStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received STG reward amount.
      expect(await stg.balanceOf(mockExchange.address)).to.be.greaterThan(
        stgRewardAmount
      );

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.greaterThan(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
      );

      // expect error when nothing to withdraw
      await expect(
        stargateStrategy.withdrawAll()
      ).to.be.revertedWithCustomError(
        stargateStrategy,
        "NothingToWithdraw"
      );
    });
  });

  describe("#withdraw", function () {
    beforeEach(async () => {
      await stargateStrategy.compound();
      await stargateStrategy.deposit(testUsdtAmount);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        stargateStrategy.connect(alice).withdraw(testUsdtAmount)
      ).to.be.revertedWithCustomError(
        stargateStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Withdraw tokens when remaining token balance is greater than withdraw amount", async function () {
      const withdrawAmount = parseUsdt("100");
      const currnetOwnerBal = await token.balanceOf(owner.address);

      const stakedLpAmount = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      await stargateStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(
        strategyInitialBalance.sub(testUsdtAmount).sub(withdrawAmount)
      );

      // Should have same staked balance after withdraw
      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(stakedLpAmount);

      // Owner should have withdrawn token
      expect(await token.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(withdrawAmount)
      );
    });

    it("Withdraw tokens when remaining token balance is less than withdraw amount", async function () {
      const currentTokenBal = await token.balanceOf(stargateStrategy.address);
      const extraWithdrwalAmount = parseUsdt("100");
      const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

      const stakedLpAmount = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      const exchangedTokenAmount = parseUsdt("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const lpAmountToWithdraw = await getLpAmountFromAmount(
        lpToken.address,
        extraWithdrwalAmount
      );
      const actualWithdrawAmount = await lpToken.amountLPtoLD(lpAmountToWithdraw);

      const compoundAmount = exchangedTokenAmount.sub(
        extraWithdrwalAmount.sub(actualWithdrawAmount)
      );

      const newStakedAmountFromCompound = await getLpAmountFromAmount(
        lpToken.address,
        compoundAmount
      );

      await stargateStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      // STG token balance should zero
      expect(await stg.balanceOf(stargateStrategy.address)).to.be.equal(0);

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.greaterThanOrEqual(
        stakedLpAmount.sub(lpAmountToWithdraw).add(newStakedAmountFromCompound)
      );

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.greaterThan(
        currnetOwnerBal.add(actualWithdrawAmount)
      );
    });

    it("Withdraw all tokens if requested amount is higher than total tokens", async function () {
      const stakedLpAmount = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      const exchangedTokenAmount = parseUsdt("100");
      await token.transfer(mockExchange.address, exchangedTokenAmount);
      await mockExchange.setAmountReceived(exchangedTokenAmount);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const stgRewardAmount = await stargateFarm.pendingStargate(
        USDT_LP_FARM_ID,
        stargateStrategy.address
      );

      const stakedTokenAmount = await await lpToken.amountLPtoLD(stakedLpAmount);

      await stargateStrategy.withdraw(
        strategyInitialBalance.add(parseUsdt("1000"))
      );

      // The Underlying token balance should zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      // STG token balance should zero
      expect(await stg.balanceOf(stargateStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received STG reward amount.
      expect(await stg.balanceOf(mockExchange.address)).to.be.greaterThan(
        stgRewardAmount
      );

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.greaterThanOrEqual(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
      );
    });
  });
});
