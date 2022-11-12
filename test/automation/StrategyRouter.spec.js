const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupTokens, setupCore, setupParamsOnBNB } = require("../shared/commonSetup");
const { skipTimeAndBlocks, MaxUint256, deploy, provider, parseUniform } = require("../utils");

describe.only("StrategyRouter upkeep automation", function () {

  let owner, user2;
  // mock tokens with different decimals
  let usdc, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd;
  // core contracts
  let router, oracle, exchange, batch, receiptContract, sharesToken;
  let allocationWindowTime;
  let strategyBiswap, strategyBiswap2;

  let snapshotId;

  before(async function () {

    [owner, user2] = await ethers.getSigners();
    snapshotId = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());

    // setup params for testing
    await setupParamsOnBNB(router, oracle, exchange);
    allocationWindowTime = await router.allocationWindowTime();

    // get tokens on bnb chain for testing
    ({usdc, busd, parseUsdc, parseBusd} = await setupTokens());

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));

    // deploy strategies
    let StrategyFactory = await ethers.getContractFactory("BiswapBusdUsdt");
    strategyBiswap2 = await upgrades.deployProxy(StrategyFactory, [owner.address], {
      kind: 'uups',
      constructorArgs: [router.address],
    });
    await strategyBiswap2.deployed();
    await strategyBiswap2.transferOwnership(router.address);

    StrategyFactory = await ethers.getContractFactory("BiswapUsdcUsdt");
    strategyBiswap = await upgrades.deployProxy(StrategyFactory, [owner.address], {
      kind: 'uups',
      constructorArgs: [router.address],
    });
    await strategyBiswap.deployed();
    await strategyBiswap.transferOwnership(router.address);

    await router.addStrategy(strategyBiswap2.address, busd.address, 5000);
    await router.addStrategy(strategyBiswap.address, usdc.address, 5000);

    // admin initial deposit to set initial shares and pps, receipt ID 1
    await router.depositToBatch(busd.address, parseBusd("1"));
    await router.allocateToStrategies();
  });

  after(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  // This test only tests behavior of automation mechanic (checkUpkeep and performUpkeep methods)
  // All other accompanied functionality (i.e allocatedToStrategies() business logic like its currentCycle 
  // increment mechanics) is tested elsewhere 
  describe("Test automation of allocation to strategies", function() {
      describe("No deposit", function() {
        verifyNullifiedState();
      });

      describe("First deposit to batch by user #1 asset A", function() {
        before(async function () {
            // Make deposit from user 1 to protocol in assetA
        });

        describe("Current cycle is active", function() {
            // No preset

            verifyProtocolStateForSingleDeposit();
            it("checkUpkeep returns false");

            describe("User triggers allocateToStrategies", function() {
                before(async function () {
                    // call allocateToStrategy on behalf of user 1
                });

                verifyNullifiedState();
            });
        });

        describe("First deposit is withdrawn from batch", function() {
            before(async function () {
                // user 1 withdraws deposit 1
            });

            verifyNullifiedState();
        });

        describe("Allocation window time has passed", function() {
            before(async function () {
                // move on the time to cycleDuration + 1 min
            });

            verifyProtocolStateForSingleDeposit();
            it("checkUpkeep returns true");

            describe("User triggers allocateToStrategies", function() {
                before(async function () {
                    // call allocateToStrategy on behalf of user 1
                });

                verifyNullifiedState();
            });
        });

        describe("Second deposit", function() {
            describe("From user #1 in asset A", function() {  
                before(async function () {
                    // Make deposit from user 1 to protocol in asset A
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits(user1, assetA);
            });

            describe("From user #1 in asset B", function() {  
                before(async function () {
                    // Make deposit from user 1 to protocol in assetB
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits(user1, assetB);
            });

            describe("From user #2 in asset A", function() {
                before(async function () {
                    // Make deposit from user 2 to protocol in asseta
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits(user2, assetA);
            });

            describe("From user #2 in asset B", function() {
                before(async function () {
                    // Make deposit from user 2 to protocol in assetB
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits(user2, assetB);
            });
        });
      });
  });

  const verifyNullifiedState = () => {
    it("Countdown nullified");
    it("Deposits count is zero");
    it("checkUpkeep returns false");
    it("performUpkeep execution fails");
  }

  const verifyProtocolStateForSingleDeposit = () => {
    it("Countdown has started");
    it("Deposits count is 1");
    it("performUpkeep execution is successful");
  }

  const verifyProtocolStateForTwoDeposit = () => {
    it("Countdown has started");
    it("Deposits count is 2");
    it("performUpkeep execution is successful");
  }

  const verifyProtocolBehaviorInTimeWithTwoDeposits = (depositor2, assetB) => {
    describe("Current cycle is active", function() {
        // No preset

        verifyProtocolStateForTwoDeposit();
        it("checkUpkeep returns false");

        describe("User triggers allocateToStrategies", function() {
            before(async function () {
                // call allocateToStrategy on behalf of user 1
            });

            verifyNullifiedState();
        });

        describe("First deposit withdrawn", function() {
            before(async function () {
                // depositor 1 withdraws deposit 1
            });

            verifyProtocolStateForSingleDeposit();
        });

        describe("Second deposit withdrawn", function() {
            before(async function () {
                // depositor 2 withdraws deposit 2
            });

            verifyProtocolStateForSingleDeposit();
        });

        describe("Both deposits withdrawn", function() {
            before(async function () {
                // depositor 1 withdraws deposit 1
                // depositor 2 withdraws deposit 2
            });

            verifyNullifiedState();
        });
    });

    describe("Allocation window time has passed", function() {
        before(async function () {
            // move on the time
        });

        verifyProtocolStateForTwoDeposit();
        it("checkUpkeep returns true");

        describe("User triggers allocateToStrategies", function() {
            before(async function () {
                // call allocateToStrategy on behalf of user 1
            });

            verifyNullifiedState();
        });
    });
  }
});
