const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy } = require("./shared/commonSetup");
const { saturateTokenBalancesInStrategies, parseUniform } = require("./utils");
const { convertFromUsdToTokenAmount, applySlippageInBps } = require("./utils");
const { constants } = require("@openzeppelin/test-helpers");


describe("Test StrategyRouter protocol fee collection", function () {

  let feeAddress;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // core contracts
  let router, oracle, exchange, sharesToken;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {

    [owner, nonReceiptOwner,,,,,,,,feeAddress] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());
    allocationWindowTime = await router.allocationWindowTime();

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true, constants.ZERO_ADDRESS);
    await router.setSupportedToken(busd.address, true, constants.ZERO_ADDRESS);
    await router.setSupportedToken(usdt.address, true, constants.ZERO_ADDRESS);

    // add fake strategies
    await deployFakeStrategy({ router, token: busd, profitPercent: 10_000 }); // 1% profit
    await deployFakeStrategy({ router, token: usdc, profitPercent: 10_000 }); // 1% profit
    await deployFakeStrategy({ router, token: usdt, profitPercent: 10_000 }); // 1% profit

    await saturateTokenBalancesInStrategies(router);
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

  describe("User withdraws funds", function () {
    describe( "stable coin rate varies", function () {
      beforeEach(async function () {
        await router.depositToBatch(busd.address, parseBusd("10000"));
        await router.allocateToStrategies();
      });

      describe( "rate not changed", function () {
        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [0];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(
              oracle,
              busd,
              sharesValueUsd
            ),
            700 // 7% slippage
          );
          await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.eq(parseUniform("0"));

          let protocolShares = await sharesToken.balanceOf(feeAddress.address);
          expect(protocolShares.toString()).to.be.eq(parseUniform("0"));

          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("1");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10100"));
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9960"), parseUniform("2"));
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.eq(parseUniform("0"));
          expect(cycleData.pricePerShare).to.be.eq(parseUniform("1"));
        });
      })

      describe( "rate decreased", function () {
        beforeEach(async function () {
          let busdAmount = parseBusd("0.95");
          await oracle.setPrice(busd.address, busdAmount);
        });

        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [0];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(
              oracle,
              busd,
              sharesValueUsd
            ),
            700 // 7% slippage
          );
          await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.eq(parseUniform("0"));

          let protocolShares = await sharesToken.balanceOf(feeAddress.address);
          expect(protocolShares.toString()).to.be.eq(parseUniform("0"));

          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("1");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10100"));
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9960"), parseUniform("2"));
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.eq(parseUniform("0"));
          expect(cycleData.pricePerShare).to.be.eq(parseUniform("1"));
        });
      })

      describe( "rate increased", function () {
        beforeEach(async function () {
          let busdAmount = parseBusd("1.05"); // use to be 1.01
          await oracle.setPrice(busd.address, busdAmount);
        });

        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [0];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(
              oracle,
              busd,
              sharesValueUsd
            ),
            700 // 7% slippage
          );
          await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.eq(parseUniform("0"));

          let protocolShares = await sharesToken.balanceOf(feeAddress.address);
          expect(protocolShares.toString()).to.be.eq(parseUniform("0"));

          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("1");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10100"));
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9960"), parseUniform("2"));
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.eq(parseUniform("0"));
          expect(cycleData.pricePerShare).to.be.eq(parseUniform("1"));
        });
      })
    })

    describe( "Price per share varies", function () {
      beforeEach(async function () {
        let busdAmount = parseBusd("1");
        await oracle.setPrice(busd.address, busdAmount);

        await router.depositToBatch(busd.address, parseBusd("10000"));
        await router.allocateToStrategies();
      });

      describe( "Stablecoin rate not changed", function () {
        beforeEach(async function () {
          await router.depositToBatch(busd.address, parseBusd("10000"));
          await router.allocateToStrategies();
        });

        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [1];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(
              oracle,
              busd,
              sharesValueUsd
            ),
            700 // 7% slippage
          );
          await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.closeTo(parseUniform("9950"), parseUniform("3"));

          let protocolShares = await sharesToken.balanceOf(feeAddress.address);
          expect(protocolShares.toString()).to.be.closeTo(parseUniform("19.7"), parseUniform("0.1"));

          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("2");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10000"));
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9885"), parseUniform("1"));
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("10030"), parseUniform("3"));
          expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1.01"), parseUniform("0.005"));
        });
      })

      describe( "Stablecoin rate decreased", function () {
        beforeEach(async function () {
          let busdAmount = parseBusd("0.95");
          await oracle.setPrice(busd.address, busdAmount);

          await router.depositToBatch(busd.address, parseBusd("10000"));
          await router.allocateToStrategies();
        });

        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [1];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(
              oracle,
              busd,
              sharesValueUsd
            ),
            700 // 7% slippage
          );
          await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.closeTo(parseUniform("9930"), parseUniform("2"));

          let protocolShares = await sharesToken.balanceOf(feeAddress.address);
          expect(protocolShares.toString()).to.be.eq(parseUniform("0"));

          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("2");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("9500"));
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9720"), parseUniform("3"));
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("9860"), parseUniform("2"));
          expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("0.99"), parseUniform("0.004"));
        });
      })

      describe( "Stablecoin rate increased", function () {
        let protocolSharesBefore;

        beforeEach(async function () {
          let busdAmount = parseBusd("1.05"); // use to be 1.01
          await oracle.setPrice(busd.address, busdAmount);

          protocolSharesBefore = await sharesToken.balanceOf(feeAddress.address);

          await router.depositToBatch(busd.address, parseBusd("10000"));
          await router.allocateToStrategies();
        });

        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [1];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(
              oracle,
              busd,
              sharesValueUsd
            ),
            1000 // 10% slippage
          );
          await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.closeTo(parseUniform("9980"), parseUniform("1"));

          let protocolSharesAfter = await sharesToken.balanceOf(feeAddress.address);

          let protocolSharesDiff = protocolSharesAfter.sub(protocolSharesBefore);
          expect(protocolSharesDiff.toString()).to.be.closeTo(parseUniform("52.40"), parseUniform("0.1"));

          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("2");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10500"));
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("10050"), parseUniform("2"));
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("10195"), parseUniform("2"));
          expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1.02"), parseUniform("0.005"));
        });
      })
    })

    describe( "Specific scenarion" , function () {
      it("Rate-goes-up scenario", async function () {
        let busdAmount = parseBusd("1");
        await oracle.setPrice(busd.address, busdAmount);

        let usdcAmount = parseUsdc("1");
        await oracle.setPrice(usdc.address, usdcAmount);

        let usdtAmount = parseUsdt("1");
        await oracle.setPrice(usdt.address, usdtAmount);

        // 1. User A deposits 1000 BUSD;
        await router.depositToBatch(busd.address, parseBusd("1000"));
        await router.allocateToStrategies();

        // 2. User A gets ~1000 shares;
        // We loose here around 0.2% due to conversion while deposit is swapped to dtrategy deposit tokens
        let totalShares = await sharesToken.totalSupply();
        expect(totalShares.toString()).to.be.closeTo(parseUniform("998"), parseUniform("0.3"));

        // 3. Rate goes up, 1 BUSD = 1.05 USD
        busdAmount = parseBusd("1.05");
        await oracle.setPrice(busd.address, busdAmount);

        // 4. User withdraws 1000 shares to BUSD;
        let receiptIds = [0];
        let shares = await router.calculateSharesFromReceipts(receiptIds);
        expect(shares.toString()).to.be.closeTo(parseUniform("998"), parseUniform("0.3"));

        // 4.1. FE uses router.calculateSharesUsdValue to calculate USD value. It is $1015
        // We have 2 strategies, each use to be worth $333 at the rate of $1 per their token
        // Now one strategy value has increased - it is now (333*$1) + (333*$1) + (333*$1.05) = ~$1015
        let sharesValueUsd = await router.calculateSharesUsdValue(shares);
        expect(sharesValueUsd.toString()).to.be.closeTo(parseUniform("1015"), parseUniform("0.3"));

        // 4.2. FE uses oracle to convert USD value to BUSD. $1015 / 1.05 = 966.46 BUSD
        let busdToWithdraw = await convertFromUsdToTokenAmount(
          oracle,
          busd,
          sharesValueUsd
        );
        expect(busdToWithdraw.toString()).to.be.closeTo(parseBusd("966.5"), parseBusd("0.5"));

        // 4.3. FE applies slippage tolerance 7% = 898.81 BUSD
        let minExpectedWithdrawAmount = applySlippageInBps(
          busdToWithdraw,
          700 // 7% slippage
        );
        expect(minExpectedWithdrawAmount.toString()).to.be.closeTo(parseBusd("898"), parseBusd("1"));

        // 5. FE requests to withdraw 1000 shares and pass the minimum expected amount as 898.81 BUSD
        let tokenBalanceBefore = await busd.balanceOf(owner.address);
        await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);
        let tokenBalanceAfter = await busd.balanceOf(owner.address);

        // 6. ~$1000 BUSD are withdrawn
        let tokenWithdrawn = tokenBalanceAfter.sub(tokenBalanceBefore);
        expect(tokenWithdrawn.toString()).to.be.closeTo(parseBusd("997"), parseBusd("1"));
      })

      it("Rate-goes-down scenario", async function () {
        let busdAmount = parseBusd("1");
        await oracle.setPrice(busd.address, busdAmount);

        let usdcAmount = parseUsdc("1");
        await oracle.setPrice(usdc.address, usdcAmount);

        let usdtAmount = parseUsdt("1");
        await oracle.setPrice(usdt.address, usdtAmount);

        // 1. User A deposits 1000 BUSD;
        await router.depositToBatch(busd.address, parseBusd("1000"));
        await router.allocateToStrategies();

        // 2. User A gets ~1000 shares;
        // We loose here around 0.2% due to conversion while deposit is swapped to dtrategy deposit tokens
        let totalShares = await sharesToken.totalSupply();
        expect(totalShares.toString()).to.be.closeTo(parseUniform("998"), parseUniform("0.3"));

        // 3. Rate goes down, 1 BUSD = 0.95 USD
        busdAmount = parseBusd("0.95");
        await oracle.setPrice(busd.address, busdAmount);

        // 4. User withdraws 1000 shares to BUSD;
        let receiptIds = [0];
        let shares = await router.calculateSharesFromReceipts(receiptIds);
        expect(shares.toString()).to.be.closeTo(parseUniform("998"), parseUniform("0.3"));

        // 4.1. FE uses router.calculateSharesUsdValue to calculate USD value. It is $983
        // We have 2 strategies, each use to be worth $333 at the rate of $1 per their token
        // Now one strategy value has increased - it is now (333*$1) + (333*$1) + (333*$0.95) = ~$983
        let sharesValueUsd = await router.calculateSharesUsdValue(shares);
        expect(sharesValueUsd.toString()).to.be.closeTo(parseUniform("982"), parseUniform("1"));

        // 4.2. FE uses oracle to convert USD value to BUSD. $983 / 0.95 = 1034.73 BUSD
        let busdToWithdraw = await convertFromUsdToTokenAmount(
          oracle,
          busd,
          sharesValueUsd
        );
        expect(busdToWithdraw.toString()).to.be.closeTo(parseBusd("1033.5"), parseBusd("0.5"));

        // 4.3. FE applies slippage tolerance 7% = 333 BUSD
        let minExpectedWithdrawAmount = applySlippageInBps(
          busdToWithdraw,
          700 // 7% slippage
        );
        expect(minExpectedWithdrawAmount.toString()).to.be.closeTo(parseBusd("961"), parseBusd("1"));

        // 5. FE requests to withdraw 1000 shares and pass the minimum expected amount as 898.81 BUSD
        let tokenBalanceBefore = await busd.balanceOf(owner.address);
        await router.withdrawFromStrategies(receiptIds, busd.address, shares, minExpectedWithdrawAmount);
        let tokenBalanceAfter = await busd.balanceOf(owner.address);

        // 6. ~$1000 BUSD are withdrawn
        let tokenWithdrawn = tokenBalanceAfter.sub(tokenBalanceBefore);
        expect(tokenWithdrawn.toString()).to.be.closeTo(parseBusd("997"), parseBusd("1"));
      })
    })
  })
});
