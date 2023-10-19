const { expect } = require("chai");
const { formatUnits, parseEther, parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupRouterParams,
  setupTestParams,
  setupFakeExchangePlugin,
  setupTokens,
} = require("../shared/commonSetup");
const { mintForkedToken, getTokenContract } = require("../shared/forkHelper");
const {
  provider,
  deployStrategy,
  skipBlocks,
  parseUniform,
} = require("../utils");

const {
  usdt,
  usdc,
  hay,
  the,
  busd,
  thenaGaugeUsdtUsdc,
  thenaGaugeHayUsdt,
  hypervisorUsdtUsdc,
  hypervisorHayUsdt,
  gammaUniProxy: gammaUniProxyAddress,
} = hre.networkVariables;
// testSuite(hay, usdt, the, thenaGaugeHayUsdt, hypervisorHayUsdt, "ThenaHay"); // need to fix max deposit token amounts and ratio
// testSuite(usdt, hay, the, thenaGaugeHayUsdt, hypervisorHayUsdt, "ThenaUsdtHay");
// testSuite(usdt, usdc, the, thenaGaugeUsdtUsdc, hypervisorUsdtUsdc, "ThenaUsdt");
// testSuite(usdc, usdt, the, thenaGaugeUsdtUsdc, hypervisorUsdtUsdc, "ThenaUsdc");

