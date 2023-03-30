const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDodoStrategy } = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { provider, deploy, skipBlocks, MaxUint256 } = require("../utils");
const { smock } = require("@defi-wonderland/smock");
const { getStorageAt, setStorageAt } = require("@nomicfoundation/hardhat-network-helpers");

describe("Test DodoBase", function () {

  let owner, nonReceiptOwner;
  // mainnet contracts
  let dodoMine, dodoPool;
  // mainnet tokens
  let usdtToken, busdToken, dodoToken, lpToken;
  // core contracts
  let router, mockExchange;
  // dodo strategy
  let dodoStrategy;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  let parseUsdt, parseDodo, parseBusd;

  let testUsdtAmount;

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    mockExchange = await deploy("MockExchange");
    router = await smock.fake("StrategyRouter");
    router.getExchange.returns(mockExchange.address);

    ({ token: usdtToken, parseToken: parseUsdt } = await getTokenContract(hre.networkVariables.usdt));
    ({ token: busdToken, parseToken: parseBusd } = await getTokenContract(hre.networkVariables.busd));
    ({ token: dodoToken, parseToken: parseDodo } = await getTokenContract(hre.networkVariables.dodo));

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
    await mintForkedToken(
      busdToken.address,
      owner.address,
      parseBusd("10000000000")
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
      await expect(deployDodoStrategy({
        router: router.address,
        token: router.address, // set invalid deposit token
        lpToken: lpToken.address,
        dodoToken: dodoToken.address,
        pool: dodoPool.address,
        farm: dodoMine.address,
        upgrader: owner.address,
      })).to.be.rejectedWith("reverted with custom error 'InvalidInput()'");
    });

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

    it("revert if the deposit amount exceeds the transferred tokens", async () => {
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      await expect(
        dodoStrategy.deposit(MaxUint256)
      ).to.be.revertedWithCustomError(dodoStrategy, "DepositAmountExceedsBalance");

    });

    it("swap token to LP and deposit to DodoMine", async function () {
      const lpAmount = await getLpAmountFromAmount(testUsdtAmount, false);

      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      await dodoStrategy.deposit(testUsdtAmount);

      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(await lpToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(lpAmount);
    });

    it("do not revert when amount is 0", async function () {
      await dodoStrategy.deposit(0);
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      await dodoStrategy.deposit(0);
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(testUsdtAmount);
    });
  });

  describe("#compound", function () {
    beforeEach(async () => {
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
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
      await setReceivedAmountDuringSellReward(exchangedTokenAmount);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      // Test when DODO reward is greater than 0.
      expect(dodoRewardAmount).to.greaterThan(0);

      const newStakedLpAmount = await getLpAmountFromAmount(exchangedTokenAmount, false);

      await dodoStrategy.compound();

      // The Underlying token balance should be zero after compound.
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // Mock Exchange contract should received DODO reward amount.
      expect(await dodoToken.balanceOf(mockExchange.address)).to.be.greaterThan(
        dodoRewardAmount
      );

      // LP balance should be increased after reward restake
      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
    });

    it("the accrued dust should be deposited once its sum with compound reward", async function () {
      // simulate dust
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = parseUsdt("100");
      await setReceivedAmountDuringSellReward(exchangedTokenAmount);

      await skipBlocks(10);

      const newStakedLpAmount = await getLpAmountFromAmount(
        exchangedTokenAmount.add(testUsdtAmount),
        false
      );

      // make compound
      await dodoStrategy.compound();

      // expect no dust to settle on the strategy account
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      // LP balance should be increased after reward restake
      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
    });
  });

  describe("#withdrawAll", function () {

    it("revert if msg.sender is not owner", async function () {
      // 50% on strategy's USDT account
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      // 50% deposit
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      await dodoStrategy.deposit(testUsdtAmount);

      await expect(
        dodoStrategy.connect(nonReceiptOwner).withdrawAll()
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    describe("Withdraw all tokens", function () {

      it("when penalty applied", async function () {
        // sell baseToken to unbalance pool
        await busdToken.approve(dodoPool.address, MaxUint256);
        await dodoPool.sellBaseToken(parseBusd("1000000"), 0, []);

        // amount that will trigger penalty
        let bigTestUsdtAmount = parseUsdt("1000000");
        // 50% on strategy's USDT account
        await usdtToken.transfer(dodoStrategy.address, bigTestUsdtAmount);

        // 50% deposit
        await usdtToken.transfer(dodoStrategy.address, bigTestUsdtAmount);
        await dodoStrategy.deposit(bigTestUsdtAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseUsdt("100");
        await setReceivedAmountDuringSellReward(exchangedTokenAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

        const dodoRewardAmount = await dodoMine.getPendingReward(
          lpToken.address,
          dodoStrategy.address
        );

        const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

        const penalty = await getPenaltyAmount(stakedTokenAmount);
        expect(penalty).to.be.greaterThan(0);

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
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(bigTestUsdtAmount).sub(penalty),
        );
      });

      it("without penalty", async function () {
        // amount that won't trigger penalty
        let smallTestUsdtAmount = parseUsdt("10");
        // 50% on strategy's USDT account
        await usdtToken.transfer(dodoStrategy.address, smallTestUsdtAmount);
        // 50% deposit
        await usdtToken.transfer(dodoStrategy.address, smallTestUsdtAmount);
        await dodoStrategy.deposit(smallTestUsdtAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseUsdt("100");
        await setReceivedAmountDuringSellReward(exchangedTokenAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

        const dodoRewardAmount = await dodoMine.getPendingReward(
          lpToken.address,
          dodoStrategy.address
        );

        await setZeroPenaltyForWithdrawOnDODO();
        const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);
        const penalty = await getPenaltyAmount(stakedTokenAmount);
        expect(penalty).to.be.equal(0);

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
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(smallTestUsdtAmount).sub(penalty),
        );
      });
    });
  });

  describe("#totalTokens", function () {
    beforeEach(async () => {
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      await dodoStrategy.deposit(testUsdtAmount);
    });

    it("should return correct amount of the locked and deposited tokens", async function () {

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      const tokenBalance = await usdtToken.balanceOf(dodoStrategy.address);
      const totalStrategyTokens = tokenBalance.add(stakedTokenAmount);

      expect(
        await dodoStrategy.totalTokens()
      ).to.be.equal(totalStrategyTokens);
    });
  });

  describe("#withdraw", function () {
    beforeEach(async () => {
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
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

    describe("Withdraw tokens when remaining token balance is greater than withdraw amount", function () {

      it("when penalty applied", async function () {

        // sell baseToken to unbalance pool
        await busdToken.approve(dodoPool.address, MaxUint256);
        await dodoPool.sellBaseToken(parseBusd("1000000"), 0, []);

        // simulate 'remaining token balance' 
        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

        const withdrawAmount = parseUsdt("100");
        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        // check that penalty exists
        const penalty = await getPenaltyAmount(withdrawAmount);
        expect(penalty).to.be.greaterThan(0);

        await dodoStrategy.withdraw(withdrawAmount);

        // Remaining token balance on strategy should decrease
        expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(
          testUsdtAmount.sub(withdrawAmount)
        );

        // Should have same staked balance after withdraw
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(stakedLpAmount);

        // Owner should have withdrawn token
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(withdrawAmount)
        );
      });

      it("without penalty", async function () {

        // simulate 'remaining token balance' 
        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

        const withdrawAmount = parseUsdt("100");
        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        await setZeroPenaltyForWithdrawOnDODO();
        // check that there is no penalty 
        const penalty = await getPenaltyAmount(withdrawAmount);
        expect(penalty).to.be.equal(0);

        await dodoStrategy.withdraw(withdrawAmount);

        // Remaining token balance on strategy should decrease
        expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(
          testUsdtAmount.sub(withdrawAmount)
        );

        // Should have same staked balance after withdraw
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(stakedLpAmount);

        // Owner should have withdrawn token
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(withdrawAmount)
        );
      });
    });

    describe("Withdraw tokens when remaining token balance is less than withdraw amount", function () {

      it("when penalty applied", async function () {

        // sell baseToken to unbalance pool
        await busdToken.approve(dodoPool.address, MaxUint256);
        await dodoPool.sellBaseToken(parseBusd("1000000"), 0, []);

        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

        const currentTokenBal = await usdtToken.balanceOf(dodoStrategy.address);
        const extraWithdrwalAmount = parseUsdt("100");
        const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

        const penalty = await getPenaltyAmount(extraWithdrwalAmount);
        expect(penalty).to.be.greaterThan(0);

        // check return value is correct
        expect(
          await dodoStrategy.callStatic.withdraw(withdrawAmount)
        ).to.be.equal(withdrawAmount.sub(penalty));

        await dodoStrategy.withdraw(withdrawAmount);

        // The Underlying token balance should be zero
        expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // DODO token balance should zero
        expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // Owner should have all tokens.
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(withdrawAmount.sub(penalty))
        );
      });

      it("without penalty", async function () {

        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

        const currentTokenBal = await usdtToken.balanceOf(dodoStrategy.address);
        const extraWithdrwalAmount = parseUsdt("100");
        const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

        await setZeroPenaltyForWithdrawOnDODO();
        const penalty = await getPenaltyAmount(extraWithdrwalAmount);
        expect(penalty).to.be.equal(0);

        // check return value is correct
        expect(
          await dodoStrategy.callStatic.withdraw(withdrawAmount)
        ).to.be.equal(withdrawAmount);

        await dodoStrategy.withdraw(withdrawAmount);

        // The Underlying token balance should be zero
        expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // DODO token balance should zero
        expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // Owner should have all tokens.
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(withdrawAmount)
        );
      });
    });

    describe("Withdraw all tokens if requested amount is higher than total tokens", async function () {

      it("when penalty applied", async function () {
        // sell baseToken to unbalance pool
        await busdToken.approve(dodoPool.address, MaxUint256);
        await dodoPool.sellBaseToken(parseBusd("1000000"), 0, []);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseUsdt("100");
        await setReceivedAmountDuringSellReward(exchangedTokenAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

        const dodoRewardAmount = await dodoMine.getPendingReward(
          lpToken.address,
          dodoStrategy.address
        );

        const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

        const penalty = await getPenaltyAmount(stakedTokenAmount);
        expect(penalty).to.be.greaterThan(0);

        let extraAmount = parseUsdt("10000");
        let allAvailableBalance = testUsdtAmount.add(exchangedTokenAmount);
        let amountToWithdraw = allAvailableBalance.add(extraAmount);

        await dodoStrategy.withdraw(amountToWithdraw);

        // The Underlying token balance should zero
        expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // DODO token balance should zero
        expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // Mock Exchange contract should received DODO reward amount.
        expect(await dodoToken.balanceOf(mockExchange.address)).to.be.greaterThan(
          dodoRewardAmount
        );
        // farm should have 0 tokens
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(0);
        // Owner should have all tokens.
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).sub(penalty)
        );
      });

      it("without penalty", async function () {

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseUsdt("100");
        await setReceivedAmountDuringSellReward(exchangedTokenAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

        const dodoRewardAmount = await dodoMine.getPendingReward(
          lpToken.address,
          dodoStrategy.address
        );
        
        await setZeroPenaltyForWithdrawOnDODO();
        const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

        const penalty = await getPenaltyAmount(stakedTokenAmount);
        expect(penalty).to.be.equal(0);

        let extraAmount = parseUsdt("10000");
        let allAvailableBalance = testUsdtAmount.add(exchangedTokenAmount);
        let amountToWithdraw = allAvailableBalance.add(extraAmount);

        await dodoStrategy.withdraw(amountToWithdraw);

        // The Underlying token balance should zero
        expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // DODO token balance should zero
        expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
        // Mock Exchange contract should received DODO reward amount.
        expect(await dodoToken.balanceOf(mockExchange.address)).to.be.greaterThan(
          dodoRewardAmount
        );
        // farm should have 0 tokens
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(0);
        // Owner should have all tokens.
        expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).sub(penalty)
        );
      });
    });
  });


  async function getLpAmountFromAmount(amount, shouldCeil = true) {
    const expectedTarget = await dodoPool.getExpectedTarget();
    const lpSupply = await lpToken.totalSupply();
    const isQuote = !(await dodoStrategy.isBase());
    // should ceil when doing withdrawals, but not for deposit or compound 
    if (shouldCeil)
      return amount.mul(lpSupply).divCeil(expectedTarget[isQuote ? 1 : 0]);
    else
      return amount.mul(lpSupply).div(expectedTarget[isQuote ? 1 : 0]);
  }

  async function getAmountFromLpAmount(lpAmount) {
    const expectedTarget = await dodoPool.getExpectedTarget();
    const lpSupply = await lpToken.totalSupply();

    const isQuote = !(await dodoStrategy.isBase());
    return lpAmount.mul(expectedTarget[isQuote ? 1 : 0]).div(lpSupply);
  }

  async function getPenaltyAmount(amount) {
    const isQuote = !(await dodoStrategy.isBase());

    if (isQuote)
      return await dodoPool.getWithdrawQuotePenalty(amount);
    else
      return await dodoPool.getWithdrawBasePenalty(amount);
  }

  async function setZeroPenaltyForWithdrawOnDODO() {
    const slot = 0xE; // _R_STATUS_
    await setStorageAt(dodoPool.address, slot, 0x0); // we want "ONE" from "Types {ONE, BELOW, ABOVE}"
  }

  const setReceivedAmountDuringSellReward = async (tokenAmount) => {
    // the strategy will receive tokenAmount from the mock exchange
    // for selling reward tokens that it receives after claiming rewards
    await usdtToken.transfer(mockExchange.address, tokenAmount);
    await mockExchange.setAmountReceived(tokenAmount);
  }
});