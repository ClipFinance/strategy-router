const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDodoStrategy } = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { deploy, skipBlocks, MaxUint256 } = require("../utils");
const { smock } = require("@defi-wonderland/smock");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");



describe("Test DodoBase", function () {

  async function initialState() {

    const [owner, nonReceiptOwner] = await ethers.getSigners();

    const mockExchange = await deploy("MockExchange");
    const router = await smock.fake("StrategyRouter");
    router.getExchange.returns(mockExchange.address);

    const { token: usdtToken, parseToken: parseUsdt } = await getTokenContract(hre.networkVariables.usdt);
    const { token: busdToken, parseToken: parseBusd } = await getTokenContract(hre.networkVariables.busd);
    const { token: dodoToken, parseToken: parseDodo } = await getTokenContract(hre.networkVariables.dodo);

    const lpToken = (await getTokenContract(hre.networkVariables.dodoUsdtLp)).token;

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

    const dodoMine = await getContract("IDodoMine", hre.networkVariables.dodoMine);
    const dodoPool = await getContract(
      "IDodoSingleAssetPool",
      hre.networkVariables.dodoBusdUsdtPool
    );

    const dodoStrategy = await deployDodoStrategy({
      router: router.address,
      token: usdtToken.address,
      lpToken: lpToken.address,
      dodoToken: dodoToken.address,
      pool: dodoPool.address,
      farm: dodoMine.address,
      upgrader: owner.address,
    });

    async function unbalancePool() {
      // sell baseToken to unbalance pool
      await busdToken.approve(dodoPool.address, MaxUint256);
      await dodoPool.sellBaseToken(parseBusd("1000000"), 0, []);
    }

    async function strategyDeposit(amount) {
      await usdtToken.transfer(dodoStrategy.address, amount);
      await dodoStrategy.deposit(amount);
    }

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

    const setReceivedAmountDuringSellReward = async (tokenAmount) => {
      // the strategy will receive tokenAmount from the mock exchange
      // for selling reward tokens that it receives after claiming rewards
      await usdtToken.transfer(mockExchange.address, tokenAmount);
      await mockExchange.setAmountReceived(tokenAmount);
    }

    return {
      owner, nonReceiptOwner,
      router, dodoStrategy, mockExchange,
      dodoToken, lpToken, usdtToken, busdToken, parseUsdt, parseBusd,
      dodoPool, dodoMine,
      getLpAmountFromAmount, strategyDeposit, setReceivedAmountDuringSellReward, unbalancePool,
      getAmountFromLpAmount, getPenaltyAmount
    };
  }

  describe("constructor & initialize", function () {
    it("revert if deposit token is invalid", async function () {
      const { owner, router, dodoToken, lpToken, dodoPool, dodoMine, } = await loadFixture(initialState);
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
      const { owner, router, dodoStrategy, dodoToken, usdtToken, lpToken, dodoPool, dodoMine } = await loadFixture(initialState);

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
      const { nonReceiptOwner, dodoStrategy, parseUsdt } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      await expect(
        dodoStrategy.connect(nonReceiptOwner).deposit(testUsdtAmount)
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("revert if the deposit amount exceeds the transferred tokens", async () => {
      const { dodoStrategy, usdtToken, parseUsdt } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      await expect(
        dodoStrategy.deposit(MaxUint256)
      ).to.be.revertedWithCustomError(dodoStrategy, "DepositAmountExceedsBalance");

    });

    it("swap token to LP and deposit to DodoMine", async function () {
      const { dodoStrategy, usdtToken, lpToken, parseUsdt, dodoMine,
        getLpAmountFromAmount, strategyDeposit } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      const lpAmount = await getLpAmountFromAmount(testUsdtAmount, false);

      await strategyDeposit(testUsdtAmount);

      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(await lpToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(lpAmount);
    });

    it("do not revert when amount is 0", async function () {
      const { dodoStrategy, usdtToken, parseUsdt, } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      await dodoStrategy.deposit(0);
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      await dodoStrategy.deposit(0);
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(testUsdtAmount);
    });
  });

  describe("#compound", function () {

    it("revert if msg.sender is not owner", async function () {
      const { nonReceiptOwner, dodoStrategy, parseUsdt, strategyDeposit } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      await strategyDeposit(testUsdtAmount);

      await expect(
        dodoStrategy.connect(nonReceiptOwner).compound()
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Compound DODO reward", async function () {
      const { dodoStrategy, lpToken, dodoMine, mockExchange, 
        usdtToken, parseUsdt, dodoToken, getLpAmountFromAmount,
        strategyDeposit, setReceivedAmountDuringSellReward } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      await strategyDeposit(testUsdtAmount);

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
      const { dodoStrategy, lpToken, dodoMine, mockExchange, 
        usdtToken, parseUsdt, dodoToken, strategyDeposit, setReceivedAmountDuringSellReward,
        getLpAmountFromAmount, } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      await strategyDeposit(testUsdtAmount);

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
      const { nonReceiptOwner, dodoStrategy, usdtToken, parseUsdt, strategyDeposit } = await loadFixture(initialState);

      const testUsdtAmount = parseUsdt("10000");
      // 50% on strategy's USDT account
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      // 50% deposit

      await strategyDeposit(testUsdtAmount);

      await expect(
        dodoStrategy.connect(nonReceiptOwner).withdrawAll()
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    describe("Withdraw all tokens", function () {

      it("when penalty applied", async function () {
        const { owner, dodoStrategy, usdtToken, parseUsdt, strategyDeposit, 
          getAmountFromLpAmount, getPenaltyAmount, setReceivedAmountDuringSellReward,
          dodoMine, lpToken, dodoToken, mockExchange, unbalancePool } = await loadFixture(initialState);

        // setup conditions to get penalty on withdraw
        await unbalancePool();
 
        // amount that will trigger penalty
        let testUsdtAmount = parseUsdt("1000000");
        // 50% on strategy's USDT account
        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
        // 50% deposit
        await strategyDeposit(testUsdtAmount);

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
          currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testUsdtAmount).sub(penalty),
        );
      });

      it("without penalty", async function () {
        const { owner, dodoStrategy, usdtToken, parseUsdt, strategyDeposit, 
          getAmountFromLpAmount, getPenaltyAmount, setReceivedAmountDuringSellReward,
          dodoMine, lpToken, dodoToken, mockExchange, unbalancePool } = await loadFixture(initialState);

        // amount that won't trigger penalty
        let testUsdtAmount = parseUsdt("10");
        // 50% on strategy's USDT account
        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
        // 50% deposit
        await strategyDeposit(testUsdtAmount);

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
          currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testUsdtAmount).sub(penalty),
        );
      });
    });
  });

  describe("#totalTokens", function () {

    it("should return correct amount of the locked and deposited tokens", async function () {

      const { dodoStrategy, usdtToken, parseUsdt, strategyDeposit, 
        getAmountFromLpAmount, dodoMine, lpToken } = await loadFixture(initialState);

      let testUsdtAmount = parseUsdt("10000");
      await strategyDeposit(testUsdtAmount);

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

    it("revert if msg.sender is not owner", async function () {
      const { nonReceiptOwner, dodoStrategy, parseUsdt, strategyDeposit, } = await loadFixture(initialState);

      let testUsdtAmount = parseUsdt("10000");
      await strategyDeposit(testUsdtAmount);

      await expect(
        dodoStrategy.connect(nonReceiptOwner).withdraw(testUsdtAmount)
      ).to.be.revertedWithCustomError(
        dodoStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("Withdraw tokens when remaining token balance is greater than withdraw amount", async function () {

      const { dodoStrategy, usdtToken, lpToken, parseUsdt, strategyDeposit, 
        dodoMine, owner } = await loadFixture(initialState);

      let testUsdtAmount = parseUsdt("10000");
      await strategyDeposit(testUsdtAmount);

      // simulate 'remaining token balance' 
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      const withdrawAmount = parseUsdt("100");
      const currentOwnerBal = await usdtToken.balanceOf(owner.address);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

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

    describe("Withdraw tokens when remaining token balance is less than withdraw amount", function () {

      it("when penalty applied", async function () {

        const { dodoStrategy, usdtToken,  parseUsdt, strategyDeposit, 
          owner, unbalancePool, getPenaltyAmount, dodoToken } = await loadFixture(initialState);

        let testUsdtAmount = parseUsdt("10000");
        await strategyDeposit(testUsdtAmount);

        // setup conditions to get penalty on withdraw
        await unbalancePool();

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
        const { dodoStrategy, usdtToken,  parseUsdt, strategyDeposit, 
          owner, getPenaltyAmount, dodoToken } = await loadFixture(initialState);

        let testUsdtAmount = parseUsdt("10000");
        await strategyDeposit(testUsdtAmount);

        await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

        const currentTokenBal = await usdtToken.balanceOf(dodoStrategy.address);
        const extraWithdrwalAmount = parseUsdt("100");
        const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

        const currentOwnerBal = await usdtToken.balanceOf(owner.address);

        await skipBlocks(10);

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
        const { dodoStrategy, usdtToken,  parseUsdt, strategyDeposit, 
          owner, getPenaltyAmount, dodoToken, dodoMine, lpToken, unbalancePool,
          setReceivedAmountDuringSellReward, getAmountFromLpAmount, mockExchange } = await loadFixture(initialState);

        let testUsdtAmount = parseUsdt("10000");
        await strategyDeposit(testUsdtAmount);

        // setup conditions to get penalty on withdraw
        await unbalancePool();

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

        let currentTokenBal = await dodoStrategy.totalTokens();
        let amountToWithdraw = testUsdtAmount.add(exchangedTokenAmount);
        expect(amountToWithdraw).to.be.gt(currentTokenBal)

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
        const { dodoStrategy, usdtToken,  parseUsdt, strategyDeposit, 
          owner, getPenaltyAmount, dodoToken, dodoMine, lpToken,
          setReceivedAmountDuringSellReward, getAmountFromLpAmount, mockExchange } = await loadFixture(initialState);

        let testUsdtAmount = parseUsdt("10000");
        await strategyDeposit(testUsdtAmount);

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
        expect(penalty).to.be.equal(0);

        let currentTokenBal = await dodoStrategy.totalTokens();
        let amountToWithdraw = testUsdtAmount.add(exchangedTokenAmount);
        expect(amountToWithdraw).to.be.gt(currentTokenBal)

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
});
