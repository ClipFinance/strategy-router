const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { BigNumber } = require("ethers");

describe("Test StrategyRouter.withdrawFromStrategies reverts", function () {
  async function loadState(rateCoefBps = 0) {
    const [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    const { router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore();

    // deploy mock tokens
    const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens();

    const { exchangePlugin: fakeExchangePlugin } = await setupFakeExchangePlugin(
      oracle,
      0, // 0% slippage,
      25 // fee %0.25
    );
    mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc('10000000'));
    mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt('10000000'));
    mintFakeToken(fakeExchangePlugin.address, busd, parseBusd('10000000'));

    // setup params for testing
    await setupTestParams(router, oracle, exchange, usdc, usdt, busd, fakeExchangePlugin);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("10000000"));
    await usdc.approve(router.address, parseUsdc("10000000"));
    await usdt.approve(router.address, parseUsdt("10000000"));

    // setup supported tokens
    await router.setSupportedToken(usdc.address, true);
    await router.setSupportedToken(busd.address, true);
    await router.setSupportedToken(usdt.address, true);

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin
    }
  }

  describe("when withdraw from a single strategy", async function () {
    it('receive more tokens than sold', async function() {
      const { router, oracle, busd, parseBusd, usdc, parseUsdc, batch } = await loadFixture(loadState);
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
      });

      // set 1 USDC = 0.95 BUSD
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("0.95"));

      await router.depositToBatch(busd.address, parseBusd("100"));

      // to sell[busd] = 100
      // to buy[usdc] = 100
      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const strategies = await router.getStrategies();
      const strategyBalanceUsdc = await usdc.balanceOf(strategies[0][0]);

      expect(strategyBalanceUsdc).to.be.closeTo(parseUsdc('105'), parseUsdc('0.5'));
    });
    describe('no remnants in Batch verification', async function () {
      describe('swaps occurs on rebalance', async function () {
        it('strategy token rate > deposit token rates', async function() {
          const {
            router, oracle, batch,
            busd, parseBusd,
            usdc, parseUsdc,
            usdt, parseUsdt,
          } = await loadFixture(loadState);
          await deployFakeUnderFulfilledWithdrawalStrategy({
            router,
            token: usdc,
            underFulfilledWithdrawalBps: 0,
          });

          // set 1 USDC = 0.95 BUSD
          // set 1 USDC = 0.95 USDT
          await oracle.setPrice(busd.address, parseBusd("1"));
          await oracle.setPrice(usdt.address, parseUsdt("1"));
          await oracle.setPrice(usdc.address, parseUsdc("0.95"));

          await router.depositToBatch(busd.address, parseBusd("100"));
          await router.depositToBatch(usdt.address, parseUsdt("100"));

          // to sell[busd] = 100
          // to sell[usdt] = 100
          // to buy[usdc] = 200
          // after the first iteration USDC really bought is 100 / 0.95 = 105.2631
          // BUT buy[usdc] MUST be 200-100 = 100 to avoid leftovers
          await router.allocateToStrategies();

          expect(
            await busd.balanceOf(batch.address)
          ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
          expect(
            await usdt.balanceOf(batch.address)
          ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
          expect(
            await usdc.balanceOf(batch.address)
          ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        });
        it('strategy token rate < deposit token rates', async function() {
          const {
            router, oracle, batch,
            busd, parseBusd,
            usdc, parseUsdc,
            usdt, parseUsdt,
          } = await loadFixture(loadState);
          await deployFakeUnderFulfilledWithdrawalStrategy({
            router,
            token: usdc,
            underFulfilledWithdrawalBps: 0,
          });

          // set 1 USDC = 0.95 BUSD
          // set 1 USDC = 0.95 USDT
          await oracle.setPrice(busd.address, parseBusd("1"));
          await oracle.setPrice(usdt.address, parseUsdt("1"));
          await oracle.setPrice(usdc.address, parseUsdc("1.05"));

          await router.depositToBatch(busd.address, parseBusd("100"));
          await router.depositToBatch(usdt.address, parseUsdt("100"));

          // to sell[busd] = 100
          // to sell[usdt] = 100
          // to buy[usdc] = 200
          // after the first iteration USDC really bought is 100 / 0.95 = 105.2631
          // BUT buy[usdc] MUST be 200-100 = 100 to avoid leftovers
          await router.allocateToStrategies();

          expect(
            await busd.balanceOf(batch.address)
          ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
          expect(
            await usdt.balanceOf(batch.address)
          ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
          expect(
            await usdc.balanceOf(batch.address)
          ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        });
      });
      describe('strategy desired balance below swap threshold', async function () {
        describe('2 strategies, strategy in question goes last', async function () {
          it('strategy tokens and deposit tokens are same', async function () {
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
            } = await loadFixture(loadState);

            const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 9950,
            });
            const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 50,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            expect(
              await busd.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdt.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdc.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

            expect(
              await busd.balanceOf(strategy1.address)
            ).to.be.closeTo(parseBusd("10"), parseBusd("0.1"));
            expect(
              await busd.balanceOf(strategy2.address)
            ).to.be.closeTo(parseBusd("0"), parseBusd("0"));
          });
          it('strategy tokens and deposit tokens are different', async function () {
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
            } = await loadFixture(loadState);

            const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: usdc,
              underFulfilledWithdrawalBps: 0,
              weight: 9950,
            });
            const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: usdc,
              underFulfilledWithdrawalBps: 0,
              weight: 50,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            // 1 BUSD = 1 USDC
            await oracle.setPrice(busd.address, parseBusd("1"));
            await oracle.setPrice(usdc.address, parseUsdc("1"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            expect(
              await busd.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdt.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdc.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

            expect(
              await usdc.balanceOf(strategy1.address)
            ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
            expect(
              await usdc.balanceOf(strategy2.address)
            ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
          });
        });
        describe('2 strategies, strategy in question goes first', async function () {
          it('strategy tokens and deposit tokens are same', async function () {
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
            } = await loadFixture(loadState);

            const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 50,
            });
            const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 9950,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            expect(
              await busd.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdt.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdc.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

            expect(
              await busd.balanceOf(strategy1.address)
            ).to.be.closeTo(parseBusd("0"), parseBusd("0"));
            expect(
              await busd.balanceOf(strategy2.address)
            ).to.be.closeTo(parseBusd("10"), parseBusd("0.1"));
          });
          it('strategy tokens and deposit tokens are different', async function () {
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
            } = await loadFixture(loadState);

            const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: usdc,
              underFulfilledWithdrawalBps: 0,
              weight: 50,
            });
            const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: usdc,
              underFulfilledWithdrawalBps: 0,
              weight: 9950,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            // 1 BUSD = 1 USDC
            await oracle.setPrice(busd.address, parseBusd("1"));
            await oracle.setPrice(usdc.address, parseUsdc("1"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            expect(
              await busd.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdt.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
            expect(
              await usdc.balanceOf(batch.address)
            ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

            expect(
              await usdc.balanceOf(strategy1.address)
            ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
            expect(
              await usdc.balanceOf(strategy2.address)
            ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
          });
        });
        describe('3 strategies, strategy in question goes in between', async function () {
          it('same tokens', async function() {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
            } = await loadFixture(loadState);

            const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 4975,
            });
            const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 50,
            });
            const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 4975,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            expect(
              await usdt.balanceOf(batch.address)
            ).to.be.equal(BigNumber.from(0));
            expect(
              await busd.balanceOf(batch.address)
            ).to.be.equal(BigNumber.from(0));
            expect(
              await usdc.balanceOf(batch.address)
            ).to.be.equal(BigNumber.from(0));

            expect(
              await busd.balanceOf(strategy1.address)
            ).to.be.closeTo(parseBusd("5"), parseBusd("0.1"));
            expect(
              await busd.balanceOf(strategy2.address)
            ).to.be.closeTo(parseBusd("0"), parseBusd("0"));
            expect(
              await busd.balanceOf(strategy3.address)
            ).to.be.closeTo(parseBusd("5"), parseBusd("0.1"));
          });
          it('different tokens', async function() {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
            } = await loadFixture(loadState);

            const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: usdc,
              underFulfilledWithdrawalBps: 0,
              weight: 4975,
            });
            const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 50,
            });
            const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
              router,
              token: busd,
              underFulfilledWithdrawalBps: 0,
              weight: 4975,
            });

            await router.depositToBatch(usdt.address, parseUsdt("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            expect(
              await usdt.balanceOf(batch.address)
            ).to.be.equal(BigNumber.from(0));
            expect(
              await busd.balanceOf(batch.address)
            ).to.be.equal(BigNumber.from(0));
            expect(
              await usdc.balanceOf(batch.address)
            ).to.be.equal(BigNumber.from(0));

            expect(
              await usdc.balanceOf(strategy1.address)
            ).to.be.closeTo(parseUsdc("5"), parseUsdc("0.1"));
            expect(
              await busd.balanceOf(strategy2.address)
            ).to.be.closeTo(parseBusd("0"), parseBusd("0"));
            expect(
              await busd.balanceOf(strategy3.address)
            ).to.be.closeTo(parseBusd("5"), parseBusd("0.1"));
          });
        });
        describe('2 of 3 strategies desired balances below swap threshold', async function () {
          describe('strategy tokens and deposit tokens are same', async function () {
            it('below, below, above', async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 9900,
              });

              await router.depositToBatch(usdc.address, parseUsdc("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await busd.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

              expect(
                await usdc.balanceOf(strategy1.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy2.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy3.address)
              ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
            });
            it('below, above, below', async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 9900,
              });
              const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });

              await router.depositToBatch(usdc.address, parseUsdc("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await busd.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

              expect(
                await usdc.balanceOf(strategy1.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy2.address)
              ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
              expect(
                await usdc.balanceOf(strategy3.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
            });
            it('above, below, below', async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 9900,
              });
              const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });

              await router.depositToBatch(usdc.address, parseUsdc("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await busd.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

              expect(
                await usdc.balanceOf(strategy1.address)
              ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
              expect(
                await usdc.balanceOf(strategy2.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy3.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
            });
          });
          describe('strategy tokens and deposit tokens are different', async function () {
            it('below, below, above', async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 9900,
              });

              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await busd.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

              expect(
                await usdc.balanceOf(strategy1.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy2.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy3.address)
              ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
            });
            it('below, above, below', async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 9900,
              });
              const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });

              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await busd.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

              expect(
                await usdc.balanceOf(strategy1.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy2.address)
              ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
              expect(
                await usdc.balanceOf(strategy3.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
            });
            it('above, below, below', async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 9900,
              });
              const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });
              const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdc,
                underFulfilledWithdrawalBps: 0,
                weight: 50,
              });

              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await busd.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

              expect(
                await usdc.balanceOf(strategy1.address)
              ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
              expect(
                await usdc.balanceOf(strategy2.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
              expect(
                await usdc.balanceOf(strategy3.address)
              ).to.be.closeTo(parseUsdc("0"), parseUsdc("0"));
            });
          });
        });
      });
    });
    describe(
      'test desired balance vs token available balance comparisons',
      async function () {
        describe('desired balance > token balance, delta less than swap threshold', async function () {
          it(
            'tokens are same',
            async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 50_000_000_100,
              });
              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 49_999_999_900,
              });

              await router.depositToBatch(usdt.address, parseUsdt("10"));
              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await busd.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
            }
          );
          it(
            'tokens are different',
            async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              oracle.setPrice(busd.address, parseBusd("1"));
              oracle.setPrice(usdc.address, parseUsdc("1"));
              oracle.setPrice(usdt.address, parseUsdt("1"));

              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 50_000_000_100,
              });
              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 49_999_999_900,
              });

              await router.depositToBatch(usdc.address, parseUsdc("10"));
              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await busd.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
            }
          );
        });
        describe('desired balance < token balance, delta less than swap threshold', async function () {
          it(
            'tokens are same',
            async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 49_999_999_900,
              });
              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 50_000_000_100,
              });

              await router.depositToBatch(usdt.address, parseUsdt("10"));
              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await busd.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
            }
          );
          it(
            'tokens are different',
            async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              oracle.setPrice(busd.address, parseBusd("1"));
              oracle.setPrice(usdc.address, parseUsdc("1"));
              oracle.setPrice(usdt.address, parseUsdt("1"));

              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 49_999_999_900,
              });
              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 50_000_000_100,
              });

              await router.depositToBatch(usdc.address, parseUsdc("10"));
              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await busd.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
            }
          );
        });
        describe('desired balance < token balance, delta higher than swap threshold', async function () {
          it(
            'tokens are same',
            async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 51_000_000_000,
              });
              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 49_000_000_000,
              });

              await router.depositToBatch(usdt.address, parseUsdt("10"));
              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await busd.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
            }
          );
          it(
            'tokens are different',
            async function () {
              // order of tokens usdc -> busd -> usdt
              const {
                router, oracle, batch,
                busd, parseBusd,
                usdc, parseUsdc,
                usdt, parseUsdt,
                fakeExchangePlugin,
              } = await loadFixture(loadState);

              oracle.setPrice(busd.address, parseBusd("1"));
              oracle.setPrice(usdc.address, parseUsdc("1"));
              oracle.setPrice(usdt.address, parseUsdt("1"));

              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 51_000_000_000,
              });
              await deployFakeUnderFulfilledWithdrawalStrategy({
                router,
                token: usdt,
                underFulfilledWithdrawalBps: 0,
                weight: 49_000_000_000,
              });

              await router.depositToBatch(usdc.address, parseUsdc("10"));
              await router.depositToBatch(busd.address, parseBusd("10"));

              await expect(router.allocateToStrategies()).not.to.be.reverted;

              expect(
                await usdt.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await usdc.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
              expect(
                await busd.balanceOf(batch.address)
              ).to.be.equal(BigNumber.from(0));
            }
          );
        });
      }
    );
    describe('swap optimisation', async function () {
      it('test no swap occurs', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy4 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("100"));
        await router.depositToBatch(busd.address, parseBusd("100"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(0);

        expect(
          await busd.balanceOf(strategy1.address)
        ).to.be.closeTo(parseBusd("50"), parseBusd("0.5"));
        expect(
          await usdc.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdc("50"), parseUsdc("0.5"));
        expect(
          await usdc.balanceOf(strategy3.address)
        ).to.be.closeTo(parseUsdc("50"), parseUsdc("0.5"));
        expect(
          await busd.balanceOf(strategy4.address)
        ).to.be.closeTo(parseBusd("50"), parseBusd("0.5"));
      });
      it('test exactly 1 swap occurs', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy4 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(usdc.address, parseUsdc("50"));
        await router.depositToBatch(busd.address, parseBusd("150"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(1);

        expect(
          await busd.balanceOf(strategy1.address)
        ).to.be.closeTo(parseBusd("50"), parseBusd("0.5"));
        expect(
          await usdc.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdc("50"), parseUsdc("0.5"));
        expect(
          await usdc.balanceOf(strategy3.address)
        ).to.be.closeTo(parseUsdc("50"), parseUsdc("0.5"));
        expect(
          await busd.balanceOf(strategy4.address)
        ).to.be.closeTo(parseBusd("50"), parseBusd("0.5"));
      });
    });
    describe('audit issue', async function () {
      /**
       * Test for issues with rebalance abruption in the former Batch.rabance script
       * https://github.com/ClipFinance/StrategyRouter-private/blob/2c5827b8fa64c0142b07c75e4014e083ffdb72bd/contracts/Batch.sol
       *
       * uint256 curSell = toSellUniform > toBuyUniform
       *     ? changeDecimals(toBuyUniform, UNIFORM_DECIMALS, ERC20(sellToken).decimals())
       *     : toSell[i];
       *
       * // no need to swap small amounts
       * if (toUniform(curSell, sellToken) < REBALANCE_SWAP_THRESHOLD) {
       *     toSell[i] = 0;
       *     toBuy[j] -= changeDecimals(curSell, ERC20(sellToken).decimals(), ERC20(buyToken).decimals());
       *     break;
       * }
       */
      it('test before audit fix failure - different deposit / strategy coins', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 50,
        });
        await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 9950,
        });

        await router.depositToBatch(usdc.address, parseUsdc("10"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
      });
      it('test before audit fix failure - same deposit / strategy coins', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 50,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 50,
        });
        const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: busd,
          underFulfilledWithdrawalBps: 0,
          weight: 9900,
        });

        await router.depositToBatch(busd.address, parseBusd("10"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await busd.balanceOf(strategy1.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await busd.balanceOf(strategy2.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await busd.balanceOf(strategy3.address)
        ).to.be.closeTo(parseBusd("10"), BigNumber.from(0));
      });
    });
    describe('test unoptimal orders of tokens and strategies', async function() {
      it('small deposits', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        // oracle.setPrice(busd.address, parseBusd("1"));
        // oracle.setPrice(usdc.address, parseUsdc("1"));
        // oracle.setPrice(usdt.address, parseUsdt("1"));

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 1000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 4000,
        });
        const strategy4 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 3000,
        });
        const strategy5 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 11000,
        });
        const strategy6 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 1000,
        });

        await router.depositToBatch(busd.address, parseBusd("15"));
        await router.depositToBatch(usdt.address, parseUsdt("7.5"));
        await router.depositToBatch(usdc.address, parseUsdc("2.5"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(parseUsdt("1"), parseUsdt("0.1"));
        expect(
          await usdc.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdc("5"), parseUsdc("0.1"));
        expect(
          await usdc.balanceOf(strategy3.address)
        ).to.be.closeTo(parseUsdc("4"), parseUsdc("0.1"));
        expect(
          await usdt.balanceOf(strategy4.address)
        ).to.be.closeTo(parseUsdt("3"), parseUsdt("0.1"));
        expect(
          await usdc.balanceOf(strategy5.address)
        ).to.be.closeTo(parseUsdc("11"), parseUsdc("0.1"));
        expect(
          await usdt.balanceOf(strategy6.address)
        ).to.be.closeTo(parseUsdt("1"), parseUsdt("0.1"));
      });
      it('very large deposits', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        // oracle.setPrice(busd.address, parseBusd("1"));
        // oracle.setPrice(usdc.address, parseUsdc("1"));
        // oracle.setPrice(usdt.address, parseUsdt("1"));

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 1000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 4000,
        });
        const strategy4 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 3000,
        });
        const strategy5 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdc,
          underFulfilledWithdrawalBps: 0,
          weight: 11000,
        });
        const strategy6 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 1000,
        });

        await router.depositToBatch(busd.address, parseBusd((1_500_000).toString()));
        await router.depositToBatch(usdt.address, parseUsdt((750_000).toString()));
        await router.depositToBatch(usdc.address, parseUsdc((250_000).toString()));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(
          parseUsdt((100_000).toString()),
          parseUsdt((1_000).toString())
        );
        expect(
          await usdc.balanceOf(strategy2.address)
        ).to.be.closeTo(
          parseUsdc((500_000).toString()),
          parseUsdc((5_000).toString())
        );
        expect(
          await usdc.balanceOf(strategy3.address)
        ).to.be.closeTo(
          parseUsdc((400_000).toString()),
          parseUsdc((4_000).toString())
        );
        expect(
          await usdt.balanceOf(strategy4.address)
        ).to.be.closeTo(
          parseUsdt((300_000).toString()),
          parseUsdt((3_000).toString())
        );
        expect(
          await usdc.balanceOf(strategy5.address)
        ).to.be.closeTo(
          parseUsdc((1_100_000).toString()),
          parseUsdc((11_000).toString())
        );
        expect(
          await usdt.balanceOf(strategy6.address)
        ).to.be.closeTo(
          parseUsdt((100_000).toString()),
          parseUsdt((1_000).toString())
        );
      });
    });
    describe('strategy weight manipulation works as intended', async function () {
      it('1', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(usdt.address, parseUsdt("4"));
        await router.depositToBatch(busd.address, parseBusd("6"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
        expect(
          await usdt.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
      });
      it('2', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(usdt.address, parseUsdt("6"));
        await router.depositToBatch(busd.address, parseBusd("4"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
        expect(
          await usdt.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
      });
      it('3', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(usdt.address, parseUsdt("5"));
        await router.depositToBatch(busd.address, parseBusd("5"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
        expect(
          await usdt.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
      });
      it('4', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(usdt.address, parseUsdt("10"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
        expect(
          await usdt.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
      });
      it('5', async function () {
        // order of tokens usdc -> busd -> usdt
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          fakeExchangePlugin,
        } = await loadFixture(loadState);

        const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });
        const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
          router,
          token: usdt,
          underFulfilledWithdrawalBps: 0,
          weight: 5000,
        });

        await router.depositToBatch(busd.address, parseBusd("10"));

        await expect(router.allocateToStrategies()).not.to.be.reverted;

        expect(
          await busd.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdc.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
        expect(
          await usdt.balanceOf(batch.address)
        ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

        expect(
          await usdt.balanceOf(strategy1.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
        expect(
          await usdt.balanceOf(strategy2.address)
        ).to.be.closeTo(parseUsdt("5"), parseUsdt("0.1"));
      });
    });
    it('test where old algo would execute good', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
      } = await loadFixture(loadState);

      const strategy1 = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });
      const strategy2 = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });
      const strategy3 = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdt,
        underFulfilledWithdrawalBps: 0,
        weight: 5000,
      });

      await router.depositToBatch(busd.address, parseBusd("10"));
      await router.depositToBatch(usdc.address, parseUsdc("10"));
      await router.depositToBatch(usdt.address, parseUsdt("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      expect(
        await busd.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
      expect(
        await usdc.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
      expect(
        await usdt.balanceOf(batch.address)
      ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));

      expect(
        await busd.balanceOf(strategy1.address)
      ).to.be.closeTo(parseBusd("10"), parseBusd("0.1"));
      expect(
        await usdc.balanceOf(strategy2.address)
      ).to.be.closeTo(parseUsdc("10"), parseUsdc("0.1"));
      expect(
        await usdt.balanceOf(strategy3.address)
      ).to.be.closeTo(parseUsdt("10"), parseUsdt("0.1"));
    });
  });
});