function testSuite(
  depositTokenAddress,
  counterTokenAddress,
  thenaTokenAddress,
  farmAddress,
  lpTokenAddress,
  StrategyContractName
) {
  describe(`Test ${StrategyContractName} strategy`, function () {
    let owner, alice;
    // create2 deploy data
    let create2Deployer, ProxyBytecode;
    // core contracts
    let router, oracle, exchange, dexFee, exchangePlugin;
    let priceManipulationPercentThresholdInBps;
    // revert to test-ready state
    let snapshotId;
    // revert to fresh fork state
    let initialSnapshot;

    let thenaStrategyContract, lpTokenContract, farm;

    let depositToken, parseDepositToken;
    let counterToken, parseCounterToken;
    let theToken, parseThe;

    let testDepositTokenAmount;

    before(async function () {
      [owner, alice] = await ethers.getSigners();
      initialSnapshot = await provider.send("evm_snapshot");

      // deploy core contracts
      ({ router, oracle, exchange, admin, create2Deployer, ProxyBytecode } =
        await setupCore());

      ({ token: depositToken, parseToken: parseDepositToken } =
        await getTokenContract(depositTokenAddress));
      ({ token: counterToken, parseToken: parseCounterToken } =
        await getTokenContract(counterTokenAddress));
      ({ token: theToken, parseToken: parseThe } = await getTokenContract(
        thenaTokenAddress
      ));

      // setup fake exchange plugin
      dexFee = 5; // 0.05%
      ({ exchangePlugin } = await setupFakeExchangePlugin(
        oracle,
        0, // X% slippage,
        dexFee
      ));

      await mintForkedToken(
        theToken.address,
        exchangePlugin.address,
        parseThe("10000000")
      );
      await oracle.setPrice(theToken.address, parseThe("0.255")); // 1 THE = 0.255 USD

      // get tokens on bnb chain for testing
      const tokens = await setupTokens();
      const { usdt, busd, usdc } = tokens;

      // setup params for testing
      await setupTestParams(
        router,
        oracle,
        exchange,
        admin,
        usdc,
        usdt,
        busd,
        exchangePlugin
      );

      // set oracle prices
      await oracle.setPrice(depositToken.address, parseDepositToken("1"));
      await oracle.setPrice(counterToken.address, parseCounterToken("1"));

      // deploy strategy
      priceManipulationPercentThresholdInBps = 2000; // 20%
      farm = await ethers.getContractAt("IThenaGaugeV2", farmAddress);
      thenaStrategyContract = await deployStrategy(
        StrategyContractName,
        [owner.address, parseDepositToken("1000000"), 500, [owner.address]],
        [
          router.address,
          oracle.address,
          priceManipulationPercentThresholdInBps,
        ],
        create2Deployer,
        ProxyBytecode
      );

      lpTokenContract = await ethers.getContractAt(
        "IThenaHypervisor",
        lpTokenAddress
      );

      testDepositTokenAmount = parseDepositToken("10000");
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
        await expect(
          deployStrategy(
            "ThenaGammaStableBase",
            [owner.address, parseDepositToken("1000000"), 500],
            [
              router.address,
              depositToken.address,
              busd, // invalid counter token
              lpTokenAddress,
              gammaUniProxyAddress,
              farm.address,
              theToken.address,
              oracle.address,
              priceManipulationPercentThresholdInBps,
            ],
            create2Deployer,
            ProxyBytecode,
            "Dummy1"
          )
        ).to.be.revertedWithCustomError(thenaStrategyContract, "InvalidInput");

        await expect(
          deployStrategy(
            "ThenaGammaStableBase",
            [owner.address, parseDepositToken("1000000"), 500],
            [
              router.address,
              busd, // invalid deposit token
              counterToken.address,
              lpTokenAddress,
              gammaUniProxyAddress,
              farm.address,
              theToken.address,
              oracle.address,
              priceManipulationPercentThresholdInBps,
            ],
            create2Deployer,
            ProxyBytecode,
            "Dummy2"
          )
        ).to.be.revertedWithCustomError(thenaStrategyContract, "InvalidInput");
      });

      it("check initial values", async function () {
        expect(await thenaStrategyContract.owner()).to.be.eq(owner.address);

        expect(await thenaStrategyContract.depositToken()).to.be.eq(
          depositToken.address
        );
        expect(await thenaStrategyContract.tokenA()).to.be.eq(
          depositToken.address
        );
        expect(await thenaStrategyContract.tokenB()).to.be.eq(
          counterToken.address
        );

        expect(await thenaStrategyContract.strategyRouter()).to.be.eq(
          router.address
        );
        expect(await thenaStrategyContract.lpToken()).to.be.eq(lpTokenAddress);
        expect(await thenaStrategyContract.lpManager()).to.be.eq(
          gammaUniProxyAddress
        );
        expect(await thenaStrategyContract.farm()).to.be.eq(farm.address);
        expect(await thenaStrategyContract.the()).to.be.eq(theToken.address);
        expect(await thenaStrategyContract.oracle()).to.be.eq(oracle.address);
      });
    });

    describe("#deposit", function () {
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
          thenaStrategyContract
            .connect(alice)
            .deposit(parseDepositToken("1000"))
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "OnlyDepositorsAllowedToDeposit"
        );
      });

      it("revert if deposit amount exceeds deposit max", async function () {
        // max deposit token amounts are 75_000 and we will use 500_000 to check this case,
        // because it separates into 2 parts depending on the total tokens ratio
        // also they has decreased amounts 250_000 to 75_000 after my first implementation
        const amountDeposit = parseDepositToken("100000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          amountDeposit
        );

        // check the total amounts of tokens to understand which token will be exceeded
        const [total0, total1] = await lpTokenContract.getTotalAmounts();
        const revertedString = total0.gt(total1)
          ? "token0 exceeds"
          : "token1 exceeds";

        await expect(
          thenaStrategyContract.deposit(amountDeposit)
        ).to.be.revertedWith(revertedString);
      });

      it("revert if deposit amount exceeds balance", async function () {
        await depositToken.transfer(
          thenaStrategyContract.address,
          parseDepositToken("1000")
        );

        await expect(
          thenaStrategyContract.deposit(parseDepositToken("1001"))
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "DepositAmountExceedsBalance"
        );
      });

      it("do not revert when the amount is 0", async function () {
        await thenaStrategyContract.deposit(0);

        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);
      });

      it("should successfully deposit", async () => {
        const amountDeposit = parseDepositToken("1000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          amountDeposit
        );
        await thenaStrategyContract.deposit(amountDeposit);

        // expect that liquidity tokens were staked
        expect(await farm.balanceOf(thenaStrategyContract.address)).to.be.gt(0);

        // expect that deposit tokens were transferred to strategy
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.eq(0);

        // expect that total tokens were updated
        const slippageDelta = amountDeposit.mul(30).div(10000); // 0.30%
        expect(await thenaStrategyContract.totalTokens()).to.be.closeTo(
          amountDeposit,
          slippageDelta
        );
      });

      it("should withdraw when oracle price deppegs (oracle: $1.1990)", async () => {
        await oracle.setPrice(
          counterToken.address,
          parseCounterToken("1.1990")
        );
        const depositAmount = parseDepositToken("10000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          depositAmount
        );
        await thenaStrategyContract.deposit(depositAmount);

        const amountWithdraw = parseDepositToken("1000");
        const amountWithdrawn = await thenaStrategyContract.callStatic.withdraw(
          amountWithdraw
        );
        expect(amountWithdrawn).to.equal(amountWithdraw);

        await thenaStrategyContract.withdraw(amountWithdraw);

        const slippageWithdrawn = amountWithdraw.mul(20).div(10000); // 0.02%
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.lessThan(slippageWithdrawn);
      });

      it("it reverts if oracle price too higher than thena price (oracle: $1.2010)", async function () {
        await oracle.setPrice(
          counterToken.address,
          parseCounterToken("1.2010")
        );

        const amountDeposit = parseDepositToken("1000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          amountDeposit
        );

        await expect(
          thenaStrategyContract.deposit(parseDepositToken("1000"))
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "PriceManipulation"
        );
      });

      it("it reverts if oracle price too lower than thena price (oracle: $0.8300)", async function () {
        // $1 / $0.83 ~= 120%
        await oracle.setPrice(
          counterToken.address,
          parseCounterToken("0.8300")
        );

        const amountDeposit = parseDepositToken("1000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          amountDeposit
        );

        await expect(
          thenaStrategyContract.deposit(parseDepositToken("1000"))
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "PriceManipulation"
        );
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
          thenaStrategyContract.connect(alice).withdrawAll()
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("revert if nothing to withdraw", async function () {
        await expect(thenaStrategyContract.withdrawAll()).to.be.revertedWith(
          "Cannot withdraw 0"
        );
      });

      it("should succesfully withdrawAll", async () => {
        const depositAmount = parseDepositToken("100000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          depositAmount
        );
        await thenaStrategyContract.deposit(depositAmount);

        const initialOwnerBalance = await depositToken.balanceOf(owner.address);

        const totalTokens = await thenaStrategyContract.totalTokens();
        const amountWithdrawn =
          await thenaStrategyContract.callStatic.withdrawAll();

        // expect that the withdrawn amount of tokens is close to the total tokens
        const totalTokensSlippageDelta = totalTokens.mul(25).div(10000); // 0.025%
        expect(amountWithdrawn).to.closeTo(
          totalTokens,
          totalTokensSlippageDelta
        );

        // withdraw all
        await thenaStrategyContract.withdrawAll();

        // expect that there are no liquidity tokens
        expect(await farm.balanceOf(thenaStrategyContract.address)).to.be.equal(
          0
        );
        expect(
          await lpTokenContract.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);

        // expect that there are no deposit tokens and counter tokens
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);
        expect(
          await counterToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);

        // should has zero earned thena after withdraw
        expect(await farm.earned(thenaStrategyContract.address)).to.be.equal(0);

        // owner should has all tokens
        const amountWithdrawnDelta = totalTokens.mul(1).div(1000000); // 0.00001%
        expect(await depositToken.balanceOf(owner.address)).to.be.closeTo(
          initialOwnerBalance.add(amountWithdrawn),
          amountWithdrawnDelta
        );
      });
    });

    describe("#compound", function () {
      beforeEach(async () => {
        await thenaStrategyContract.compound();
        await depositToken.transfer(
          thenaStrategyContract.address,
          testDepositTokenAmount
        );
        await thenaStrategyContract.deposit(testDepositTokenAmount);
      });

      it("revert if msg.sender is not owner", async function () {
        await expect(
          thenaStrategyContract.connect(alice).compound()
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("should succesfuly compound", async () => {
        // prepare and save states before
        const receivedAmountDuringSellReward = parseDepositToken("1000");
        await exchangePlugin.setFixedReceivedAmount(
          theToken.address,
          depositToken.address,
          receivedAmountDuringSellReward
        );

        const initialStakedLpAmount = await farm.balanceOf(
          thenaStrategyContract.address
        );
        const initialExchangeThenaBalance = await theToken.balanceOf(
          exchangePlugin.address
        );
        const initialTotalTokens = await thenaStrategyContract.totalTokens();

        skipBlocks(10);

        const amountEarnedThena = await farm.earned(
          thenaStrategyContract.address
        );

        await thenaStrategyContract.compound();

        // total tokens should be increased
        const expectedTotalTokens = initialTotalTokens.add(
          receivedAmountDuringSellReward
        );
        expect(await thenaStrategyContract.totalTokens()).to.be.closeTo(
          expectedTotalTokens,
          expectedTotalTokens.mul(10).div(10000) // 0.10%
        );
        // expect that the staked amount of liquidity tokens is increased
        expect(await farm.balanceOf(thenaStrategyContract.address)).to.be.gt(
          initialStakedLpAmount
        );
        // expect that the amount of earned tokens is transferred to the exchange plugin
        expect(await theToken.balanceOf(exchangePlugin.address)).to.be.gte(
          initialExchangeThenaBalance.add(amountEarnedThena)
        );
        // expect that the earned thena amount is zero
        expect(await farm.earned(thenaStrategyContract.address)).to.be.equal(0);
      });

      it("should succesfuly compound with an overweight in tokenB balance", async () => {
        // prepare and save states before
        const receivedAmountDuringSellReward = parseDepositToken("10");
        await exchangePlugin.setFixedReceivedAmount(
          theToken.address,
          depositToken.address,
          receivedAmountDuringSellReward
        );

        const initialStakedLpAmount = await farm.balanceOf(
          thenaStrategyContract.address
        );
        const initialExchangeThenaBalance = await theToken.balanceOf(
          exchangePlugin.address
        );
        const initialTotalTokens = await thenaStrategyContract.totalTokens();

        skipBlocks(10);

        const amountEarnedThena = await farm.earned(
          thenaStrategyContract.address
        );

        // add an overweight balance of tokenB to strategy
        const amountB = parseCounterToken("100");
        const amountA = parseDepositToken("100"); // priceAB is 1:1, need for calculate total tokens
        await counterToken.transfer(thenaStrategyContract.address, amountB);

        await thenaStrategyContract.compound();

        // total tokens should be increased
        const expectedTotalTokens = initialTotalTokens
          .add(receivedAmountDuringSellReward)
          .add(amountA);
        expect(await thenaStrategyContract.totalTokens()).to.be.closeTo(
          expectedTotalTokens,
          expectedTotalTokens.mul(10).div(10000) // 0.10%
        );
        // expect that the staked amount of liquidity tokens is increased
        expect(await farm.balanceOf(thenaStrategyContract.address)).to.be.gt(
          initialStakedLpAmount
        );
        // expect that the amount of earned tokens is transferred to the exchange plugin
        expect(await theToken.balanceOf(exchangePlugin.address)).to.be.gte(
          initialExchangeThenaBalance.add(amountEarnedThena)
        );
        // expect that the earned thena amount is zero
        expect(await farm.earned(thenaStrategyContract.address)).to.be.equal(0);
        // expect that balances of tokens are zero
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);
        expect(
          await counterToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);
      });
    });

    describe("#withdraw", function () {
      beforeEach(async () => {
        await thenaStrategyContract.compound();
        await depositToken.transfer(
          thenaStrategyContract.address,
          testDepositTokenAmount
        );
        await thenaStrategyContract.deposit(testDepositTokenAmount);
      });

      it("revert if msg.sender is not owner", async function () {
        await expect(
          thenaStrategyContract
            .connect(alice)
            .withdraw(parseDepositToken("1000"))
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "Ownable__CallerIsNotTheOwner"
        );
      });

      it("should take only the remaining token balance to withdraw if it is enough to cover the withdrawal amount", async function () {
        const withdrawAmount = parseDepositToken("100");
        await depositToken.transfer(
          thenaStrategyContract.address,
          withdrawAmount
        );

        // save states before
        const initialOwnerBalance = await depositToken.balanceOf(owner.address);
        const initialStakedLpAmount = await farm.balanceOf(
          thenaStrategyContract.address
        );

        await thenaStrategyContract.withdraw(withdrawAmount);

        // should has a lp staked balance with some dust after withdrawal because of compound
        expect(
          await farm.balanceOf(thenaStrategyContract.address)
        ).to.be.closeTo(
          initialStakedLpAmount,
          parseUniform("0.01") // lp tokens have 18 decimals
        );

        // owner should has withdrawn deposit tokens
        expect(await depositToken.balanceOf(owner.address)).to.be.equal(
          initialOwnerBalance.add(withdrawAmount)
        );

        // deposit token balance of strategy should be zero
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);
      });

      it("should take the staked balance to withdraw if the remaining token balance is not enough to cover the withdrawal amount", async function () {
        // prepare and save states before
        await depositToken.transfer(
          thenaStrategyContract.address,
          testDepositTokenAmount
        );
        const initialTokenBalance = await depositToken.balanceOf(
          thenaStrategyContract.address
        );

        const extraWithdrawalAmount = parseDepositToken("100");
        const withdrawAmount = initialTokenBalance.add(extraWithdrawalAmount);

        const initialOwnerBalance = await depositToken.balanceOf(owner.address);
        const initialStakedLpAmount = await farm.balanceOf(
          thenaStrategyContract.address
        );

        // perform withdraw
        await thenaStrategyContract.withdraw(withdrawAmount);

        // owner should has all deposit tokens
        const withdrawAmountDelta = withdrawAmount.mul(5).div(10000); // 0.05%
        expect(await depositToken.balanceOf(owner.address)).to.be.closeTo(
          initialOwnerBalance.add(withdrawAmount),
          withdrawAmountDelta
        );

        // should has less lp staked balance after withdraw
        expect(
          await farm.balanceOf(thenaStrategyContract.address)
        ).to.be.lessThan(initialStakedLpAmount);

        // deposit token balance of strategy should be zero
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);
      });

      it("should reinvest exceeding amount", async function () {
        // prepare and save states before
        const receivedAmountDuringSellReward = parseDepositToken("1000");
        await exchangePlugin.setFixedReceivedAmount(
          theToken.address,
          depositToken.address,
          receivedAmountDuringSellReward
        );

        const withdrawAmount = parseDepositToken("100");

        const initialStakedLpAmount = await farm.balanceOf(
          thenaStrategyContract.address
        );
        const initialTotalTokens = await thenaStrategyContract.totalTokens();

        await thenaStrategyContract.withdraw(withdrawAmount);

        // should has same lp staked balance after withdraw
        expect(
          await farm.balanceOf(thenaStrategyContract.address)
        ).to.be.greaterThan(initialStakedLpAmount);
        // total tokens should be increased
        const expectedTotalTokens = initialTotalTokens
          .sub(withdrawAmount)
          .add(receivedAmountDuringSellReward);
        expect(await thenaStrategyContract.totalTokens()).to.be.closeTo(
          expectedTotalTokens,
          expectedTotalTokens.mul(10).div(10000) // 0.10%
        );
      });

      it("should withdraw all tokens if requested amount is higher than total tokens", async function () {
        // prepare and save states before
        await skipBlocks(10);
        const thenaRewardAmount = await farm.earned(
          thenaStrategyContract.address
        );

        const initialOwnerBalance = await depositToken.balanceOf(owner.address);

        const totalTokens = await thenaStrategyContract.totalTokens();

        // perform withdraw with 110% of total tokens
        const withdrawAmount = totalTokens.mul(110).div(100);
        await thenaStrategyContract.withdraw(withdrawAmount);

        // owner should has all deposit tokens added with the reward
        const withdrawAmountDelta = withdrawAmount.mul(5).div(10000); // 0.05%
        expect(await depositToken.balanceOf(owner.address)).to.be.closeTo(
          initialOwnerBalance.add(totalTokens),
          withdrawAmountDelta
        );

        // should has the dust of lp staked balance after withdraw because of compound
        expect(await farm.balanceOf(thenaStrategyContract.address)).to.be.lt(
          parseUniform("0.01")
        );

        // deposit token balance of strategy should be zero
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);

        // should has zero earned thena after withdraw
        expect(await farm.earned(thenaStrategyContract.address)).to.be.equal(0);

        // thena token balance of strategy should be zero
        expect(
          await theToken.balanceOf(thenaStrategyContract.address)
        ).to.be.equal(0);

        // mock exchange plugin contract should receive THE reward amount
        expect(await theToken.balanceOf(exchangePlugin.address)).to.be.gte(
          thenaRewardAmount
        );
      });

      it("should withdraw when oracle price deppegs (oracle: $1.1990)", async () => {
        await oracle.setPrice(
          counterToken.address,
          parseCounterToken("1.1990")
        );
        const depositAmount = parseDepositToken("10000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          depositAmount
        );
        await thenaStrategyContract.deposit(depositAmount);

        const amountWithdraw = parseDepositToken("1000");
        const amountWithdrawn = await thenaStrategyContract.callStatic.withdraw(
          amountWithdraw
        );
        expect(amountWithdrawn).to.equal(amountWithdraw);

        await thenaStrategyContract.withdraw(amountWithdraw);

        const slippageWithdrawn = amountWithdraw.mul(20).div(10000); // 0.02%
        expect(
          await depositToken.balanceOf(thenaStrategyContract.address)
        ).to.be.lessThan(slippageWithdrawn);
      });

      it("it reverts if oracle price too higher than thena price (oracle: $1.2010)", async function () {
        const amountDeposit = parseDepositToken("1000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          amountDeposit
        );
        await thenaStrategyContract.deposit(parseDepositToken("1000"));

        await oracle.setPrice(
          counterToken.address,
          parseCounterToken("1.2010")
        );

        await expect(
          thenaStrategyContract.withdraw(amountDeposit)
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "PriceManipulation"
        );
      });

      it("it reverts if oracle price too lower than thena price (oracle: $0.8300)", async function () {
        const amountDeposit = parseDepositToken("1000");
        await depositToken.transfer(
          thenaStrategyContract.address,
          amountDeposit
        );
        await thenaStrategyContract.deposit(parseDepositToken("1000"));

        // $1 / $0.83 ~= 120%
        await oracle.setPrice(
          counterToken.address,
          parseCounterToken("0.8300")
        );

        await expect(
          thenaStrategyContract.withdraw(amountDeposit)
        ).to.be.revertedWithCustomError(
          thenaStrategyContract,
          "PriceManipulation"
        );
      });
    });
  });
}
