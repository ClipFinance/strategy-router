const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTestParams,
  setupTokensLiquidityOnPancake,
  deployFakeStrategy,
} = require("./shared/commonSetup");
const {
  saturateTokenBalancesInStrategies,
  parseUniform,
  convertFromUsdToTokenAmount,
  applySlippageInBps,
  provider,
} = require("./utils");

describe("Test StrategyRouter protocol fee collection", function () {
  let feeAddress;
  // mock tokens with different decimals
  let usdc, usdt, busd;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, admin, sharesToken;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, nonReceiptOwner, , , , , , , , feeAddress] =
      await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({
      router,
      oracle,
      exchange,
      admin,
      batch,
      receiptContract,
      sharesToken,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore());
    allocationWindowTime = ethers.BigNumber.from(
      await provider.getStorageAt(router.address, 102)
    );

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode));

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    await setupTokensLiquidityOnPancake(usdc, busd, amount);
    await setupTokensLiquidityOnPancake(busd, usdt, amount);
    await setupTokensLiquidityOnPancake(usdc, usdt, amount);

    // setup params for testing
    await setupTestParams(router, oracle, exchange, admin, usdc, usdt, busd);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));
    await usdt.approve(router.address, parseUsdt("1000000"));

    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(busd);
    await admin.addSupportedToken(usdt);

    // add fake strategies
    await deployFakeStrategy({
      batch,
      router,
      admin,
      token: busd,
      profitPercent: 10_000,
    }); // 1% profit
    await deployFakeStrategy({
      batch,
      router,
      admin,
      token: usdc,
      profitPercent: 10_000,
    }); // 1% profit
    await deployFakeStrategy({
      batch,
      router,
      admin,
      token: usdt,
      profitPercent: 10_000,
    }); // 1% profit

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

  // TODO: at the moment protocol commission is 12% of yield
  // describe("When protocol commission is set to zero, protocol should not collect fee", function () {
  //   beforeEach(async function () {
  //     await router.setFeesPercent(0);
  //   });

  //   it("should have no shares after initial deposit", async function () {
  //     // deposit to strategies
  //     await router.depositToBatch(busd.address, parseBusd("10000"), "");
  //     await router.allocateToStrategies();

  //     let totalShares = await sharesToken.totalSupply();
  //     expect(totalShares.toString()).to.be.closeTo(parseUniform("9960"), parseUniform("2"));

  //     let protocolShares = await sharesToken.balanceOf(admin.address);
  //     expect(protocolShares.toString()).to.be.equal(parseUniform("0"));

  //     const currentCycleId = ethers.BigNumber.from(
  // await provider.getStorageAt(router.address, 103)
  // );
  //     expect(currentCycleId.toString()).to.be.equal("1");

  //     // get struct data and check TVL at the end of cycle
  //     let cycleData = await router.getCycle(currentCycleId-1);

  //     expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10100"));
  //     expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9960"), parseUniform("2"));
  //     expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("9960"), parseUniform("2"));
  //     expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1"), parseUniform("0.01"));
  //   });

  //   describe("after first cycle", function () {
  //     beforeEach(async function () {
  //       await router.depositToBatch(busd.address, parseBusd("10000"), "");
  //       await router.allocateToStrategies();
  //     });

  //     it("should have no shares after the second cycle", async function () {
  //       // deposit to strategies
  //       await router.depositToBatch(busd.address, parseBusd("10000"), "");
  //       await router.allocateToStrategies();

  //       let totalShares = await sharesToken.totalSupply();
  //       expect(totalShares.toString()).to.be.closeTo(parseUniform("19780"), parseUniform("2"));

  //       let protocolShares = await sharesToken.balanceOf(admin.address);
  //       expect(protocolShares.toString()).to.be.equal(parseUniform("0"));

  //       const currentCycleId = ethers.BigNumber.from(
  // await provider.getStorageAt(router.address, 103)
  // );
  //       expect(currentCycleId.toString()).to.be.equal("2");

  //       // get struct data and check TVL at the end of cycle
  //       let cycleData = await router.getCycle(currentCycleId-1);

  //       expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("10100"));
  //       // received less (9920 vs 9960) than on the previous test
  //       // due to increased skew of stablecoin amounts in swap pools
  //       expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(parseUniform("9920"), parseUniform("3"));
  //       expect(cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd).to.be.closeTo(parseUniform("19980"), parseUniform("2"));
  //       expect(cycleData.pricePerShare).to.be.closeTo(parseUniform("1"), parseUniform("0.01"));
  //     });
  //   });
  // });

  describe("Stablecoin rate fluctuates", function () {
    beforeEach(async function () {
      await router.depositToBatch(busd.address, parseBusd("10000"), "");
      await router.allocateToStrategies();
    });

    describe("after first cycle when rate drops", function () {
      beforeEach(async function () {
        let busdAmount = parseBusd("0.95");
        await oracle.setPrice(busd.address, busdAmount);
      });

      it("Protocol should have no shares despite there was yield", async function () {
        // deposit to strategies
        await router.depositToBatch(busd.address, parseBusd("10000"), "");
        await router.allocateToStrategies();

        let totalShares = await sharesToken.totalSupply();
        expect(totalShares.toString()).to.be.closeTo(
          parseUniform("19780"),
          parseUniform("2")
        );

        let protocolShares = await sharesToken.balanceOf(admin.address);
        expect(protocolShares.toString()).to.be.equal(parseUniform("0"));

        const currentCycleId = ethers.BigNumber.from(
          await provider.getStorageAt(router.address, 103)
        );
        expect(currentCycleId.toString()).to.be.equal("2");

        // get struct data and check TVL at the end of cycle
        let cycleData = await router.getCycle(currentCycleId - 1);

        expect(cycleData.totalDepositedInUsd).to.be.equal(parseUniform("9500"));
        expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(
          parseUniform("9720"),
          parseUniform("3")
        );
        expect(
          cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
        ).to.be.closeTo(parseUniform("19575"), parseUniform("2"));
        expect(cycleData.pricePerShare).to.be.closeTo(
          parseUniform("0.99"),
          parseUniform("0.01")
        );
      });

      describe("after second cycle when rate pumps", function () {
        beforeEach(async function () {
          let busdAmount = parseBusd("1.05");
          await oracle.setPrice(busd.address, busdAmount);
        });

        it("Protocol should have shares when there was yield", async function () {
          // deposit to strategies
          let protocolSharesBefore = await sharesToken.balanceOf(admin.address);
          await router.depositToBatch(busd.address, parseBusd("10000"), "");
          await router.allocateToStrategies();

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.closeTo(
            parseUniform("19835"),
            parseUniform("3")
          );

          let protocolSharesAfter = await sharesToken.balanceOf(admin.address);

          let protocolSharesDiff =
            protocolSharesAfter.sub(protocolSharesBefore);
          expect(protocolSharesDiff.toString()).to.be.closeTo(
            parseUniform("27.5"),
            parseUniform("0.1")
          );

          const currentCycleId = ethers.BigNumber.from(
            await provider.getStorageAt(router.address, 103)
          );
          expect(currentCycleId.toString()).to.be.equal("2");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId - 1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(
            parseUniform("10500")
          );
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(
            parseUniform("10050"),
            parseUniform("2")
          );
          expect(
            cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
          ).to.be.closeTo(parseUniform("20245"), parseUniform("2"));
          expect(cycleData.pricePerShare).to.be.closeTo(
            parseUniform("1.02"),
            parseUniform("0.01")
          );
        });
      });
    });
  });

  describe("Protocol collects fee in shares", function () {
    it("should not have shares before first cycle", async function () {
      const currentCycleId = ethers.BigNumber.from(
        await provider.getStorageAt(router.address, 103)
      );
      expect(currentCycleId.toString()).to.be.equal("0");

      let totalShares = await sharesToken.totalSupply();
      expect(totalShares.toString()).to.be.equal("0");
    });

    it("should not have shares after first cycle", async function () {
      // deposit to strategies
      await router.depositToBatch(busd.address, parseBusd("10000"), "");
      await router.allocateToStrategies();

      let totalShares = await sharesToken.totalSupply();
      expect(totalShares.toString()).to.be.closeTo(
        parseUniform("9960"),
        parseUniform("2")
      );

      let protocolShares = await sharesToken.balanceOf(admin.address);
      expect(protocolShares.toString()).to.be.equal("0");
    });

    describe("after first cycle", function () {
      beforeEach(async function () {
        await router.depositToBatch(busd.address, parseBusd("10000"), "");
        await router.allocateToStrategies();
      });

      it("should have no shares if there was no yield", async function () {
        const [strategiesData] = await router.getStrategies();

        for (i = 0; i < strategiesData.length; i++) {
          let strategyContract = await ethers.getContractAt(
            "MockStrategy",
            strategiesData[i][0]
          );
          await strategyContract.setMockProfitPercent(0);
        }

        // deposit to strategies
        await router.depositToBatch(busd.address, parseBusd("10000"), "");
        await router.allocateToStrategies();

        let totalShares = await sharesToken.totalSupply();
        expect(totalShares.toString()).to.be.closeTo(
          parseUniform("19880"),
          parseUniform("2")
        );

        let protocolShares = await sharesToken.balanceOf(admin.address);
        expect(protocolShares.toString()).to.be.equal("0");

        const currentCycleId = ethers.BigNumber.from(
          await provider.getStorageAt(router.address, 103)
        );
        expect(currentCycleId.toString()).to.be.equal("2");

        // get struct data and check TVL at the end of cycle
        let cycleData = await router.getCycle(currentCycleId - 1);

        expect(cycleData.totalDepositedInUsd).to.be.equal(
          parseUniform("10100")
        );
        expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(
          parseUniform("9920"),
          parseUniform("3")
        );
        expect(
          cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
        ).to.be.closeTo(parseUniform("19880"), parseUniform("2"));
        expect(cycleData.pricePerShare).to.be.closeTo(
          parseUniform("1"),
          parseUniform("0.01")
        );
      });

      it("should have shares if there was yield", async function () {
        // deposit to strategies
        await router.depositToBatch(busd.address, parseBusd("10000"), "");
        await router.allocateToStrategies();

        let totalShares = await sharesToken.totalSupply();
        expect(totalShares.toString()).to.be.closeTo(
          parseUniform("19805"),
          parseUniform("2")
        );

        let protocolShares = await sharesToken.balanceOf(admin.address);
        expect(protocolShares.toString()).to.be.closeTo(
          parseUniform("11.8"),
          parseUniform("0.1")
        );

        const currentCycleId = ethers.BigNumber.from(
          await provider.getStorageAt(router.address, 103)
        );
        expect(currentCycleId.toString()).to.be.equal("2");

        // get struct data and check TVL at the end of cycle
        let cycleData = await router.getCycle(currentCycleId - 1);

        expect(cycleData.totalDepositedInUsd).to.be.equal(
          parseUniform("10100")
        );
        expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(
          parseUniform("9920"),
          parseUniform("3")
        );
        expect(
          cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
        ).to.be.closeTo(parseUniform("19980"), parseUniform("2"));
        expect(cycleData.pricePerShare).to.be.closeTo(
          parseUniform("1"),
          parseUniform("0.01")
        );
      });

      describe("after second cycle", function () {
        beforeEach(async function () {
          await router.depositToBatch(busd.address, parseBusd("10000"), "");
          await router.allocateToStrategies();
        });

        it("should decrease previous cycle's strategies balance on withdrawal", async function () {
          let receiptIds = [1];
          let shares = await router.calculateSharesFromReceipts(receiptIds);
          let sharesValueUsd = await router.calculateSharesUsdValue(shares);
          let minExpectedWithdrawAmount = applySlippageInBps(
            await convertFromUsdToTokenAmount(oracle, busd, sharesValueUsd),
            700 // 7% slippage
          );
          await router.withdrawFromStrategies(
            receiptIds,
            busd.address,
            shares,
            minExpectedWithdrawAmount,
            false
          );

          let totalShares = await sharesToken.totalSupply();
          expect(totalShares.toString()).to.be.closeTo(
            parseUniform("9973"),
            parseUniform("2")
          );

          let protocolShares = await sharesToken.balanceOf(admin.address);
          expect(protocolShares.toString()).to.be.closeTo(
            parseUniform("11.8"),
            parseUniform("0.1")
          );

          const currentCycleId = ethers.BigNumber.from(
            await provider.getStorageAt(router.address, 103)
          );
          expect(currentCycleId.toString()).to.be.equal("2");

          // get struct data and check TVL at the end of cycle
          let cycleData = await router.getCycle(currentCycleId - 1);

          expect(cycleData.totalDepositedInUsd).to.be.equal(
            parseUniform("10100")
          );
          expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(
            parseUniform("9920"),
            parseUniform("3")
          );
          expect(
            cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
          ).to.be.closeTo(parseUniform("10060"), parseUniform("2"));
          expect(cycleData.pricePerShare).to.be.closeTo(
            parseUniform("1"),
            parseUniform("0.01")
          );
        });

        describe("after withdraw", function () {
          beforeEach(async function () {
            let receiptIds = [1];
            let shares = await router.calculateSharesFromReceipts(receiptIds);
            let sharesValueUsd = await router.calculateSharesUsdValue(shares);
            let minExpectedWithdrawAmount = applySlippageInBps(
              await convertFromUsdToTokenAmount(oracle, busd, sharesValueUsd),
              700 // 7% slippage
            );
            await router.withdrawFromStrategies(
              receiptIds,
              busd.address,
              shares,
              minExpectedWithdrawAmount,
              false
            );
          });

          it("should have shares if there was yield", async function () {
            let protocolSharesBefore = await sharesToken.balanceOf(
              admin.address
            );

            await router.depositToBatch(busd.address, parseBusd("10000"), "");
            await router.allocateToStrategies();

            let totalShares = await sharesToken.totalSupply();
            expect(totalShares.toString()).to.be.closeTo(
              parseUniform("19730"),
              parseUniform("2")
            );

            let protocolSharesAfter = await sharesToken.balanceOf(
              admin.address
            );

            let protocolSharesDiff =
              protocolSharesAfter.sub(protocolSharesBefore);
            expect(protocolSharesDiff.toString()).to.be.closeTo(
              parseUniform("11.80"),
              parseUniform("0.1")
            );

            const currentCycleId = ethers.BigNumber.from(
              await provider.getStorageAt(router.address, 103)
            );
            expect(currentCycleId.toString()).to.be.equal("3");

            // get struct data and check TVL at the end of cycle
            let cycleData = await router.getCycle(currentCycleId - 1);

            expect(cycleData.totalDepositedInUsd).to.be.equal(
              parseUniform("10100")
            );
            expect(cycleData.receivedByStrategiesInUsd).to.be.closeTo(
              parseUniform("9917"),
              parseUniform("2")
            );
            expect(
              cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
            ).to.be.closeTo(parseUniform("20079"), parseUniform("3"));
            expect(cycleData.pricePerShare).to.be.closeTo(
              parseUniform("1"),
              parseUniform("0.02")
            );
          });
        });
      });
    });
  });
});
