const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTokensLiquidityOnPancake, setupTestParams, deployFakeStrategy } = require("../shared/commonSetup");
const { skipTimeAndBlocks, provider, parseUniform } = require("../utils");
const { constants } = require("@openzeppelin/test-helpers");

describe("StrategyRouter upkeep automation", function () {

  let owner, user1, user2;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // core contracts
  let router, oracle, exchange, batch, receiptContract, sharesToken;
  let cycleAllocationWindowTime = 3600;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;
  // Globally accessed vars, reset after every test case
  let depositor1, depositor2, assetA, assetB;

  before(async function () {

      [owner, user1, user2] = await ethers.getSigners();
      initialSnapshot = await provider.send("evm_snapshot");

      // deploy core contracts
      ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());

      // deploy mock tokens 
      ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(router));

      // setup fake token liquidity
      let amount = (1_000_000).toString();
      await setupTokensLiquidityOnPancake(usdc, busd, amount);
      await setupTokensLiquidityOnPancake(usdc, usdt, amount);

      // setup params for testing
      await setupTestParams(router, oracle, exchange, usdc, usdt, busd);

      // setup infinite allowance
      await usdc.approve(router.address, parseUsdc("1000000"));
      await usdt.approve(router.address, parseUsdt("1000000"));

      // setup supported tokens
      await router.addSupportedToken(usdc);
      await router.addSupportedToken(usdt);

      // add fake strategies
      await deployFakeStrategy({ router, token: usdc });
      await deployFakeStrategy({ router, token: usdt });

      await usdc.transfer(user1.address, parseUsdc("1500"));
  });

  beforeEach(async function () {
      snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
      depositor1 = undefined;
      depositor2 = undefined;
      assetA = undefined;
      assetB = undefined;
      await provider.send("evm_revert", [snapshotId]);
  });

  after(async () => {
      await provider.send("evm_revert", [initialSnapshot]);
  });

  const itBehavesLikeInitialState = () => {
    it("Countdown not started", async () => {
        const currentCycleFirstDepositAt = await router.currentCycleFirstDepositAt([]);
        expect(currentCycleFirstDepositAt).to.be.equal(0);
    });

    it("Deposits count is zero", async () => {
      const currentCycleDepositsCount = await router.currentCycleDepositsCount();
      expect(currentCycleDepositsCount).to.be.equal(0);
    });

    it("checkUpkeep returns false", async () => {
        const [upkeepRunning, ] = await router.checkUpkeep([]);
        expect(upkeepRunning).to.be.equal(false);
    });

    it("performUpkeep execution fails", async () => {
      await expect(router.performUpkeep([])).to.be.reverted;
    });
  }

  const verifyProtocolStateForSingleDeposit = () => {
    it("Countdown has started", async () => {
      const currentCycleFirstDepositAt = await router.currentCycleFirstDepositAt([]);
      expect(currentCycleFirstDepositAt).to.not.be.equal(0);
    });

    it("Deposits count is 1", async () => {
      const currentCycleDepositsCount = await router.currentCycleDepositsCount();
      expect(currentCycleDepositsCount).to.be.equal(1);
    });

    it("performUpkeep execution is successful", async () => {
      await expect(router.performUpkeep([])).to.not.be.reverted;
    });
  }

  const verifyProtocolStateForTwoDeposit = () => {
    it("Countdown has started", async () => {
      const currentCycleFirstDepositAt = await router.currentCycleFirstDepositAt([]);
      expect(currentCycleFirstDepositAt).to.not.be.equal(0);
    });

    it("Deposits count is 2", async () => {
      const currentCycleDepositsCount = await router.currentCycleDepositsCount();
      expect(currentCycleDepositsCount).to.be.equal(2);
    });

    it("performUpkeep execution is successful", async () => {
      await expect(router.performUpkeep([])).to.not.be.reverted;
    });
  }

  const verifyProtocolBehaviorInTimeWithTwoDeposits = () => {
    describe("Current cycle is active", function() {
      // No preset

      verifyProtocolStateForTwoDeposit();
      it("checkUpkeep returns false", async () => {
        const [upkeepRunning, ] = await router.checkUpkeep([]);
        expect(upkeepRunning).to.be.equal(false);
      });

      describe("User triggers allocateToStrategies", function() {
          beforeEach(async function () {
              // call allocateToStrategy on behalf of depositor 2
              await router.connect(depositor2).performUpkeep([]);
          });

          itBehavesLikeInitialState();
      });

      describe("First deposit withdrawn", function() {
        beforeEach(async function () {
          // depositor 1 withdraws deposit 1
          let receipts = await receiptContract.getTokensOfOwner(depositor1.address);
          await router.connect(depositor1).withdrawFromBatch([receipts[receipts.length-1]]);
        });

        verifyProtocolStateForSingleDeposit();
      });

      describe("Second deposit withdrawn", function() {
        beforeEach(async function () {
          // depositor 2 withdraws deposit 2, deposits are returned in LIFO order
          let receipts = await receiptContract.getTokensOfOwner(depositor2.address);
          await router.connect(depositor2).withdrawFromBatch([receipts[0]]);
        });

        verifyProtocolStateForSingleDeposit();
      });

      describe("Both deposits withdrawn", function() {
        beforeEach(async function () {
          // depositor 1 withdraws deposit 1
          // depositor 2 withdraws deposit 2
          let receipts;

          receipts = await receiptContract.getTokensOfOwner(depositor1.address);
          await router.connect(depositor1).withdrawFromBatch([receipts[receipts.length-1]]);

          receipts = await receiptContract.getTokensOfOwner(depositor2.address);
          await router.connect(depositor2).withdrawFromBatch([receipts[receipts.length-1]]);
        });

        itBehavesLikeInitialState();
      });
    });

    describe("Allocation window time has passed", function() {
      before(async function () {
          // move on the time to cycleDuration + 1 min
          const timeToSkip = cycleAllocationWindowTime  + 60;
          await skipTimeAndBlocks(timeToSkip, timeToSkip/3); 
      });

      verifyProtocolStateForTwoDeposit();

      it("checkUpkeep returns false", async () => {
        const [upkeepRunning, ] = await router.checkUpkeep([]);
        expect(upkeepRunning).to.be.equal(false);
      });

      describe("User triggers allocateToStrategies", function() {
          beforeEach(async function () {
              // call allocateToStrategy on behalf of user 1
              await router.connect(depositor1).performUpkeep([]);
          });

          itBehavesLikeInitialState();
      });
    });
  }

  // This test only tests behavior of automation mechanic (checkUpkeep and performUpkeep methods)
  // All other accompanied functionality (i.e allocatedToStrategies() business logic like its currentCycle 
  // increment mechanics) is tested elsewhere 
  describe("Test automation of allocation to strategies", function() {
      beforeEach(async () => {
        depositor1 = user1;
        assetA = usdc;

        // Set allocation window time to 1 hour
        await router.setAllocationWindowTime(cycleAllocationWindowTime);
      });

      describe("No deposit", function() {
        itBehavesLikeInitialState();
      });

      describe("First deposit to batch by user #1 asset A", function() {
        beforeEach(async function () {
            // Make deposit from user 1 to protocol in assetA
            await assetA.connect(depositor1).approve(router.address, parseUsdc("1500"));
            await router.connect(depositor1).depositToBatch(assetA.address, parseUsdc("1500"));
        });

        describe("Current cycle is active", function() {
          // No preset
          verifyProtocolStateForSingleDeposit();

          it("checkUpkeep returns false", async () => {
            const [upkeepRunning, ] = await router.checkUpkeep([]);
            expect(upkeepRunning).to.be.equal(false);
          });

          describe("User triggers allocateToStrategies", function() {
              beforeEach(async function () {
                  // call allocateToStrategy on behalf of user 1
                  await router.connect(depositor1).performUpkeep([]);
              });

              itBehavesLikeInitialState();
          });
        });

        describe("First deposit is withdrawn from batch", function() {
            beforeEach(async function () {
                // user 1 withdraws deposit 1
                let receipts = await receiptContract.getTokensOfOwner(depositor1.address);
                await router.connect(depositor1).withdrawFromBatch(receipts);
            });

            itBehavesLikeInitialState();
        });

        describe("Allocation window time has passed", function() {
            beforeEach(async function () {
                // move on the time to cycleDuration + 1 min
                const timeToSkip = cycleAllocationWindowTime  + 60;
                await skipTimeAndBlocks(timeToSkip, timeToSkip/3);
            });

            verifyProtocolStateForSingleDeposit();
            it("checkUpkeep returns true", async () => {
              const [upkeepRunning, ] = await router.checkUpkeep([]);
              expect(upkeepRunning).to.be.equal(true);
            });

            describe("User triggers allocateToStrategies", function() {
                beforeEach(async function () {
                    // call allocateToStrategy on behalf of user 1
                    await router.connect(depositor1).performUpkeep([]);
                });

                itBehavesLikeInitialState();
            });
        });

        describe("Second deposit", function() {
            describe("From user #1 in asset A", function() {  
                beforeEach(async function () {
                    depositor2 = user1;
                    assetB = usdc;

                    // Make deposit from user 1 to protocol in asset A
                    await assetA.transfer(depositor2.address, parseUsdc("5000"));
                    await assetA.connect(depositor2).approve(router.address, parseUsdc("5000"));
                    await router.connect(depositor2).depositToBatch(assetA.address, parseUsdc("5000"));
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits();
            });

            describe("From user #1 in asset B", function() {  
                beforeEach(async function () {
                  depositor2 = user1;
                  assetB = usdt;

                  // Make deposit from user 1 to protocol in assetB
                  await assetB.transfer(depositor2.address, parseUsdt("5000"));
                  await assetB.connect(depositor2).approve(router.address, parseUsdt("5000"));
                  await router.connect(depositor2).depositToBatch(assetB.address, parseUsdt("5000"));
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits();
            });

            describe("From user #2 in asset A", function() {
                beforeEach(async function () {
                  depositor2 = user2;
                  assetB = usdc;

                  // Make deposit from user 2 to protocol in assetA
                  await assetB.transfer(depositor2.address, parseUsdc("5000"));
                  await assetB.connect(depositor2).approve(router.address, parseUsdc("5000"));
                  await router.connect(depositor2).depositToBatch(assetB.address, parseUsdc("5000"));
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits(user2, assetA);
            });

            describe("From user #2 in asset B", function() {
                beforeEach(async function () {
                  depositor2 = user2;
                  assetB = usdt;

                  // Make deposit from user 2 to protocol in assetB
                  await assetB.transfer(depositor2.address, parseUsdt("5000"));
                  await assetB.connect(depositor2).approve(router.address, parseUsdt("5000"));
                  await router.connect(depositor2).depositToBatch(assetB.address, parseUsdt("5000"));
                });
                
                verifyProtocolBehaviorInTimeWithTwoDeposits(user2, assetB);
            });
        });
      });
  });


  describe("AllocationWindowTime affects upkeep", function() {
    beforeEach(async () => {
      depositor1 = user1;
      assetA = usdc;
    });

    it('default allocation window time is minimum', async () => {
      const allocationWindowTime = await router.allocationWindowTime();
      expect(allocationWindowTime).to.be.equal(1);
    })

    describe("AllocationWindowTime affects upkeep", function() {
      beforeEach(async function () {
        // Set allocation window time to 1 hour
        await router.setAllocationWindowTime(cycleAllocationWindowTime);
      });

      it('allocation window time is one hour', async () => {
        const allocationWindowTime = await router.allocationWindowTime();
        expect(allocationWindowTime).to.be.equal(cycleAllocationWindowTime);
      })

      describe("User deposit funds and starts timer", function() {  
        beforeEach(async function () {
            // Make deposit from user 1 to protocol in asset A
            await assetA.transfer(user1.address, parseUsdc("5000"));
            await assetA.connect(user1).approve(router.address, parseUsdc("5000"));
            await router.connect(user1).depositToBatch(assetA.address, parseUsdc("5000"));
        });
        
        it("checkUpkeep returns false", async () => {
          const [upkeepRunning, ] = await router.checkUpkeep([]);
          expect(upkeepRunning).to.be.equal(false);
        });

        describe("Allocation window time has NOT passed", function() {
          beforeEach(async function () {
              // move on the time to cycleDuration + 1 min
              const timeToSkip = cycleAllocationWindowTime/3;
              await skipTimeAndBlocks(timeToSkip, timeToSkip/3);
          });

          it("checkUpkeep returns false", async () => {
            const [upkeepRunning, ] = await router.checkUpkeep([]);
            expect(upkeepRunning).to.be.equal(false);
          });
        });

        describe("Allocation window time has passed", function() {
          beforeEach(async function () {
              // move on the time to cycleDuration + 1 min
              const timeToSkip = cycleAllocationWindowTime  + 60;
              await skipTimeAndBlocks(timeToSkip, timeToSkip/3);
          });

          it("checkUpkeep returns false", async () => {
            const [upkeepRunning, ] = await router.checkUpkeep([]);
            expect(upkeepRunning).to.be.equal(true);
          });
        });

      });
    });
  });
});
