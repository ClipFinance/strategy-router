const { expect } = require("chai");
const { ethers } = require("hardhat");
const { utils, BigNumber } = require("ethers");
const { setupCore, deployDodoStrategy } = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { provider, deploy, skipBlocks } = require("../utils");
const { impersonateAccount, setBalance, stopImpersonatingAccount } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther } = require("ethers/lib/utils");

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

    ({ token: usdtToken, parseToken: parseUsdt } = await getTokenContract(hre.networkVariables.usdt));
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

      // make 1st compound
      await skipBlocks(10);
      await dodoStrategy.compound();

      // expect no dust to settle on the strategy account
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
    });
  });

  describe("#withdrawAll", function () {
    beforeEach(async () => {
      // 50% on strategy's USDT account
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
      // 50% deposit
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);
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
      await setReceivedAmountDuringSellReward(exchangedTokenAmount);

      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

      const penalty = await getPenaltyAmount(stakedTokenAmount);

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
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).add(testUsdtAmount).sub(penalty),
      );
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

    it("Withdraw tokens when remaining token balance is greater than withdraw amount", async function () {

      // simulate 'remaining token balance' 
      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      const withdrawAmount = parseUsdt("100");
      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

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
        currnetOwnerBal.add(withdrawAmount)
      );
    });

    it("Withdraw tokens when remaining token balance is less than withdraw amount", async function () {

      await usdtToken.transfer(dodoStrategy.address, testUsdtAmount);

      const currentTokenBal = await usdtToken.balanceOf(dodoStrategy.address);
      const extraWithdrwalAmount = parseUsdt("100");
      const withdrawAmount = currentTokenBal.add(extraWithdrwalAmount);

      const stakedLpAmount = await dodoMine.getUserLpBalance(
        lpToken.address,
        dodoStrategy.address
      );

      const exchangedTokenAmount = parseUsdt("100");
      await setReceivedAmountDuringSellReward(exchangedTokenAmount);

      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

      await skipBlocks(10);

      const lpAmountToWithdraw = await getLpAmountFromAmount(extraWithdrwalAmount);
      let actualWithdrawAmount = await getAmountFromLpAmount(lpAmountToWithdraw);
      const penalty = await getPenaltyAmount(actualWithdrawAmount);

      actualWithdrawAmount = actualWithdrawAmount.sub(penalty);

      const compoundAmount = exchangedTokenAmount.sub(
        extraWithdrwalAmount.sub(actualWithdrawAmount)
      );

      const compoundAmountLP = await getCompoundAmountLPFromSimulation(
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
      expect(await usdtToken.balanceOf(dodoStrategy.address)).to.be.equal(0);
      // DODO token balance should zero
      expect(await dodoToken.balanceOf(dodoStrategy.address)).to.be.equal(0);

      expect(
        await dodoMine.getUserLpBalance(lpToken.address, dodoStrategy.address)
      ).to.be.equal(stakedLpAmount.sub(lpAmountToWithdraw).add(compoundAmountLP));

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
      await setReceivedAmountDuringSellReward(exchangedTokenAmount);

      const currnetOwnerBal = await usdtToken.balanceOf(owner.address);

      await skipBlocks(10);

      const dodoRewardAmount = await dodoMine.getPendingReward(
        lpToken.address,
        dodoStrategy.address
      );

      const stakedTokenAmount = await getAmountFromLpAmount(stakedLpAmount);

      const penalty = await getPenaltyAmount(stakedTokenAmount);

      await dodoStrategy.withdraw(
        testUsdtAmount.add(exchangedTokenAmount)
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
      expect(await usdtToken.balanceOf(owner.address)).to.be.equal(
        currnetOwnerBal.add(stakedTokenAmount).add(exchangedTokenAmount).sub(penalty)
      );
    });

  });


  async function getLpAmountFromAmount(amount, shouldCeil = true) {
    const expectedTarget = await dodoPool.getExpectedTarget();
    const lpSupply = await lpToken.totalSupply();
    const isQuote = !(await dodoStrategy.isBase());
    // should ceil when doing withdrawals, but not for deposit or compound 
    if(shouldCeil)
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

  const getCompoundAmountLPFromSimulation = async (lpAmountToWithdraw, tokensToWithdraw, compoundAmount) => {
    // 'withdraw' function changes the 'expectedTarget' value before reinvesting leftovers
    // so here we obtain that value off-chain by simulating part of the contract code
    let tmpSnapshot = await provider.send("evm_snapshot");
    await impersonateAccount(dodoStrategy.address);
    let signer = await ethers.getSigner(dodoStrategy.address);
    await setBalance(signer.address, parseEther("1"))

    // simulation
    await dodoMine.connect(signer).withdraw(lpToken.address, lpAmountToWithdraw);
    await dodoPool.connect(signer).withdrawQuote(tokensToWithdraw);
    const compoundAmountLP = await getLpAmountFromAmount(compoundAmount, false);

    await stopImpersonatingAccount(dodoStrategy.address);
    await provider.send("evm_revert", [tmpSnapshot]);
    return compoundAmountLP;
  }
});