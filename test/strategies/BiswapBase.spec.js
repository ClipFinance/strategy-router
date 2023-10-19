const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTwoTokensByOrder,
  setupFakeExchangePlugin,
  setupTokensLiquidityOnBiswap,
  deployBiswapStrategy,
  getPairTokenOnBiswap,
  addBiswapPoolToRewardProgram,
} = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { provider, skipBlocks, parseUniform } = require("../utils");

describe("Test BiswapBase", function () {
  let owner, nonReceiptOwner;
  // mainnet contracts
  let biswapFarm, biswapPoolId;
  // mock tokens with different decimals
  let tokenA, tokenB, bsw, lpToken;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router,
    oracle,
    exchange,
    batch,
    receiptContract,
    sharesToken,
    exchangePlugin;
  // biswap strategy
  let biswapStrategy;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  let testDepositTokenAmount;

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({
      router,
      exchange,
      oracle,
      batch,
      receiptContract,
      sharesToken,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore());

    await router.setAddresses(
      exchange.address,
      oracle.address,
      sharesToken.address,
      batch.address,
      receiptContract.address
    );

    const { token0, token1 } = await setupFakeTwoTokensByOrder(create2Deployer);
    tokenA = token0;
    tokenB = token1;

    const bswInfo = await getTokenContract(hre.networkVariables.bsw);
    bsw = bswInfo.token;

    await mintForkedToken(bsw.address, owner.address, bsw.parse("10000000"));

    biswapFarm = await getContract(
      "IBiswapFarm",
      hre.networkVariables.biswapFarm
    );

    // setup fake exchange plugin
    ({ exchangePlugin } = await setupFakeExchangePlugin(
      oracle,
      0, // X% slippage,
      5 // 0.05% dex fee
    ));

    await mintForkedToken(
      bsw.address,
      exchangePlugin.address,
      bsw.parse("10000000")
    );
    await tokenA.transfer(exchangePlugin.address, tokenA.parse("1000000"));
    await tokenB.transfer(exchangePlugin.address, tokenB.parse("1000000"));
    await oracle.setPrice(bsw.address, bsw.parse("0.1")); // 1 BSW = 0.1 USD
    await oracle.setPrice(tokenA.address, tokenA.parse("1"));
    await oracle.setPrice(tokenB.address, tokenB.parse("1"));

    let fakePlugin = exchangePlugin.address;
    await exchange.setRoute(
      [tokenA.address, tokenB.address, tokenA.address],
      [bsw.address, bsw.address, tokenB.address],
      [fakePlugin, fakePlugin, fakePlugin]
    );

    testDepositTokenAmount = tokenA.parse("10000");

    await setupTokensLiquidityOnBiswap(tokenA, tokenB, 1_000_000, 1_000_000);

    lpToken = await getPairTokenOnBiswap(tokenA, tokenB);
    biswapPoolId = await addBiswapPoolToRewardProgram(lpToken.address);
    biswapStrategy = await deployBiswapStrategy({
      router: router.address,
      poolId: biswapPoolId,
      tokenA,
      tokenB,
      lpToken: lpToken.address,
      oracle: oracle.address,
      priceManipulationPercentThresholdInBps: 2000,
      upgrader: owner.address,
      depositors: [owner.address],
      create2Deployer,
      ProxyBytecode,
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
    it("check initial values", async function () {
      expect(await biswapStrategy.tokenA()).to.be.eq(tokenA.address);
      expect(await biswapStrategy.tokenB()).to.be.eq(tokenB.address);
      expect(await biswapStrategy.lpToken()).to.be.eq(lpToken.address);
      expect(await biswapStrategy.strategyRouter()).to.be.eq(router.address);
      expect(await biswapStrategy.oracle()).to.be.eq(oracle.address);
      expect(await biswapStrategy.poolId()).to.be.eq(biswapPoolId);
      expect(await biswapStrategy.tokenA()).to.be.eq(tokenA.address);
    });

    it("should revert if oracle price treshold is invalid", async function () {
      await expect(
        deployBiswapStrategy({
          router: router.address,
          poolId: biswapPoolId,
          tokenA,
          tokenB,
          lpToken: lpToken.address,
          oracle: oracle.address,
          priceManipulationPercentThresholdInBps: 10001, // set invalid price treshold
          upgrader: owner.address,
          depositors: [owner.address],
          create2Deployer,
          ProxyBytecode,
          saltAddition: "Dummy",
        })
      ).eventually.be.rejectedWith(
        "reverted with custom error 'InvalidPriceThreshold()'"
      );
    });
  });

  describe("#deposit", function () {
    it("it reverts if msg.sender is not owner", async function () {
      await expect(
        biswapStrategy.connect(nonReceiptOwner).deposit(10)
      ).to.revertedWithCustomError(
        biswapStrategy,
        "OnlyDepositorsAllowedToDeposit"
      );
    });

    it("revert if the deposit amount exceeds the transferred tokens", async () => {
      const testAmount = tokenA.parse("10000");
      await tokenA.transfer(biswapStrategy.address, testAmount);

      await expect(
        biswapStrategy.deposit(testAmount.mul(2))
      ).to.be.revertedWithCustomError(
        biswapStrategy,
        "DepositAmountExceedsBalance"
      );
    });

    it("do not revert when amount is 0", async function () {
      const initialBalance = await tokenA.balanceOf(biswapStrategy.address);
      const testAmount = tokenA.parse("10000");
      await biswapStrategy.deposit(0);
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.equal(0);

      await tokenA.transfer(biswapStrategy.address, testAmount);
      await biswapStrategy.deposit(0);
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.equal(
        initialBalance.add(testAmount)
      );
    });

    it("should successfully deposit", async function () {
      const amountDeposit = tokenA.parse("100");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);

      await biswapStrategy.deposit(amountDeposit);

      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).not.eq("0");
      // expect that there are only leftover tokens
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenA.parse("1")
      );
      expect(await tokenB.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenB.parse("1")
      );

      // expect that total tokens were updated
      const slippageDelta = amountDeposit.mul(30).div(10000); // 0.30%
      expect(await biswapStrategy.totalTokens()).to.be.closeTo(
        amountDeposit,
        slippageDelta
      );
    });

    it("should deposit when oracle price deppegs (oracle: $1.1980)", async () => {
      await oracle.setPrice(tokenB.address, tokenB.parse("1.1980"));
      const amountDeposit = tokenA.parse("10000");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);
      await biswapStrategy.deposit(amountDeposit);

      // expect that there are only leftover tokens
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenA.parse("1")
      );
      expect(await tokenB.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenB.parse("1")
      );

      // expect that total tokens were updated
      const slippageDelta = amountDeposit.mul(30).div(10000); // 0.30%
      expect(await biswapStrategy.totalTokens()).to.be.closeTo(
        amountDeposit,
        slippageDelta
      );
    });

    it("it reverts if oracle price too higher than biswap price (oracle: $1.2020)", async function () {
      await oracle.setPrice(tokenB.address, tokenB.parse("1.2020"));

      const amountDeposit = tokenA.parse("1000");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);

      await expect(
        biswapStrategy.deposit(tokenA.parse("1000"))
      ).to.be.revertedWithCustomError(biswapStrategy, "PriceManipulation");
    });

    it("it reverts if oracle price too lower than biswap price (oracle: $0.8300)", async function () {
      // $1 / $0.83 ~= 120%
      await oracle.setPrice(tokenB.address, tokenB.parse("0.8300"));

      const amountDeposit = tokenA.parse("1000");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);

      await expect(
        biswapStrategy.deposit(tokenA.parse("1000"))
      ).to.be.revertedWithCustomError(biswapStrategy, "PriceManipulation");
    });
  });

  describe("#withdrawAll", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    beforeEach(async () => {
      _snapshot = await provider.send("evm_snapshot");
    });

    afterEach(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        biswapStrategy.connect(nonReceiptOwner).withdrawAll()
      ).to.be.revertedWithCustomError(
        biswapStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("should succesfully withdrawAll", async () => {
      const amountDeposit = tokenA.parse("100000");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);
      await biswapStrategy.deposit(amountDeposit);

      const initialOwnerBalance = await tokenA.balanceOf(owner.address);

      const totalTokens = await biswapStrategy.totalTokens();
      const amountWithdrawn = await biswapStrategy.callStatic.withdrawAll();

      // expect that the withdrawn amount of tokens is close to the total tokens
      const totalTokensSlippageDelta = totalTokens.mul(25).div(10000); // 0.025%
      expect(amountWithdrawn).to.closeTo(totalTokens, totalTokensSlippageDelta);

      // withdraw all
      await biswapStrategy.withdrawAll();

      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      // expect that there are no liquidity tokens
      expect(farmInfo.amount).to.be.equal(0);
      expect(await lpToken.balanceOf(biswapStrategy.address)).to.be.equal(0);

      // expect that there are no tokenA and tokenB balances
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.equal(0);
      expect(await tokenB.balanceOf(biswapStrategy.address)).to.be.equal(0);

      // should has zero earned bsw after withdraw
      expect(farmInfo.rewardDebt).to.be.equal(0);

      // owner should has all tokens
      const amountWithdrawnDelta = totalTokens.mul(1).div(1000000); // 0.00001%
      expect(await tokenA.balanceOf(owner.address)).to.be.closeTo(
        initialOwnerBalance.add(amountWithdrawn),
        amountWithdrawnDelta
      );
    });
  });

  describe("#compound", function () {
    beforeEach(async () => {
      await tokenA.transfer(biswapStrategy.address, testDepositTokenAmount);
      await biswapStrategy.deposit(testDepositTokenAmount);
      skipBlocks(10);
      await biswapStrategy.compound();
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        biswapStrategy.connect(nonReceiptOwner).compound()
      ).to.be.revertedWithCustomError(
        biswapStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("should succesfuly compound", async () => {
      // prepare and save states before
      const receivedAmountDuringSellReward = tokenA.parse("1000");
      await exchangePlugin.setFixedReceivedAmount(
        bsw.address,
        tokenA.address,
        receivedAmountDuringSellReward
      );

      const initialFarmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      const initialExchangeBswBalance = await bsw.balanceOf(
        exchangePlugin.address
      );
      const initialTotalTokens = await biswapStrategy.totalTokens();

      skipBlocks(10);

      const amountEarnedBsw = await biswapFarm.pendingBSW(
        biswapPoolId,
        biswapStrategy.address
      );

      await biswapStrategy.compound();

      // total tokens should be increased
      const expectedTotalTokens = initialTotalTokens.add(
        receivedAmountDuringSellReward
      );
      expect(await biswapStrategy.totalTokens()).to.be.closeTo(
        expectedTotalTokens,
        expectedTotalTokens.mul(10).div(10000) // 0.10%
      );
      // expect that the staked amount of liquidity tokens is increased
      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).to.be.gt(initialFarmInfo.amount);
      // expect that the amount of earned tokens is transferred to the exchange plugin
      expect(await bsw.balanceOf(exchangePlugin.address)).to.be.gte(
        initialExchangeBswBalance.add(amountEarnedBsw)
      );
      // expect that the earned biswap amount is zero
      expect(farmInfo.rewardDebt).to.be.gt(initialFarmInfo.rewardDebt);
      // expect that there are only leftover tokens
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenA.parse("1")
      );
      expect(await tokenB.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenB.parse("1")
      );
    });

    it("should succesfuly compound with an overweight in tokenB balance", async () => {
      // prepare and save states before
      const receivedAmountDuringSellReward = tokenA.parse("10");
      await exchangePlugin.setFixedReceivedAmount(
        bsw.address,
        tokenA.address,
        receivedAmountDuringSellReward
      );

      const initialFarmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      const initialExchangeBswBalance = await bsw.balanceOf(
        exchangePlugin.address
      );
      const initialTotalTokens = await biswapStrategy.totalTokens();

      skipBlocks(10);

      const amountEarnedBsw = await biswapFarm.pendingBSW(
        biswapPoolId,
        biswapStrategy.address
      );

      // add an overweight balance of tokenB to strategy
      const amountB = tokenB.parse("100");
      const amountA = tokenA.parse("100"); // priceAB is 1:1, need for calculate total tokens
      await tokenB.transfer(biswapStrategy.address, amountB);

      await biswapStrategy.compound();

      // total tokens should be increased
      const expectedTotalTokens = initialTotalTokens
        .add(receivedAmountDuringSellReward)
        .add(amountA);
      expect(await biswapStrategy.totalTokens()).to.be.closeTo(
        expectedTotalTokens,
        expectedTotalTokens.mul(10).div(10000) // 0.10%
      );
      // expect that the staked amount of liquidity tokens is increased
      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).to.be.gt(initialFarmInfo.amount);
      expect(farmInfo.rewardDebt).to.be.gt(initialFarmInfo.rewardDebt);
      // expect that the amount of earned tokens is transferred to the exchange plugin
      expect(await bsw.balanceOf(exchangePlugin.address)).to.be.gte(
        initialExchangeBswBalance.add(amountEarnedBsw)
      );
      // expect that there are only leftover tokens
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenA.parse("1")
      );
      expect(await tokenB.balanceOf(biswapStrategy.address)).to.be.lte(
        tokenB.parse("1")
      );
    });
  });

  describe("#withdraw", function () {
    beforeEach(async () => {
      await tokenA.transfer(biswapStrategy.address, testDepositTokenAmount);
      await biswapStrategy.deposit(testDepositTokenAmount);
      skipBlocks(10);
      await biswapStrategy.compound();
    });

    it("revert if msg.sender is not owner", async function () {
      await expect(
        biswapStrategy.connect(nonReceiptOwner).withdraw(tokenA.parse("1000"))
      ).to.be.revertedWithCustomError(
        biswapStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("should take only the remaining token balance to withdraw if it is enough to cover the withdrawal amount", async function () {
      // save states before
      const initialStrategyBalance = await tokenA.balanceOf(
        biswapStrategy.address
      );

      const withdrawAmount = tokenA.parse("100");
      await tokenA.transfer(biswapStrategy.address, withdrawAmount);

      const initialOwnerBalance = await tokenA.balanceOf(owner.address);
      const initialFarmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );

      await biswapStrategy.withdraw(withdrawAmount);

      // should has same lp staked balance after withdraw
      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).to.be.equal(initialFarmInfo.amount);

      // owner should has withdrawn deposit tokens
      expect(await tokenA.balanceOf(owner.address)).to.be.equal(
        initialOwnerBalance.add(withdrawAmount)
      );

      // deposit token balance of strategy should be zero
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.equal(
        initialStrategyBalance
      );
    });

    it("should take the staked balance to withdraw if the remaining token balance is not enough to cover the withdrawal amount", async function () {
      // prepare and save states before
      await tokenA.transfer(biswapStrategy.address, testDepositTokenAmount);
      const initialStrategyBalance = await tokenA.balanceOf(
        biswapStrategy.address
      );

      const extraWithdrawalAmount = tokenA.parse("100");
      const withdrawAmount = initialStrategyBalance.add(extraWithdrawalAmount);

      const initialOwnerBalance = await tokenA.balanceOf(owner.address);
      const initialFarmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );

      // perform withdraw
      await biswapStrategy.withdraw(withdrawAmount);

      // owner should has all deposit tokens
      const withdrawAmountDelta = withdrawAmount.mul(5).div(10000); // 0.05%
      expect(await tokenA.balanceOf(owner.address)).to.be.closeTo(
        initialOwnerBalance.add(withdrawAmount),
        withdrawAmountDelta
      );

      // should has less lp staked balance after withdraw
      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).to.be.lessThan(initialFarmInfo.amount);

      // deposit token balance of strategy should be zero
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.equal(0);
    });

    it("should reinvest exceeding amount", async function () {
      // prepare and save states before
      const receivedAmountDuringSellReward = tokenA.parse("1000");
      await exchangePlugin.setFixedReceivedAmount(
        bsw.address,
        tokenA.address,
        receivedAmountDuringSellReward
      );

      const withdrawAmount = tokenA.parse("100");

      const initialFarmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      const initialTotalTokens = await biswapStrategy.totalTokens();

      await biswapStrategy.withdraw(withdrawAmount);

      // should has same lp staked balance after withdraw
      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).to.be.greaterThan(initialFarmInfo.amount);
      // total tokens should be increased
      const expectedTotalTokens = initialTotalTokens
        .sub(withdrawAmount)
        .add(receivedAmountDuringSellReward);
      expect(await biswapStrategy.totalTokens()).to.be.closeTo(
        expectedTotalTokens,
        expectedTotalTokens.mul(10).div(10000) // 0.10%
      );
    });

    it("should withdraw all tokens if requested amount is higher than total tokens", async function () {
      // prepare and save states before
      await skipBlocks(10);
      const biswapRewardAmount = await biswapFarm.pendingBSW(
        biswapPoolId,
        biswapStrategy.address
      );

      const initialOwnerBalance = await tokenA.balanceOf(owner.address);

      const totalTokens = await biswapStrategy.totalTokens();

      // perform withdraw with 110% of total tokens
      const withdrawAmount = totalTokens.mul(110).div(100);
      await biswapStrategy.withdraw(withdrawAmount);

      // owner should has all deposit tokens added with the reward
      const withdrawAmountDelta = withdrawAmount.mul(5).div(10000); // 0.05%
      expect(await tokenA.balanceOf(owner.address)).to.be.closeTo(
        initialOwnerBalance.add(totalTokens),
        withdrawAmountDelta
      );

      // should has the dust of lp staked balance after withdraw because of compound
      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).to.be.lt(parseUniform("0.1"));

      // deposit token balance of strategy should be zero
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.equal(0);

      // should has zero earned biswap after withdraw
      expect(
        await biswapFarm.pendingBSW(biswapPoolId, biswapStrategy.address)
      ).to.be.equal(0);

      // biswap token balance of strategy should be zero
      expect(await bsw.balanceOf(biswapStrategy.address)).to.be.equal(0);

      // mock exchange plugin contract should receive THE reward amount
      expect(await bsw.balanceOf(exchangePlugin.address)).to.be.gte(
        biswapRewardAmount
      );
    });

    it("should withdraw when oracle price deppegs (oracle: $1.1990)", async () => {
      await oracle.setPrice(tokenB.address, tokenB.parse("1.1990"));
      const depositAmount = tokenA.parse("10000");
      await tokenA.transfer(biswapStrategy.address, depositAmount);
      await biswapStrategy.deposit(depositAmount);

      const amountWithdraw = tokenA.parse("1000");
      const amountWithdrawn = await biswapStrategy.callStatic.withdraw(
        amountWithdraw
      );
      expect(amountWithdrawn).to.equal(amountWithdraw);

      await biswapStrategy.withdraw(amountWithdraw);

      const slippageWithdrawn = amountWithdraw.mul(20).div(10000); // 0.02%
      expect(await tokenA.balanceOf(biswapStrategy.address)).to.be.lessThan(
        slippageWithdrawn
      );
    });

    it("it reverts if oracle price too higher than biswap price (oracle: $1.2020)", async function () {
      const amountDeposit = tokenA.parse("1000");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);
      await biswapStrategy.deposit(tokenA.parse("1000"));

      await oracle.setPrice(tokenB.address, tokenB.parse("1.2020"));

      await expect(
        biswapStrategy.withdraw(amountDeposit)
      ).to.be.revertedWithCustomError(biswapStrategy, "PriceManipulation");
    });

    it("it reverts if oracle price too lower than biswap price (oracle: $0.8300)", async function () {
      const amountDeposit = tokenA.parse("1000");
      await tokenA.transfer(biswapStrategy.address, amountDeposit);
      await biswapStrategy.deposit(tokenA.parse("1000"));

      // $1 / $0.83 ~= 120%
      await oracle.setPrice(tokenB.address, tokenB.parse("0.8300"));

      await expect(
        biswapStrategy.withdraw(amountDeposit)
      ).to.be.revertedWithCustomError(biswapStrategy, "PriceManipulation");
    });
  });
});
