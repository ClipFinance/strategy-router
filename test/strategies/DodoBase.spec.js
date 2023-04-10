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
const { loadFixture, setStorageAt, impersonateAccount, stopImpersonatingAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther } = require("ethers/lib/utils");

const { usdt, busd, dodoBusdUsdtPool, dodoUsdtLp, dodoBusdLp, dodoMine } = hre.networkVariables;
testSuite(usdt, busd, dodoBusdUsdtPool, dodoMine, dodoUsdtLp, "USDT");
testSuite(busd, usdt, dodoBusdUsdtPool, dodoMine, dodoBusdLp, "BUSD");

function testSuite(depositTokenAddress, counterTokenAddress, poolAddress, dodoMineAddress, LPTokenAddress, depositTokenName) {
  describe(`Test DodoBase: depositToken = ${depositTokenName}`, function () {

    async function initialState() {

      const [owner, nonReceiptOwner] = await ethers.getSigners();

      const mockExchange = await deploy("MockExchange");
      const router = await smock.fake("StrategyRouter");
      router.getExchange.returns(mockExchange.address);

      const { token: depositToken, parseToken: parseDepositToken } = await getTokenContract(depositTokenAddress);
      const { token: counterToken, parseToken: parseCounterToken } = await getTokenContract(counterTokenAddress);
      const { token: dodoToken, parseToken: parseDodo } = await getTokenContract(hre.networkVariables.dodo);

      const lpToken = (await getTokenContract(LPTokenAddress)).token;

      await mintForkedToken(
        dodoToken.address,
        owner.address,
        parseDodo("10000000000")
      );
      await mintForkedToken(
        depositToken.address,
        owner.address,
        parseDepositToken("10000000000")
      );
      await mintForkedToken(
        counterToken.address,
        owner.address,
        parseCounterToken("10000000000")
      );

      const dodoMine = await getContract("IDodoMine", dodoMineAddress);
      const dodoPool = await getContract("IDodoSingleAssetPool", poolAddress);

      const dodoStrategy = await deployDodoStrategy({
        router: router.address,
        token: depositToken,
        lpToken: lpToken.address,
        dodoToken: dodoToken.address,
        pool: dodoPool.address,
        farm: dodoMine.address,
        upgrader: owner.address,
      });
      const isBase = await dodoStrategy.isBase();

      async function turnonWithdrawalPenaltyOnPool() {
        // sell counterToken to unbalance pool
        await counterToken.approve(dodoPool.address, MaxUint256);
        async function trade() {
          if (isBase)
            await dodoPool.buyBaseToken(parseCounterToken("300000"), MaxUint256, []);
          else
            await dodoPool.sellBaseToken(parseCounterToken("300000"), 0, []);
        }
        for (let i = 0; i < 15; i++) {
          const tradeAmount = parseDepositToken("1000000");
          const penalty = await getPenaltyAmount(tradeAmount);
          if(penalty > 0) return;
          await trade();
        }
        throw new Error("Was unable to set non zero penalty!");
      }

      async function setZeroWithdrawalPenaltyOnPool() {
        const slot = 0xE; // _R_STATUS_
        await setStorageAt(dodoPool.address, slot, 0x0); // we want "ONE" from "Types {ONE, BELOW, ABOVE}"
      }

      async function strategyDeposit(amount) {
        await depositToken.transfer(dodoStrategy.address, amount);
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
        await depositToken.transfer(mockExchange.address, tokenAmount);
        await mockExchange.setAmountReceived(tokenAmount);
      }
      const getAmountInLPAtFutureLPPrice = async (lpAmountToWithdraw, tokensToWithdraw, compoundAmount) => {
        // 'withdraw' function changes the 'expectedTarget' value before reinvesting leftovers
        // so here we obtain that value off-chain by simulating part of the contract code
        let tmpSnapshot = await provider.send("evm_snapshot");
        await impersonateAccount(dodoStrategy.address);
        let signer = await ethers.getSigner(dodoStrategy.address);
        await setBalance(signer.address, parseEther("1"))

        // simulation
        await dodoMine.connect(signer).withdraw(lpToken.address, lpAmountToWithdraw);
        if(isBase)
          await dodoPool.connect(signer).withdrawBase(tokensToWithdraw);
        else
          await dodoPool.connect(signer).withdrawQuote(tokensToWithdraw);
        const compoundAmountLP = await getLpAmountFromAmount(compoundAmount, false);

        await stopImpersonatingAccount(dodoStrategy.address);
        await provider.send("evm_revert", [tmpSnapshot]);
        return compoundAmountLP;
      }

      return {
        owner, nonReceiptOwner,
        router, dodoStrategy, mockExchange,
        dodoToken, lpToken, depositToken, counterToken, parseDepositToken, parseCounterToken,
        dodoPool, dodoMine,
        getLpAmountFromAmount, strategyDeposit, setReceivedAmountDuringSellReward, turnonWithdrawalPenaltyOnPool,
        getAmountFromLpAmount, getPenaltyAmount, setZeroWithdrawalPenaltyOnPool, getAmountInLPAtFutureLPPrice
      };
    }

    async function initialStateWithPenalty() {
      let state = await loadFixture(initialState);
      const { turnonWithdrawalPenaltyOnPool } = state;
      await turnonWithdrawalPenaltyOnPool();
      return state;
    }

    describe("constructor & initialize", function () {
      it("revert if deposit token is invalid", async function () {
        const { owner, router, dodoToken, lpToken, dodoPool, dodoMine, } = await loadFixture(initialState);
        await expect(deployDodoStrategy({
          router: router.address,
          token: lpToken, // set invalid deposit token
          lpToken: lpToken.address,
          dodoToken: dodoToken.address,
          pool: dodoPool.address,
          farm: dodoMine.address,
          upgrader: owner.address,
        })).to.be.rejectedWith("reverted with custom error 'InvalidInput()'");
      });

      it("check initial values", async function () {
        const { owner, router, dodoStrategy, dodoToken, depositToken, lpToken, dodoPool, dodoMine } = await loadFixture(initialState);

        expect(await dodoStrategy.depositToken()).to.be.eq(depositToken.address);
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
        const { nonReceiptOwner, dodoStrategy, parseDepositToken } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        await expect(
          dodoStrategy.connect(nonReceiptOwner).deposit(testAmount)
        ).to.be.revertedWithCustomError(
          dodoStrategy,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("revert if the deposit amount exceeds the transferred tokens", async () => {
        const { dodoStrategy, depositToken, parseDepositToken } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        await depositToken.transfer(dodoStrategy.address, testAmount);

        await expect(
          dodoStrategy.deposit(testAmount.add(parseDepositToken("10000")))
        ).to.be.revertedWithCustomError(dodoStrategy, "DepositAmountExceedsBalance");

      });

      it("swap token to LP and deposit to DodoMine", async function () {
        const { dodoStrategy, depositToken, lpToken, parseDepositToken, dodoMine,
          getLpAmountFromAmount, strategyDeposit } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        const lpAmount = await getLpAmountFromAmount(testAmount, false);

        await strategyDeposit(testAmount);

        expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        expect(await lpToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(lpAmount);
      });

      it("do not revert when amount is 0", async function () {
        const { dodoStrategy, depositToken, parseDepositToken, } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        await dodoStrategy.deposit(0);
        expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        await depositToken.transfer(dodoStrategy.address, testAmount);
        await dodoStrategy.deposit(0);
        expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(testAmount);
      });
    });

    describe("#compound", function () {

      it("revert if msg.sender is not owner", async function () {
        const { nonReceiptOwner, dodoStrategy, parseDepositToken, strategyDeposit } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
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
          depositToken, parseDepositToken, dodoToken, getLpAmountFromAmount,
          strategyDeposit, setReceivedAmountDuringSellReward } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        await strategyDeposit(testAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseDepositToken("100");
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
        expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

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
        const { dodoStrategy, lpToken, dodoMine,
          depositToken, parseDepositToken, strategyDeposit, setReceivedAmountDuringSellReward,
          getLpAmountFromAmount, } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        await strategyDeposit(testAmount);

        // simulate dust
        await depositToken.transfer(dodoStrategy.address, testAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const exchangedTokenAmount = parseDepositToken("100");
        await setReceivedAmountDuringSellReward(exchangedTokenAmount);

        await skipBlocks(10);

        const newStakedLpAmount = await getLpAmountFromAmount(
          exchangedTokenAmount.add(testAmount),
          false
        );

        // make compound
        await dodoStrategy.compound();

        // expect no dust to settle on the strategy account
        expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

        // LP balance should be increased after reward restake
        expect(
          await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
        ).to.be.equal(stakedLpAmount.add(newStakedLpAmount));
      });
    });

    describe("#withdrawAll", function () {

      it("revert if msg.sender is not owner", async function () {
        const { nonReceiptOwner, dodoStrategy, depositToken, parseDepositToken, strategyDeposit } = await loadFixture(initialState);

        const testAmount = parseDepositToken("10000");
        // 50% on strategy's account
        await depositToken.transfer(dodoStrategy.address, testAmount);
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
          const { owner, dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            getAmountFromLpAmount, getPenaltyAmount, setReceivedAmountDuringSellReward,
            dodoMine, lpToken, dodoToken, mockExchange } = await loadFixture(initialStateWithPenalty);

          // amount that will trigger penalty
          let testAmount = parseDepositToken("1000000");
          // 50% on strategy's account
          await depositToken.transfer(dodoStrategy.address, testAmount);
          // 50% deposit
          await strategyDeposit(testAmount);
          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseDepositToken("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await depositToken.balanceOf(owner.address);

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
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testAmount).sub(penalty),
          );
        });

        it("without penalty", async function () {
          const { owner, dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            getAmountFromLpAmount, getPenaltyAmount, setReceivedAmountDuringSellReward,
            dodoMine, lpToken, dodoToken, mockExchange, setZeroWithdrawalPenaltyOnPool } = await loadFixture(initialState);

          // amount that won't trigger penalty
          let testAmount = parseDepositToken("10");
          // 50% on strategy's account
          await depositToken.transfer(dodoStrategy.address, testAmount);
          // 50% deposit
          await strategyDeposit(testAmount);
          await setZeroWithdrawalPenaltyOnPool();

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseDepositToken("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);

          const dodoRewardAmount = await dodoMine.getPendingReward(
            lpToken.address,
            dodoStrategy.address
          );

          const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

          let penalty = await getPenaltyAmount(stakedTokenAmount);

          expect(penalty).to.be.equal(0);

          await dodoStrategy.withdrawAll();

          // The Underlying token balance should zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testAmount).sub(penalty),
          );
        });
      });
    });

    describe("#totalTokens", function () {

      it("should return correct amount of the locked and deposited tokens", async function () {

        const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
          getAmountFromLpAmount, dodoMine, lpToken } = await loadFixture(initialState);

        let testAmount = parseDepositToken("10000");
        await strategyDeposit(testAmount);

        const stakedLpAmount = await dodoMine.getUserLpBalance(
          lpToken.address,
          dodoStrategy.address
        );

        const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

        await depositToken.transfer(dodoStrategy.address, testAmount);

        const tokenBalance = await depositToken.balanceOf(dodoStrategy.address);
        const totalStrategyTokens = tokenBalance.add(stakedTokenAmount);

        expect(
          await dodoStrategy.totalTokens()
        ).to.be.equal(totalStrategyTokens);
      });
    });

    describe("#withdraw", function () {

      it("revert if msg.sender is not owner", async function () {
        const { nonReceiptOwner, dodoStrategy, parseDepositToken, strategyDeposit, } = await loadFixture(initialState);

        let testAmount = parseDepositToken("10000");
        await strategyDeposit(testAmount);

        await expect(
          dodoStrategy.connect(nonReceiptOwner).withdraw(testAmount)
        ).to.be.revertedWithCustomError(
          dodoStrategy,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      describe("Withdraw tokens when remaining token balance is greater than withdraw amount", function () {

        it("when penalty applied", async function () {

          const { owner, dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            getPenaltyAmount, dodoMine, lpToken } = await loadFixture(initialStateWithPenalty);

          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);

          // simulate 'remaining token balance' 
          await depositToken.transfer(dodoStrategy.address, testAmount);

          const withdrawAmount = parseDepositToken("100");
          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          // check that penalty exists
          const penalty = await getPenaltyAmount(withdrawAmount);
          expect(penalty).to.be.greaterThan(0);

          await dodoStrategy.withdraw(withdrawAmount);

          // Remaining token balance on strategy should decrease
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(
            testAmount.sub(withdrawAmount)
          );

          // Should have same staked balance after withdraw
          expect(
            await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
          ).to.be.equal(stakedLpAmount);

          // Owner should have withdrawn token
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(withdrawAmount)
          );
        });

        it("without penalty", async function () {

          const { owner, dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            dodoMine, lpToken, setZeroWithdrawalPenaltyOnPool, getPenaltyAmount } = await loadFixture(initialState);

          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);
          await setZeroWithdrawalPenaltyOnPool();

          // simulate 'remaining token balance' 
          await depositToken.transfer(dodoStrategy.address, testAmount);

          const withdrawAmount = parseDepositToken("100");
          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          // check that there is no penalty 
          const penalty = await getPenaltyAmount(withdrawAmount);
          expect(penalty).to.be.equal(0);

          await dodoStrategy.withdraw(withdrawAmount);

          // Remaining token balance on strategy should decrease
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(
            testAmount.sub(withdrawAmount)
          );

          // Should have same staked balance after withdraw
          expect(
            await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
          ).to.be.equal(stakedLpAmount);

          // Owner should have withdrawn token
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(withdrawAmount)
          );
        });
      });

      describe("Withdraw tokens when remaining token balance is less than withdraw amount", function () {

        it("when penalty applied", async function () {

          const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            owner, getPenaltyAmount, dodoToken } = await loadFixture(initialStateWithPenalty);

          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);

          await depositToken.transfer(dodoStrategy.address, testAmount);

          const currentTokenBal = await depositToken.balanceOf(dodoStrategy.address);
          const extraWithdrwalAmount = parseDepositToken("100");
          const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);

          const penalty = await getPenaltyAmount(extraWithdrwalAmount);
          expect(penalty).to.be.greaterThan(0);

          // check return value is correct
          expect(
            await dodoStrategy.callStatic.withdraw(withdrawAmount)
          ).to.be.equal(withdrawAmount.sub(penalty));

          await dodoStrategy.withdraw(withdrawAmount);

          // The Underlying token balance should be zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // DODO token balance should zero
          expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // Owner should have all tokens.
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(withdrawAmount.sub(penalty))
          );
        });

        it("without penalty", async function () {
          const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, setZeroWithdrawalPenaltyOnPool } = await loadFixture(initialState);

          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);
          await setZeroWithdrawalPenaltyOnPool();

          await depositToken.transfer(dodoStrategy.address, testAmount);

          const currentTokenBal = await depositToken.balanceOf(dodoStrategy.address);
          const extraWithdrwalAmount = parseDepositToken("100");
          const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);

          const penalty = await getPenaltyAmount(extraWithdrwalAmount);
          expect(penalty).to.be.equal(0);

          // check return value is correct
          expect(
            await dodoStrategy.callStatic.withdraw(withdrawAmount)
          ).to.be.equal(withdrawAmount);

          await dodoStrategy.withdraw(withdrawAmount);

          // The Underlying token balance should be zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // DODO token balance should zero
          expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // Owner should have all tokens.
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(withdrawAmount)
          );
        });
      });

      describe("Withdraw all tokens if requested amount is higher than total tokens", async function () {

        it("when penalty applied", async function () {
          const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, dodoMine, lpToken,
            setReceivedAmountDuringSellReward, getAmountFromLpAmount, mockExchange } = await loadFixture(initialStateWithPenalty);

          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseDepositToken("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);

          const dodoRewardAmount = await dodoMine.getPendingReward(
            lpToken.address,
            dodoStrategy.address
          );

          const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

          const penalty = await getPenaltyAmount(stakedTokenAmount);
          expect(penalty).to.be.greaterThan(0);

          let extraAmount = parseDepositToken("10000");
          let allAvailableBalance = testAmount.add(exchangedTokenAmount);
          let amountToWithdraw = allAvailableBalance.add(extraAmount);

          await dodoStrategy.withdraw(amountToWithdraw);

          // The Underlying token balance should zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).sub(penalty)
          );
        });

        it("without penalty", async function () {
          const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, dodoMine, lpToken,
            setReceivedAmountDuringSellReward, getAmountFromLpAmount, mockExchange,
            setZeroWithdrawalPenaltyOnPool } = await loadFixture(initialState);


          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);
          await setZeroWithdrawalPenaltyOnPool();

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseDepositToken("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currentOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);

          const dodoRewardAmount = await dodoMine.getPendingReward(
            lpToken.address,
            dodoStrategy.address
          );

          const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);
          const penalty = await getPenaltyAmount(stakedTokenAmount);
          expect(penalty).to.be.equal(0);

          let extraAmount = parseDepositToken("10000");
          let allAvailableBalance = testAmount.add(exchangedTokenAmount);
          let amountToWithdraw = allAvailableBalance.add(extraAmount);

          await dodoStrategy.withdraw(amountToWithdraw);

          // The Underlying token balance should zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
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
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currentOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount)
          );
        });
      });

      describe("should reinvest exceeding amount", function () {
        it("without penalty", async function () {

          const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, dodoMine, lpToken,
            setReceivedAmountDuringSellReward, getLpAmountFromAmount, 
            setZeroWithdrawalPenaltyOnPool, getAmountInLPAtFutureLPPrice } = await loadFixture(initialState);


          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);

          await depositToken.transfer(dodoStrategy.address, testAmount);

          const currentTokenBal = await depositToken.balanceOf(dodoStrategy.address);
          const extraWithdrwalAmount = parseDepositToken("100");
          const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseDepositToken("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currnetOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);
          await setZeroWithdrawalPenaltyOnPool();

          const lpAmountToWithdraw = await getLpAmountFromAmount(extraWithdrwalAmount);

          const penalty = await getPenaltyAmount(extraWithdrwalAmount);
          expect(penalty).to.be.equal(0);

          let actualWithdrawAmount = extraWithdrwalAmount.sub(penalty);

          const compoundAmount = exchangedTokenAmount.sub(
            extraWithdrwalAmount.sub(actualWithdrawAmount)
          );

          const compoundAmountLP = await getAmountInLPAtFutureLPPrice(
            lpAmountToWithdraw,
            actualWithdrawAmount,
            compoundAmount
          );

          // check return value is correct
          expect(
            await dodoStrategy.callStatic.withdraw(withdrawAmount)
          ).to.be.equal(withdrawAmount);

          await dodoStrategy.withdraw(withdrawAmount);

          // The Underlying token balance should be zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // DODO token balance should zero
          expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

          // correct amount of LP tokens after withdraw & reinvest 
          expect(
            await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
          ).to.be.equal(stakedLpAmount.sub(lpAmountToWithdraw).add(compoundAmountLP));

          // Owner should have all tokens.
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currnetOwnerBal.add(withdrawAmount)
          );
        });

        it("when penalty applied", async function () {

          const { dodoStrategy, depositToken, parseDepositToken, strategyDeposit,
            owner, getPenaltyAmount, dodoToken, dodoMine, lpToken,
            setReceivedAmountDuringSellReward, getAmountInLPAtFutureLPPrice, getLpAmountFromAmount } = await loadFixture(initialStateWithPenalty);

          let testAmount = parseDepositToken("10000");
          await strategyDeposit(testAmount);

          await depositToken.transfer(dodoStrategy.address, testAmount);

          const currentTokenBal = await depositToken.balanceOf(dodoStrategy.address);
          const extraWithdrwalAmount = parseDepositToken("100");
          const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

          const stakedLpAmount = await dodoMine.getUserLpBalance(
            lpToken.address,
            dodoStrategy.address
          );

          const exchangedTokenAmount = parseDepositToken("100");
          await setReceivedAmountDuringSellReward(exchangedTokenAmount);

          const currnetOwnerBal = await depositToken.balanceOf(owner.address);

          await skipBlocks(10);

          const lpAmountToWithdraw = await getLpAmountFromAmount(extraWithdrwalAmount);

          const penalty = await getPenaltyAmount(extraWithdrwalAmount);
          expect(penalty).to.be.greaterThan(0);

          let actualWithdrawAmount = extraWithdrwalAmount.sub(penalty);

          const compoundAmount = exchangedTokenAmount.sub(
            extraWithdrwalAmount.sub(actualWithdrawAmount)
          );

          const compoundAmountLP = await getAmountInLPAtFutureLPPrice(
            lpAmountToWithdraw,
            actualWithdrawAmount.add(penalty),
            compoundAmount
          );

          // check return value is correct
          expect(
            await dodoStrategy.callStatic.withdraw(withdrawAmount)
          ).to.be.equal(withdrawAmount);

          await dodoStrategy.withdraw(withdrawAmount);

          // The Underlying token balance should be zero
          expect(await depositToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
          // DODO token balance should zero
          expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

          // correct amount of LP tokens after withdraw & reinvest 
          expect(
            await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
          ).to.be.equal(stakedLpAmount.sub(lpAmountToWithdraw).add(compoundAmountLP));

          // Owner should have all tokens.
          expect(await depositToken.balanceOf(owner.address)).to.be.equal(
            currnetOwnerBal.add(withdrawAmount)
          );
        });
      });
    });
  });
}

