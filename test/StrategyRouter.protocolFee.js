const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy } = require("./shared/commonSetup");
const { saturateTokenBalancesInStrategies, parseUniform } = require("./utils");


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
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);
    await router.setSupportedToken(usdt.address, true);

    // add fake strategies
    await deployFakeStrategy({ router, token: busd });
    await deployFakeStrategy({ router, token: usdc });
    await deployFakeStrategy({ router, token: usdt });

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

  describe("protocols collecting fee in shares", function () {

    it("should not have shares before first cycle", async function () {
      const currentCycleId = await router.currentCycleId();
      expect(currentCycleId.toString()).to.be.equal("0");

      let totalShares = await sharesToken.totalSupply();
      expect(totalShares.toString()).to.be.equal("0");  
    });

    it("should not have shares after first cycle", async function () {
      // deposit to strategies  
      await router.depositToBatch(busd.address, parseBusd("1000"));
      await router.allocateToStrategies();
  
      let totalShares = await sharesToken.totalSupply();
      expect(totalShares.toString()).to.be.closeTo(parseUniform("1000"), parseUniform("2"));

      let protocolShares = await sharesToken.balanceOf(feeAddress.address);
      expect(protocolShares.toString()).to.be.equal("0");
    });

    describe("after first cycle", function () {
      beforeEach(async function () {
        await router.depositToBatch(busd.address, parseBusd("1000"));
        await router.allocateToStrategies();
      });

      it("should have no shares if there was no yield", async function () {
        const strategiesData = await router.getStrategies();

        for( i = 0; i < strategiesData.length; i++) {
          let strategyContract = await ethers.getContractAt("MockStrategy", strategiesData[i][0]);
          await strategyContract.setMockProfitPercent(0);
        }

        // deposit to strategies
        await router.depositToBatch(busd.address, parseBusd("1000"));
        await router.allocateToStrategies();
    
        let totalShares = await sharesToken.totalSupply();
        expect(totalShares.toString()).to.be.closeTo(parseUniform("2000"), parseUniform("5"));
  
        let protocolShares = await sharesToken.balanceOf(feeAddress.address);
        expect(protocolShares.toString()).to.be.equal("0");

        const currentCycleId = await router.currentCycleId();
        expect(currentCycleId.toString()).to.be.equal("2");  

        // get struct data and check TVL at the end of cycle
        let cycleData = await router.getCycle(currentCycleId-1);

        // totalDepositedInUsd; deposited BUSD with rate 1.01
        expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("1010"));
        // receivedByStrategiesInUsd
        expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("1000"), parseUniform("3"));
        // strategiesBalanceWithCompoundAndBatchDepositsInUsd
        expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("2000"), parseUniform("5"));
        // pricePerShare
        expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1"), parseUniform("0.01"));
      });

      it("should have shares if there was yield", async function () {
        // deposit to strategies  
        await router.depositToBatch(busd.address, parseBusd("1000"));
        await router.allocateToStrategies();
    
        let totalShares = await sharesToken.totalSupply();
        // 1990 shares - because after 1 cycle compound has brought 10 USD, which made PPS be 1% more valuable
        expect(totalShares.toString()).to.be.closeTo(parseUniform("1990"), parseUniform("2"));
  
        let protocolShares = await sharesToken.balanceOf(feeAddress.address);
        expect(protocolShares.toString()).to.be.closeTo(parseUniform("2"), parseUniform("0.1"));

        const currentCycleId = await router.currentCycleId();
        expect(currentCycleId.toString()).to.be.equal("2");  

        // get struct data and check TVL at the end of cycle
        let cycleData = await router.getCycle(currentCycleId-1);

        // totalDepositedInUsd; deposited BUSD with rate 1.01
        expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("1010"));
        // receivedByStrategiesInUsd
        expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("1000"), parseUniform("3"));
        // strategiesBalanceWithCompoundAndBatchDepositsInUsd
        expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("2000"), parseUniform("6"));
        // pricePerShare
        expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1"), parseUniform("0.01"));
      });

      describe("after second cycle", function () {
        beforeEach(async function () {
          await router.depositToBatch(busd.address, parseBusd("1000"));
          await router.allocateToStrategies();
        });
  
        it("should decrease previous cycle recorder balance on withdrawal", async function () {
          let receiptIds = [1];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          await router.withdrawFromStrategies(receiptIds, busd.address, shares);

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.closeTo(parseUniform("1000"), parseUniform("1"));
    
          let protocolShares = await sharesToken.balanceOf(feeAddress.address);
          expect(protocolShares.toString()).to.be.closeTo(parseUniform("2"), parseUniform("0.02"));
  
          const currentCycleId = await router.currentCycleId();
          expect(currentCycleId.toString()).to.be.equal("2");  
  
          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId-1);

          // totalDepositedInUsd; deposited BUSD with rate 1.01
          expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("1010"));
          // receivedByStrategiesInUsd
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("1000"), parseUniform("3"));
          // strategiesBalanceWithCompoundAndBatchDepositsInUsd
          expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("1010"), parseUniform("3"));
          // pricePerShare
          expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1"), parseUniform("0.01"));
        });

        describe("after withdraw", function () {
          beforeEach(async function () {
            let receiptIds = [1];
            let shares = await router.calculateSharesFromReceipts(receiptIds);
            await router.withdrawFromStrategies(receiptIds, busd.address, shares);
          });

          it("should have shares if there was yield", async function () {
            await router.depositToBatch(busd.address, parseBusd("1000"));
            await router.allocateToStrategies();

            let totalShares = await sharesToken.totalSupply();
            // 1990 - because after 1 cycle compound has brought 10 USD, which made PPS be 1% more valuable
            expect(totalShares.toString()).to.be.closeTo(parseUniform("1990"), parseUniform("10"));
      
            let protocolShares = await sharesToken.balanceOf(feeAddress.address);
            expect(protocolShares.toString()).to.be.closeTo(parseUniform("4"), parseUniform("0.05"));
    
            const currentCycleId = await router.currentCycleId();
            expect(currentCycleId.toString()).to.be.equal("3");  
    
            // get struct data and check TVL at the end of cycle
            let cycleData = await router.getCycle(currentCycleId-1);

            // totalDepositedInUsd; deposited BUSD with rate 1.01
            expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("1010"));
            // receivedByStrategiesInUsd
            expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("1000"), parseUniform("3"));
            // strategiesBalanceWithCompoundAndBatchDepositsInUsd
            expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("2010"), parseUniform("10"));
            // pricePerShare
            expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1"), parseUniform("0.02"));
          });
        });
      });
    });
  });
});
