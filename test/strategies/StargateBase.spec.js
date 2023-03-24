const { expect } = require("chai");
const { ethers } = require("hardhat");
const { utils } = require("ethers");
const { setupCore, deployStargateStrategy } = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { provider, deploy, skipBlocks } = require("../utils");

const {
  setStorageAt,
} = require("@nomicfoundation/hardhat-network-helpers");

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
  let dustUsdt;
  let testUsdtAmountWithDust;

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
    dustUsdt = parseUsdt("0.000000999");
    testUsdtAmountWithDust = testUsdtAmount.add(dustUsdt);

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
    it("revert if deposit token is invalid", async function () {
      try {
        await deployStargateStrategy({
          router: router.address,
          token: stg.address, // set invalid deposit token
          lpToken: lpToken.address,
          stgToken: stg.address,
          stargateRouter: stargateRouter.address,
          stargateFarm: stargateFarm.address,
          poolId: USDT_POOL_ID,
          farmId: USDT_LP_FARM_ID,
          upgrader: owner.address,
        });
      } catch (error) {
        expect(error.message).to.be.contain("reverted with custom error 'InvalidInput()");
      }
    });

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

    it("revert if deposit amount exceeds transferred tokens", async () => {
      await token.transfer(stargateStrategy.address, testUsdtAmount);

      await expect(
        stargateStrategy.deposit(testUsdtAmountWithDust)
      ).to.be.revertedWithCustomError(stargateStrategy, "DepositAmountExceedsBalance");

    });

    it("swap token to LP and deposit to stargate farm", async function () {
      const lpAmount = await amountLDtoLP(testUsdtAmount);

      await token.transfer(stargateStrategy.address, testUsdtAmount);
      await stargateStrategy.deposit(testUsdtAmount);

      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      expect(await lpToken.balanceOf(stargateStrategy.address)).to.be.equal(0);

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(lpAmount);
    });

    it("do not revert when amount is 0", async function () {
      await stargateStrategy.deposit(0);

      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
    });

    it("the remained dust should settle on the stargate strategy account and dust allowance decreased after the deposit", async () => {
      // Deposit with the dust
      await token.transfer(stargateStrategy.address, testUsdtAmountWithDust);
      await stargateStrategy.deposit(testUsdtAmountWithDust);

      // expect the remained dust to settle on the stargate strategy account
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(dustUsdt);

      // expect the dust allowance has decreased and we can make another deposit without any errors
      await token.transfer(stargateStrategy.address, testUsdtAmount);
      await stargateStrategy.deposit(testUsdtAmount);

    });
  });

  describe("#compound", function () {
    beforeEach(async () => {
      await token.transfer(stargateStrategy.address, testUsdtAmount);
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

      const receivedTokenAmountForSoldReward = parseUsdt("100");
      await setReceivedAmountDuringSellReward(receivedTokenAmountForSoldReward);

      await skipBlocks(10);

      const stgRewardAmount = await stargateFarm.pendingStargate(
        USDT_LP_FARM_ID,
        stargateStrategy.address
      );

      // Test when STG reward is greater than 0.
      expect(stgRewardAmount).to.greaterThan(0);

      const newStakedLpAmount = await amountLDtoLP(receivedTokenAmountForSoldReward);

      await stargateStrategy.compound();

      // The Underlying token balance should be zero after compound.
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);

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

    it("the accrued dust should be deposited once its sum with compound reward", async function () {
      // set amount received as token amount with the dust to mock exchange
      await setReceivedAmountDuringSellReward(testUsdtAmountWithDust);

      // make 1st compound
      await skipBlocks(10);
      await stargateStrategy.compound();

      // expect the dust to settle on the stargate strategy account
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(dustUsdt);

      // make 2nd compound
      await token.transfer(mockExchange.address, testUsdtAmountWithDust);
      await skipBlocks(10);
      await stargateStrategy.compound();

      // calculate the remained dust
      const remainedDust = await getDustFromAmount(dustUsdt.mul(2));

      // expect the remaining dust to settle on the stargate strategy score after the 2nd connection
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(remainedDust);
    });
  });

  describe("#totalTokens", function () {
    beforeEach(async () => {
      await token.transfer(stargateStrategy.address, testUsdtAmount);
      await stargateStrategy.deposit(testUsdtAmount);
    });

    it("should return correct amount of the locked and deposited tokens", async function () {
      const [stakeddLpAmount] = await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address);
      const stakedTokenAmount = await lpToken.amountLPtoLD(stakeddLpAmount);

      await token.transfer(stargateStrategy.address, testUsdtAmount);

      const tokenBalance = await token.balanceOf(stargateStrategy.address);
      const totalStrategyTokens = tokenBalance.add(stakedTokenAmount);

      expect(
        await stargateStrategy.totalTokens()
      ).to.be.equal(totalStrategyTokens);
    });

    it("should return correct amount of the locked and deposited dust amount of tokens", async function () {
      const [stakeddLpAmount] = await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address);
      const stakedTokenAmount = await lpToken.amountLPtoLD(stakeddLpAmount);

      await token.transfer(stargateStrategy.address, dustUsdt); // dust deposit

      const tokenBalance = await token.balanceOf(stargateStrategy.address);
      const totalStrategyTokens = tokenBalance.add(stakedTokenAmount);

      expect(
        await stargateStrategy.totalTokens()
      ).to.be.equal(totalStrategyTokens);
    });

  });

  describe("#withdraw", function () {
    beforeEach(async () => {
      await stargateStrategy.compound();
      await token.transfer(stargateStrategy.address, testUsdtAmount);
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

    it("should take only the remaining token balance to withdraw if it is enough to cover the withdrawal amount", async function () {
      const withdrawAmount = parseUsdt("100");
      await token.transfer(stargateStrategy.address, withdrawAmount);

      // save states before
      const ownerBalanceBefore = await token.balanceOf(owner.address);
      const stakedLpAmountBefore = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      await stargateStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should be zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);

      // Should have same staked balance after withdraw
      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(stakedLpAmountBefore);

      // Owner should have withdrawn token
      expect(await token.balanceOf(owner.address)).to.be.equal(
        ownerBalanceBefore.add(withdrawAmount)
      );
    });

    it("should take the staked balance to withdraw if the remaining token balance is not enough to cover the withdrawal amount", async function () {
      const receivedTokenAmountForSoldReward = parseUsdt("100");
      await setReceivedAmountDuringSellReward(receivedTokenAmountForSoldReward);

      // prepare and save states before
      await token.transfer(stargateStrategy.address, testUsdtAmount);
      const currentTokenBalance = await token.balanceOf(stargateStrategy.address);

      const extraWithdrwalAmount = parseUsdt("100");
      const withdrawAmount = currentTokenBalance.add(extraWithdrwalAmount);

      const ownerBalanceBefore = await token.balanceOf(owner.address);
      const stakedLpAmountBefore = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];


      await skipBlocks(10);

      // calculate actual extra withdrawal amount, because of the division
      // in the amountLDtoLP function the strategy will receive less than expected
      const lpAmountToExtraWithdraw = await amountLDtoLP(extraWithdrwalAmount);
      const actualExtraWithdrawAmount = await lpToken.amountLPtoLD(lpAmountToExtraWithdraw);

      const reinvestedTokenAmountToFarm = receivedTokenAmountForSoldReward.sub(
        extraWithdrwalAmount.sub(actualExtraWithdrawAmount)
      );

      const reinvestedLpAmount = await amountLDtoLP(reinvestedTokenAmountToFarm);

      await stargateStrategy.withdraw(withdrawAmount);

      // The Underlying token balance should be zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      // STG token balance should zero
      expect(await stg.balanceOf(stargateStrategy.address)).to.be.equal(0);

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(
        stakedLpAmountBefore.sub(lpAmountToExtraWithdraw).add(reinvestedLpAmount)
      );

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.equal(
        ownerBalanceBefore.add(withdrawAmount)
      );
    });

    it("Withdraw all tokens if requested amount is higher than total tokens", async function () {
      const stakedLpAmount = (
        await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
      )[0];

      const receivedTokenAmountForSoldReward = parseUsdt("100");
      await setReceivedAmountDuringSellReward(receivedTokenAmountForSoldReward);

      const ownerBalanceBefore = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const stgRewardAmount = await stargateFarm.pendingStargate(
        USDT_LP_FARM_ID,
        stargateStrategy.address
      );

      const stakedTokenAmount = await lpToken.amountLPtoLD(stakedLpAmount);

      await stargateStrategy.withdraw(stakedTokenAmount.add(parseUsdt("1000")));

      // The Underlying token balance should zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      // STG token balance should zero
      expect(await stg.balanceOf(stargateStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received STG reward amount.
      expect(await stg.balanceOf(mockExchange.address)).to.be.gte(
        stgRewardAmount
      );

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(0);

      const ownerBalanceAfter = await token.balanceOf(owner.address);
      // Owner should have all tokens.
      expect(ownerBalanceAfter).to.be.equal(
        ownerBalanceBefore.add(stakedTokenAmount).add(receivedTokenAmountForSoldReward)
      );
    });
  });

  describe("#withdrawAll", function () {
    beforeEach(async () => {
      await stargateStrategy.compound();
      await token.transfer(stargateStrategy.address, testUsdtAmount);
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

      const receivedTokenAmountForSoldReward = parseUsdt("100");
      await setReceivedAmountDuringSellReward(receivedTokenAmountForSoldReward);

      const currnetOwnerBal = await token.balanceOf(owner.address);

      await skipBlocks(10);

      const stgRewardAmount = await stargateFarm.pendingStargate(
        USDT_LP_FARM_ID,
        stargateStrategy.address
      );

      const stakedTokenAmount = await lpToken.amountLPtoLD(stakedLpAmount);

      // add unstaked balance
      await token.transfer(stargateStrategy.address, testUsdtAmount);
      expect(await token.balanceOf(stargateStrategy.address)).to.be.gt(0);

      await stargateStrategy.withdrawAll();

      // The Underlying token balance should zero
      expect(await token.balanceOf(stargateStrategy.address)).to.be.equal(0);
      // STG token balance should zero
      expect(await stg.balanceOf(stargateStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received STG reward amount.
      expect(await stg.balanceOf(mockExchange.address)).to.be.gte(
        stgRewardAmount
      );

      expect(
        (
          await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address)
        )[0]
      ).to.be.equal(0);

      // Owner should have all tokens.
      expect(await token.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(stakedTokenAmount).add(receivedTokenAmountForSoldReward)
      );

      // expect 0 when nothing to withdraw
      expect(
        await stargateStrategy.callStatic.withdrawAll()
      ).to.be.equal(0);
    });

    it("should revert if incufitient pool liquidity via withdraw all tokens", async function () {
      const deltaCreditBefore = await lpToken.deltaCredit();

      // set custom delta credit
      const deltaCreditSlot = "0x15";
      const customDeltaCredit = ethers.BigNumber.from(10000);
      await setStorageAt(lpToken.address, deltaCreditSlot, customDeltaCredit);

      await expect(
        stargateStrategy.withdrawAll()
      ).to.be.revertedWithCustomError(
        stargateStrategy,
        "IncufitientPoolLiquidityToWithdraw"
      );

      // reset delta credit
      await setStorageAt(lpToken.address, deltaCreditSlot, deltaCreditBefore);

      // should withdraw all successfully
      await stargateStrategy.withdrawAll();

      expect(
        (await stargateFarm.userInfo(USDT_LP_FARM_ID, stargateStrategy.address))[0]
      ).to.be.equal(0);

    });
  });

  const setReceivedAmountDuringSellReward = async (amountSD) => {
    // the strategy will receive amountSD from the mock exchange
    // for sell reward tokens which it gets during withdrawal from the farm
    await token.transfer(mockExchange.address, amountSD);
    await mockExchange.setAmountReceived(amountSD);
  }

  const getDustFromAmount = async (amountLD) => {
    const convertRate = await lpToken.convertRate();

    const amountSDinLD = amountLD.div(convertRate).mul(convertRate);
    return amountLD.sub(amountSDinLD);
  }

  const amountLDtoLP = async (amountLD) => {
    const totalSupply = await lpToken.totalSupply();
    const totalLiquidity = await lpToken.totalLiquidity();
    const convertRate = await lpToken.convertRate();

    const amountSD = amountLD.div(convertRate);
    return amountSD.mul(totalSupply).div(totalLiquidity);
  }
});
