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
const { BigNumber } = require("ethers");


testSuite(hre.networkVariables.usdt, hre.networkVariables.busd, hre.networkVariables.dodoUsdtLp, "USDT");
testSuite(hre.networkVariables.busd, hre.networkVariables.usdt, hre.networkVariables.dodoBusdLp, "BUSD");

function testSuite(targetTokenAddress, otherTokenAddress, LPTokenAddress, depositTokenName) {
  describe(`Test DodoBase: depositToken = ${depositTokenName}`, function () {

    async function initialState() {

      const [owner, nonReceiptOwner] = await ethers.getSigners();

      const mockExchange = await deploy("MockExchange");
      const router = await smock.fake("StrategyRouter");
      router.getExchange.returns(mockExchange.address);

      const { token: targetToken, parseToken: parseTarget } = await getTokenContract(targetTokenAddress);
      const { token: otherToken, parseToken: parseOther } = await getTokenContract(otherTokenAddress);
      const { token: dodoToken, parseToken: parseDodo } = await getTokenContract(hre.networkVariables.dodo);

      const lpToken = (await getTokenContract(LPTokenAddress)).token;

      await mintForkedToken(
        dodoToken.address,
        owner.address,
        parseDodo("10000000000")
      );
      await mintForkedToken(
        targetToken.address,
        owner.address,
        parseTarget("10000000000")
      );
      await mintForkedToken(
        otherToken.address,
        owner.address,
        parseOther("10000000000")
      );

      const dodoMine = await getContract("IDodoMine", hre.networkVariables.dodoMine);
      const dodoPool = await getContract(
        "IDodoSingleAssetPool",
        hre.networkVariables.dodoBusdUsdtPool
      );

      const dodoStrategy = await deployDodoStrategy({
        router: router.address,
        token: targetToken.address,
        lpToken: lpToken.address,
        dodoToken: dodoToken.address,
        pool: dodoPool.address,
        farm: dodoMine.address,
        upgrader: owner.address,
      });
      const isBase = await dodoStrategy.isBase();
      console.log(isBase, await dodoStrategy.depositToken());

      async function unbalancePool() {
        // sell otherToken to unbalance pool
        await otherToken.approve(dodoPool.address, MaxUint256);
        if (isBase)
          await dodoPool.buyBaseToken(parseOther("1000000"), MaxUint256, []);
        else
          await dodoPool.sellBaseToken(parseOther("1000000"), 0, []);
      }

      async function tryToSetupZeroPenaltyForTargetToken(withdrawAmount) {
        let soldForBalance = parseTarget("1000000");
        let penalty = await getPenaltyAmount(withdrawAmount);
        if (penalty.isZero()) return BigNumber.from(0);
        // increase amount of targetToken in pool
        await targetToken.approve(dodoPool.address, MaxUint256);
        if (isBase) {
          soldForBalance = await dodoPool.callStatic.sellBaseToken(soldForBalance, 0, []);
          await dodoPool.sellBaseToken(soldForBalance, 0, []);
        } else {
          soldForBalance = await dodoPool.callStatic.buyBaseToken(soldForBalance, MaxUint256, []);
          await dodoPool.buyBaseToken(soldForBalance, MaxUint256, []);
        }
        return soldForBalance;
      }

      async function strategyDeposit(amount) {
        await targetToken.transfer(dodoStrategy.address, amount);
        await dodoStrategy.deposit(amount);
      }

      async function getLpAmountFromAmount(amount, shouldCeil = true) {
        const expectedTarget = await dodoPool.getExpectedTarget();
        const lpSupply = await lpToken.totalSupply();
        // should ceil when doing withdrawals, but not for deposit or compound 
        if (shouldCeil)
          return amount.mul(lpSupply).divCeil(expectedTarget[isBase ? 0 : 1]);
        else
          return amount.mul(lpSupply).div(expectedTarget[isBase ? 0 : 1]);
      }

      async function getAmountFromLpAmount(lpAmount) {
        const expectedTarget = await dodoPool.getExpectedTarget();
        const lpSupply = await lpToken.totalSupply();

        return lpAmount.mul(expectedTarget[isBase ? 0 : 1]).div(lpSupply);
      }

      async function getPenaltyAmount(amount) {
        if (isBase)
          return await dodoPool.getWithdrawBasePenalty(amount);
        else
          return await dodoPool.getWithdrawQuotePenalty(amount);
      }

      const setReceivedAmountDuringSellReward = async (tokenAmount) => {
        // the strategy will receive tokenAmount from the mock exchange
        // for selling reward tokens that it receives after claiming rewards
        await targetToken.transfer(mockExchange.address, tokenAmount);
        await mockExchange.setAmountReceived(tokenAmount);
      }

      return {
        owner, nonReceiptOwner,
        router, dodoStrategy, mockExchange,
        dodoToken, lpToken, targetToken, otherToken, parseTarget, parseOther,
        dodoPool, dodoMine,
        getLpAmountFromAmount, strategyDeposit, setReceivedAmountDuringSellReward, unbalancePool,
        getAmountFromLpAmount, getPenaltyAmount, tryToSetupZeroPenaltyForTargetToken
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
        const { owner, router, dodoStrategy, dodoToken, targetToken, lpToken, dodoPool, dodoMine } = await loadFixture(initialState);

        expect(await dodoStrategy.depositToken()).to.be.eq(targetToken.address);
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
        const { nonReceiptOwner, dodoStrategy, parseTarget } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        await expect(
          dodoStrategy.connect(nonReceiptOwner).deposit(testAmount)
        ).to.be.revertedWithCustomError(
          dodoStrategy,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("revert if the deposit amount exceeds the transferred tokens", async () => {
        const { dodoStrategy, targetToken, parseTarget } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        await targetToken.transfer(dodoStrategy.address, testAmount);

        await expect(
          dodoStrategy.deposit(MaxUint256)
        ).to.be.revertedWithCustomError(dodoStrategy, "DepositAmountExceedsBalance");

      });

      it("swap token to LP and deposit to DodoMine", async function () {
        const { dodoStrategy, targetToken, lpToken, parseTarget, dodoMine,
          getLpAmountFromAmount, strategyDeposit } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        const lpAmount = await getLpAmountFromAmount(testAmount, false);

        await strategyDeposit(testAmount);

        expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        expect(await lpToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(lpAmount);
      });

      it("do not revert when amount is 0", async function () {
        const { dodoStrategy, targetToken, parseTarget, } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        await dodoStrategy.deposit(0);
        expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        await targetToken.transfer(dodoStrategy.address, testAmount);
        await dodoStrategy.deposit(0);
        expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(testAmount);
      });
    });

    describe("#compound", function () {

      it("revert if msg.sender is not owner", async function () {
        const { nonReceiptOwner, dodoStrategy, parseTarget, strategyDeposit } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        await strategyDeposit(testAmount);

        await expect(
          dodoStrategy.connect(nonReceiptOwner).compound()
        ).to.be.revertedWithCustomError(
          dodoStrategy,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("Compound DODO reward", async function () {
        const { dodoStrategy, lpToken, dodoMine, mockExchange,
          targetToken, parseTarget, dodoToken, getLpAmountFromAmount,
          strategyDeposit, setReceivedAmountDuringSellReward } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        await strategyDeposit(testAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseTarget("100");
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
        expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

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
          targetToken, parseTarget, dodoToken, strategyDeposit, setReceivedAmountDuringSellReward,
          getLpAmountFromAmount, } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        await strategyDeposit(testAmount);

        // simulate dust
        await targetToken.transfer(dodoStrategy.address, testAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseTarget("100");
        await setReceivedAmountDuringSellReward(exchangedTokenAmount);

        await skipBlocks(10);

        const newStakedLpAmount = await getLpAmountFromAmount(
          exchangedTokenAmount.add(testAmount),
          false
        );

        // make compound
        await dodoStrategy.compound();

        // expect no dust to settle on the strategy account
        expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        // LP balance should be increased after reward restake
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
      });
    });

    describe("#withdrawAll", function () {

      it("revert if msg.sender is not owner", async function () {
        const { nonReceiptOwner, dodoStrategy, targetToken, parseTarget, strategyDeposit } = await loadFixture(initialState);

        const testAmount = parseTarget("10000");
        // 50% on strategy's USDT account
        await targetToken.transfer(dodoStrategy.address, testAmount);
        // 50% deposit

        await strategyDeposit(testAmount);

        await expect(
          dodoStrategy.connect(nonReceiptOwner).withdrawAll()
        ).to.be.revertedWithCustomError(
          dodoStrategy,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      describe("Withdraw all tokens", function () {

        it("when penalty applied", async function () {
          const { owner, dodoStrategy, targetToken, parseTarget, strategyDeposit,
            getAmountFromLpAmount, getPenaltyAmount, setReceivedAmountDuringSellReward,
            dodoMine, lpToken, dodoToken, mockExchange, unbalancePool } = await loadFixture(initialState);

          // setup conditions to get penalty on withdraw
          await unbalancePool();

          // amount that will trigger penalty
          let testAmount = parseTarget("1000000");
          // 50% on strategy's USDT account
          await targetToken.transfer(dodoStrategy.address, testAmount);
          // 50% deposit
          await strategyDeposit(testAmount);
          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseTarget("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await targetToken.balanceOf(owner.address);

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
          expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await targetToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testAmount).sub(penalty),
          );
        });

        it("without penalty", async function () {
          const { owner, dodoStrategy, targetToken, parseTarget, strategyDeposit,
            getAmountFromLpAmount, getPenaltyAmount, setReceivedAmountDuringSellReward,
            dodoMine, lpToken, dodoToken, mockExchange, tryToSetupZeroPenaltyForTargetToken } = await loadFixture(initialState);

          // amount that won't trigger penalty
          let testAmount = parseTarget("10");
          // 50% on strategy's USDT account
          await targetToken.transfer(dodoStrategy.address, testAmount);
          // 50% deposit
          await strategyDeposit(testAmount);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseTarget("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await targetToken.balanceOf(owner.address);

          await skipBlocks(10);

          const dodoRewardAmount = await dodoMine.getPendingReward(
            lpToken.address,
            dodoStrategy.address
          );

          const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

          let soldForBalance = await tryToSetupZeroPenaltyForTargetToken(stakedTokenAmount);
          let penalty = await getPenaltyAmount(stakedTokenAmount);

          expect(penalty).to.be.equal(0);

          await dodoStrategy.withdrawAll();

          // The Underlying token balance should zero
          expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await targetToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testAmount).sub(penalty).sub(soldForBalance),
          );
        });
      });
    });

    describe("#totalTokens", function () {

      it("should return correct amount of the locked and deposited tokens", async function () {

        const { dodoStrategy, targetToken, parseTarget, strategyDeposit,
          getAmountFromLpAmount, dodoMine, lpToken } = await loadFixture(initialState);

        let testAmount = parseTarget("10000");
        await strategyDeposit(testAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

        await targetToken.transfer(dodoStrategy.address, testAmount);

        const tokenBalance = await targetToken.balanceOf(dodoStrategy.address);
        const totalStrategyTokens = tokenBalance.add(stakedTokenAmount);

        expect(
          await dodoStrategy.totalTokens()
        ).to.be.equal(totalStrategyTokens);
      });
    });

    describe("#withdraw", function () {

      it("revert if msg.sender is not owner", async function () {
        const { nonReceiptOwner, dodoStrategy, parseTarget, strategyDeposit, } = await loadFixture(initialState);

        let testAmount = parseTarget("10000");
        await strategyDeposit(testAmount);

        await expect(
          dodoStrategy.connect(nonReceiptOwner).withdraw(testAmount)
        ).to.be.revertedWithCustomError(
          dodoStrategy,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("Withdraw tokens when remaining token balance is greater than withdraw amount", async function () {

        const { dodoStrategy, targetToken, lpToken, parseTarget, strategyDeposit,
          dodoMine, owner } = await loadFixture(initialState);

        let testAmount = parseTarget("10000");
        await strategyDeposit(testAmount);

        // simulate 'remaining token balance' 
        await targetToken.transfer(dodoStrategy.address, testAmount);

        const withdrawAmount = parseTarget("100");
        const currentOwnerBal = await targetToken.balanceOf(owner.address);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        await dodoStrategy.withdraw(withdrawAmount);

        // Remaining token balance on strategy should decrease
        expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(
          testAmount.sub(withdrawAmount)
        );

        // Should have same staked balance after withdraw
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(stakedLpAmount);

        // Owner should have withdrawn token
        expect(await targetToken.balanceOf(owner.address)).to.be.equal(
          currentOwnerBal.add(withdrawAmount)
        );
      });

      describe("Withdraw tokens when remaining token balance is less than withdraw amount", function () {

        it("when penalty applied", async function () {

          const { dodoStrategy, targetToken, parseTarget, strategyDeposit,
            owner, unbalancePool, getPenaltyAmount, dodoToken } = await loadFixture(initialState);

          let testAmount = parseTarget("10000");
          await strategyDeposit(testAmount);

          // setup conditions to get penalty on withdraw
          await unbalancePool();

          await targetToken.transfer(dodoStrategy.address, testAmount);

          const currentTokenBal = await targetToken.balanceOf(dodoStrategy.address);
          const extraWithdrwalAmount = parseTarget("100");
          const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

          const currentOwnerBal = await targetToken.balanceOf(owner.address);

          await skipBlocks(10);

          const penalty = await getPenaltyAmount(extraWithdrwalAmount);
          expect(penalty).to.be.greaterThan(0);

          // check return value is correct
          expect(
            await dodoStrategy.callStatic.withdraw(withdrawAmount)
          ).to.be.equal(withdrawAmount.sub(penalty));

          await dodoStrategy.withdraw(withdrawAmount);

          // The Underlying token balance should be zero
          expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // DODO token balance should zero
          expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // Owner should have all tokens.
          expect(await targetToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(withdrawAmount.sub(penalty))
          );
        });

        it("without penalty", async function () {
          const { dodoStrategy, targetToken, parseTarget, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, tryToSetupZeroPenaltyForTargetToken } = await loadFixture(initialState);

          let testAmount = parseTarget("10000");
          await strategyDeposit(testAmount);

          await targetToken.transfer(dodoStrategy.address, testAmount);

          const currentTokenBal = await targetToken.balanceOf(dodoStrategy.address);
          const extraWithdrwalAmount = parseTarget("100");
          const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

          const currentOwnerBal = await targetToken.balanceOf(owner.address);

          await skipBlocks(10);

          let soldForBalance = await tryToSetupZeroPenaltyForTargetToken(extraWithdrwalAmount);
          const penalty = await getPenaltyAmount(extraWithdrwalAmount);
          expect(penalty).to.be.equal(0);

          // check return value is correct
          expect(
            await dodoStrategy.callStatic.withdraw(withdrawAmount)
          ).to.be.equal(withdrawAmount);

          await dodoStrategy.withdraw(withdrawAmount);

          // The Underlying token balance should be zero
          expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // DODO token balance should zero
          expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // Owner should have all tokens.
          expect(await targetToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(withdrawAmount).sub(soldForBalance)
          );
        });
      });

      describe("Withdraw all tokens if requested amount is higher than total tokens", async function () {

        it("when penalty applied", async function () {
          const { dodoStrategy, targetToken, parseTarget, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, dodoMine, lpToken, unbalancePool,
            setReceivedAmountDuringSellReward, getAmountFromLpAmount, mockExchange } = await loadFixture(initialState);

          let testAmount = parseTarget("10000");
          await strategyDeposit(testAmount);

          // setup conditions to get penalty on withdraw
          await unbalancePool();

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseTarget("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await targetToken.balanceOf(owner.address);

          await skipBlocks(10);

          const dodoRewardAmount = await dodoMine.getPendingReward(
            lpToken.address,
            dodoStrategy.address
          );

          const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

          const penalty = await getPenaltyAmount(stakedTokenAmount);
          expect(penalty).to.be.greaterThan(0);

          let currentTokenBal = await dodoStrategy.totalTokens();
          let amountToWithdraw = testAmount.add(exchangedTokenAmount);
          expect(amountToWithdraw).to.be.gt(currentTokenBal)

          await dodoStrategy.withdraw(amountToWithdraw);

          // The Underlying token balance should zero
          expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await targetToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).sub(penalty)
          );
        });

        it("without penalty", async function () {
          const { dodoStrategy, targetToken, parseTarget, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, dodoMine, lpToken,
            setReceivedAmountDuringSellReward, getAmountFromLpAmount, mockExchange,
            tryToSetupZeroPenaltyForTargetToken } = await loadFixture(initialState);

          let testAmount = parseTarget("10000");
          await strategyDeposit(testAmount);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseTarget("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await targetToken.balanceOf(owner.address);

          await skipBlocks(10);

          const dodoRewardAmount = await dodoMine.getPendingReward(
            lpToken.address,
            dodoStrategy.address
          );

          const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);
          let soldForBalance = await tryToSetupZeroPenaltyForTargetToken(stakedTokenAmount);
          const penalty = await getPenaltyAmount(stakedTokenAmount);
          expect(penalty).to.be.equal(0);

          let currentTokenBal = await dodoStrategy.totalTokens();
          let amountToWithdraw = stakedTokenAmount.mul(2);
          expect(amountToWithdraw).to.be.gt(currentTokenBal)

          await dodoStrategy.withdraw(amountToWithdraw);

          // The Underlying token balance should zero
          expect(await targetToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await targetToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).sub(penalty).sub(soldForBalance)
          );
        });
      });
    });
  });
}

