const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { BigNumber, FixedNumber } = require("ethers");
const { constants } = require("@openzeppelin/test-helpers");

async function expectNoRemnantsFn(contract, busd, usdc, usdt) {
  expect(
    await busd.balanceOf(contract.address)
  ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
  expect(
    await usdc.balanceOf(contract.address)
  ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
  expect(
    await usdt.balanceOf(contract.address)
  ).to.be.closeTo(BigNumber.from(0), BigNumber.from(0));
}

async function expectStrategiesHoldCorrectBalances(depositAmount, ...strategies) {
  const totalValueUsd = BigNumber
    .from(depositAmount)
    .mul(BigNumber.from(10).pow(18));

  const allStrategiesWeightSum = strategies
      .reduce((totalWeight, strategy) => totalWeight + strategy.weight, 0)
  ;
  for (const strategyIndex of strategies.keys()) {
    const strategy = strategies[strategyIndex];

    const expectedBalanceUniform = totalValueUsd
      .mul(strategy.weight)
      .div(allStrategiesWeightSum);
    const expectedBalance = expectedBalanceUniform
      .div(BigNumber.from(10).pow(18 - strategy.token.decimalNumber));

    // 2%
    const expectedBalanceDeviation = expectedBalance
      .mul(2)
      .div(100);

    const strategyTokenBalance = await strategy.token.balanceOf(strategy.address);

    expect(
      strategyTokenBalance,
      `Strategy${strategyIndex + 1} has balance ${strategyTokenBalance}`
      + ` while was expected ${expectedBalance} +/- ${expectedBalanceDeviation}`,
    ).to.be.closeTo(
      expectedBalance,
      expectedBalanceDeviation,
    )
  }
}

async function expectStrategyHoldsExactBalances(
  strategy,
  expectedBalanceFullUnits,
  deviationPercent = 1
) {
  const expectedBalance = BigNumber
    .from(
      FixedNumber
        .from(expectedBalanceFullUnits)
        .mulUnsafe(
          FixedNumber.from(
            BigNumber.from(10).pow(strategy.token.decimalNumber)
          )
        )
        .toFormat({decimals: 0})
        .toString()
    );

  const expectedBalanceDeviation = expectedBalance
    .mul(deviationPercent)
    .div(100);

  const strategyTokenBalance = await strategy.token.balanceOf(strategy.address);

  expect(
    strategyTokenBalance,
    `Strategy has balance ${strategyTokenBalance}`
    + ` while was expected ${expectedBalance} +/- ${expectedBalanceDeviation}`,
  ).to.be.closeTo(
    expectedBalance,
    expectedBalanceDeviation,
  );
}

describe("Test Batch.rebalance in algorithm-specific manner", function () {
  async function loadState(feeBps = 25) {
    const [owner, nonReceiptOwner] = await ethers.getSigners();

    // deploy core contracts
    const { router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore();

    // deploy mock tokens
    const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(router);

    const { exchangePlugin: fakeExchangePlugin } = await setupFakeExchangePlugin(
      oracle,
      0, // 0% slippage,
      feeBps // fee %0.25
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
    await router.addSupportedToken(usdc);
    await router.addSupportedToken(busd);
    await router.addSupportedToken(usdt);

    const expectNoRemnants = async function (contract) {
      await expectNoRemnantsFn(contract, busd, usdc, usdt);
    };

    const deployStrategy = async function ({token, weight = 10_000}) {
      const strategy = await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token,
        underFulfilledWithdrawalBps: 0,
        weight,
      });
      strategy.token = token;
      strategy.weight = weight;

      return strategy;
    };

    return {
      owner, nonReceiptOwner,
      router, oracle, exchange, batch, receiptContract, sharesToken,
      usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
      fakeExchangePlugin,
      expectNoRemnants, deployStrategy
    }
  }

  async function loadStateWithZeroBps() {
    return await loadState(0);
  }

  describe('token amounts allocated to strategies follow exchange rates correctly', async function () {
    it('when deposit token rate < strategy token rate then receive more tokens than sold', async function() {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdc,
      });

      // set 1 USDC = 0.95 BUSD
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdc.address, parseUsdc("0.95"));

      await router.depositToBatch(busd.address, parseBusd("100"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategyHoldsExactBalances(strategy1, 105);
    });
    it('when deposit token rate > strategy token rate then receive more tokens than sold', async function() {
      const {
        router, oracle,
        busd, parseBusd,
        usdc, parseUsdc,
        batch,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdc,
      });

      // set 1 USDC = 0.95 BUSD
      await oracle.setPrice(busd.address, parseBusd("0.95"));
      await oracle.setPrice(usdc.address, parseUsdc("1"));

      await router.depositToBatch(busd.address, parseBusd("100"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategyHoldsExactBalances(strategy1, 95);
    });
  });
  describe('no remnants in Batch verification', async function () {
    describe('swaps occurs on rebalance', async function () {
      it('strategy token rate > deposit token rates', async function() {
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
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

        await expectNoRemnants(batch);
        await expectStrategyHoldsExactBalances(strategy1, 210);
      });
      it('strategy token rate < deposit token rates', async function() {
        const {
          router, oracle, batch,
          busd, parseBusd,
          usdc, parseUsdc,
          usdt, parseUsdt,
          expectNoRemnants, deployStrategy
        } = await loadFixture(loadState);

        const strategy1 = await deployStrategy({
          token: usdc,
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

        await expectNoRemnants(batch);
        await expectStrategyHoldsExactBalances(strategy1, 190);
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
            expectNoRemnants, deployStrategy
          } = await loadFixture(loadState);

          const strategy1 = await deployStrategy({
            token: busd,
            weight: 9950,
          });
          const strategy2 = await deployStrategy({
            token: busd,
            weight: 50,
          });

          await router.depositToBatch(busd.address, parseBusd("10"));

          await expect(router.allocateToStrategies()).not.to.be.reverted;

          await expectNoRemnants(batch);

          await expectStrategyHoldsExactBalances(strategy1, 10);
          await expectStrategyHoldsExactBalances(strategy2, 0);
        });
        it('strategy tokens and deposit tokens are different', async function () {
          const {
            router, oracle, batch,
            busd, parseBusd,
            usdc, parseUsdc,
            usdt, parseUsdt,
            expectNoRemnants, deployStrategy
          } = await loadFixture(loadState);

          const strategy1 = await deployStrategy({
            token: usdc,
            weight: 9950,
          });
          const strategy2 = await deployStrategy({
            token: usdc,
            weight: 50,
          });

          await router.depositToBatch(busd.address, parseBusd("10"));

          // 1 BUSD = 1 USDC
          await oracle.setPrice(busd.address, parseBusd("1"));
          await oracle.setPrice(usdc.address, parseUsdc("1"));

          await expect(router.allocateToStrategies()).not.to.be.reverted;

          await expectNoRemnants(batch);

          await expectStrategyHoldsExactBalances(strategy1, 10);
          await expectStrategyHoldsExactBalances(strategy2, 0);
        });
      });
      describe('2 strategies, strategy in question goes first', async function () {
        it('strategy tokens and deposit tokens are same', async function () {
          const {
            router, oracle, batch,
            busd, parseBusd,
            usdc, parseUsdc,
            usdt, parseUsdt,
            expectNoRemnants, deployStrategy
          } = await loadFixture(loadState);

          const strategy1 = await deployStrategy({
            token: busd,
            weight: 50,
          });
          const strategy2 = await deployStrategy({
            token: busd,
            weight: 9950,
          });

          await router.depositToBatch(busd.address, parseBusd("10"));

          await expect(router.allocateToStrategies()).not.to.be.reverted;

          await expectNoRemnants(batch);

          await expectStrategyHoldsExactBalances(strategy1, 0);
          await expectStrategyHoldsExactBalances(strategy2, 10);
        });
        it('strategy tokens and deposit tokens are different', async function () {
          const {
            router, oracle, batch,
            busd, parseBusd,
            usdc, parseUsdc,
            usdt, parseUsdt,
            expectNoRemnants, deployStrategy
          } = await loadFixture(loadState);

          const strategy1 = await deployStrategy({
            token: usdc,
            weight: 50,
          });
          const strategy2 = await deployStrategy({
            token: usdc,
            weight: 9950,
          });

          await router.depositToBatch(busd.address, parseBusd("10"));

          // 1 BUSD = 1 USDC
          await oracle.setPrice(busd.address, parseBusd("1"));
          await oracle.setPrice(usdc.address, parseUsdc("1"));

          await expect(router.allocateToStrategies()).not.to.be.reverted;

          await expectNoRemnants(batch);

          await expectStrategyHoldsExactBalances(strategy1, 0);
          await expectStrategyHoldsExactBalances(strategy2, 10);
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
            expectNoRemnants, deployStrategy
          } = await loadFixture(loadState);

          const strategy1 = await deployStrategy({
            token: busd,
            weight: 4975,
          });
          const strategy2 = await deployStrategy({
            token: busd,
            weight: 50,
          });
          const strategy3 = await deployStrategy({
            token: busd,
            weight: 4975,
          });

          await router.depositToBatch(busd.address, parseBusd("10"));

          await expect(router.allocateToStrategies()).not.to.be.reverted;

          await expectNoRemnants(batch);

          await expectStrategyHoldsExactBalances(strategy1, 5, 2);
          await expectStrategyHoldsExactBalances(strategy2, 0);
          await expectStrategyHoldsExactBalances(strategy3, 5, 2);
        });
        it('different tokens', async function() {
          // order of tokens usdc -> busd -> usdt
          const {
            router, oracle, batch,
            busd, parseBusd,
            usdc, parseUsdc,
            usdt, parseUsdt,
            fakeExchangePlugin,
            expectNoRemnants, deployStrategy
          } = await loadFixture(loadState);

          const strategy1 = await deployStrategy({
            token: usdc,
            weight: 4975,
          });
          const strategy2 = await deployStrategy({
            token: busd,
            weight: 50,
          });
          const strategy3 = await deployStrategy({
            token: busd,
            weight: 4975,
          });

          await router.depositToBatch(usdt.address, parseUsdt("10"));

          await expect(router.allocateToStrategies()).not.to.be.reverted;

          await expectNoRemnants(batch);

          await expectStrategyHoldsExactBalances(strategy1, 5, 2);
          await expectStrategyHoldsExactBalances(strategy2, 0);
          await expectStrategyHoldsExactBalances(strategy3, 5, 2);
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
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy2 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy3 = await deployStrategy({
              token: usdc,
              weight: 9900,
            });

            await router.depositToBatch(usdc.address, parseUsdc("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 0);
            await expectStrategyHoldsExactBalances(strategy2, 0);
            await expectStrategyHoldsExactBalances(strategy3, 10);
          });
          it('below, above, below', async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy2 = await deployStrategy({
              token: usdc,
              weight: 9900,
            });
            const strategy3 = await deployStrategy({
              token: usdc,
              weight: 50,
            });

            await router.depositToBatch(usdc.address, parseUsdc("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 0);
            await expectStrategyHoldsExactBalances(strategy2, 10);
            await expectStrategyHoldsExactBalances(strategy3, 0);
          });
          it('above, below, below', async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdc,
              weight: 9900,
            });
            const strategy2 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy3 = await deployStrategy({
              token: usdc,
              weight: 50,
            });

            await router.depositToBatch(usdc.address, parseUsdc("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 10);
            await expectStrategyHoldsExactBalances(strategy2, 0);
            await expectStrategyHoldsExactBalances(strategy3, 0);
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
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy2 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy3 = await deployStrategy({
              token: usdc,
              weight: 9900,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 0);
            await expectStrategyHoldsExactBalances(strategy2, 0);
            await expectStrategyHoldsExactBalances(strategy3, 10);
          });
          it('below, above, below', async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy2 = await deployStrategy({
              token: usdc,
              weight: 9900,
            });
            const strategy3 = await deployStrategy({
              token: usdc,
              weight: 50,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 0);
            await expectStrategyHoldsExactBalances(strategy2, 10);
            await expectStrategyHoldsExactBalances(strategy3, 0);
          });
          it('above, below, below', async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdc,
              weight: 9900,
            });
            const strategy2 = await deployStrategy({
              token: usdc,
              weight: 50,
            });
            const strategy3 = await deployStrategy({
              token: usdc,
              weight: 50,
            });

            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 10);
            await expectStrategyHoldsExactBalances(strategy2, 0);
            await expectStrategyHoldsExactBalances(strategy3, 0);
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
          'strategy token and deposit tokens are same',
          async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdt,
              weight: 50_000_000_100,
            });
            const strategy2 = await deployStrategy({
              token: usdt,
              weight: 49_999_999_900,
            });

            await router.depositToBatch(usdt.address, parseUsdt("10"));
            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);
            await expectStrategyHoldsExactBalances(strategy1, 10, 2);
            await expectStrategyHoldsExactBalances(strategy2, 10, 2);
          }
        );
        it(
          'strategy token and deposit tokens are different',
          async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            oracle.setPrice(busd.address, parseBusd("1"));
            oracle.setPrice(usdc.address, parseUsdc("1"));
            oracle.setPrice(usdt.address, parseUsdt("1"));

            const strategy1 = await deployStrategy({
              token: usdt,
              weight: 50_000_000_100,
            });
            const strategy2 = await deployStrategy({
              token: usdt,
              weight: 49_999_999_900,
            });

            await router.depositToBatch(usdc.address, parseUsdc("10"));
            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 10, 2);
            await expectStrategyHoldsExactBalances(strategy2, 10, 2);
          }
        );
      });
      describe('desired balance < token balance, delta less than swap threshold', async function () {
        it(
          'strategy token and deposit tokens are same',
          async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdt,
              weight: 49_999_999_900,
            });
            const strategy2 = await deployStrategy({
              token: usdt,
              weight: 50_000_000_100,
            });

            await router.depositToBatch(usdt.address, parseUsdt("10"));
            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);

            await expectStrategyHoldsExactBalances(strategy1, 10, 2);
            await expectStrategyHoldsExactBalances(strategy2, 10, 2);
          }
        );
        it(
          'strategy token and deposit tokens are different',
          async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            oracle.setPrice(busd.address, parseBusd("1"));
            oracle.setPrice(usdc.address, parseUsdc("1"));
            oracle.setPrice(usdt.address, parseUsdt("1"));

            const strategy1 = await deployStrategy({
              token: usdt,
              weight: 49_999_999_900,
            });
            const strategy2 = await deployStrategy({
              token: usdt,
              weight: 50_000_000_100,
            });

            await router.depositToBatch(usdc.address, parseUsdc("10"));
            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);
            await expectStrategiesHoldCorrectBalances(20, strategy1, strategy2);
          }
        );
      });
      describe('desired balance < token balance, delta higher than swap threshold', async function () {
        it(
          'strategy token and deposit tokens are same',
          async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            const strategy1 = await deployStrategy({
              token: usdt,
              weight: 51_000_000_000,
            });
            const strategy2 = await deployStrategy({
              token: usdt,
              weight: 49_000_000_000,
            });

            await router.depositToBatch(usdt.address, parseUsdt("10"));
            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);
            await expectStrategyHoldsExactBalances(strategy1, '10.2', 2);
            await expectStrategyHoldsExactBalances(strategy2, '9.8', 2);
          }
        );
        it(
          'strategy token and deposit tokens are different',
          async function () {
            // order of tokens usdc -> busd -> usdt
            const {
              router, oracle, batch,
              busd, parseBusd,
              usdc, parseUsdc,
              usdt, parseUsdt,
              fakeExchangePlugin,
              expectNoRemnants, deployStrategy
            } = await loadFixture(loadState);

            oracle.setPrice(busd.address, parseBusd("1"));
            oracle.setPrice(usdc.address, parseUsdc("1"));
            oracle.setPrice(usdt.address, parseUsdt("1"));

            const strategy1 = await deployStrategy({
              token: usdt,
              weight: 51_000_000_000,
            });
            const strategy2 = await deployStrategy({
              token: usdt,
              weight: 49_000_000_000,
            });

            await router.depositToBatch(usdc.address, parseUsdc("10"));
            await router.depositToBatch(busd.address, parseBusd("10"));

            await expect(router.allocateToStrategies()).not.to.be.reverted;

            await expectNoRemnants(batch);
            await expectStrategiesHoldCorrectBalances(20, strategy1, strategy2);
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
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: busd,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdc,
        weight: 5000,
      });
      const strategy3 = await deployStrategy({
        token: usdc,
        weight: 5000,
      });
      const strategy4 = await deployStrategy({
        token: busd,
        weight: 5000,
      });

      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.depositToBatch(busd.address, parseBusd("100"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);

      expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(0);
      await expectStrategiesHoldCorrectBalances(200, strategy1, strategy2, strategy3, strategy4);
    });
    it('test exactly 1 swap occurs', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: busd,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdc,
        weight: 5000,
      });
      const strategy3 = await deployStrategy({
        token: usdc,
        weight: 5000,
      });
      const strategy4 = await deployStrategy({
        token: busd,
        weight: 5000,
      });

      await router.depositToBatch(usdc.address, parseUsdc("50"));
      await router.depositToBatch(busd.address, parseBusd("150"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);

      expect(await fakeExchangePlugin.swapCallNumber()).to.be.equal(1);
      await expectStrategiesHoldCorrectBalances(200, strategy1, strategy2, strategy3, strategy4);
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
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: busd,
        weight: 50,
      });
      const strategy2 = await deployStrategy({
        token: busd,
        weight: 9950,
      });

      await router.depositToBatch(usdc.address, parseUsdc("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategyHoldsExactBalances(strategy1, 0);
      await expectStrategyHoldsExactBalances(strategy2, 10, 2);
    });
    it('test before audit fix failure - same deposit / strategy coins', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: busd,
        weight: 50,
      });
      const strategy2 = await deployStrategy({
        token: busd,
        weight: 50,
      });
      const strategy3 = await deployStrategy({
        token: busd,
        weight: 9900,
      });

      await router.depositToBatch(busd.address, parseBusd("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);

      await expectStrategyHoldsExactBalances(strategy1, 0);
      await expectStrategyHoldsExactBalances(strategy2, 0);
      await expectStrategyHoldsExactBalances(strategy3, 10);
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
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      oracle.setPrice(busd.address, parseBusd("1"));
      oracle.setPrice(usdc.address, parseUsdc("1.01"));
      oracle.setPrice(usdt.address, parseUsdt("0.99"));

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 1000,
      });
      const strategy2 = await deployStrategy({
        token: usdc,
        weight: 5000,
      });
      const strategy3 = await deployStrategy({
        token: usdc,
        weight: 4000,
      });
      const strategy4 = await deployStrategy({
        token: usdt,
        weight: 3000,
      });
      const strategy5 = await deployStrategy({
        token: usdc,
        weight: 11000,
      });
      const strategy6 = await deployStrategy({
        token: usdt,
        weight: 1000,
      });

      await router.depositToBatch(busd.address, parseBusd("15"));
      await router.depositToBatch(usdt.address, parseUsdt("7.5"));
      await router.depositToBatch(usdc.address, parseUsdc("2.5"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);

      await expectStrategyHoldsExactBalances(strategy1, 1, 3);
      await expectStrategyHoldsExactBalances(strategy2, 5, 3);
      await expectStrategyHoldsExactBalances(strategy3, 4, 3);
      await expectStrategyHoldsExactBalances(strategy4, 3, 3);
      await expectStrategyHoldsExactBalances(strategy5, 11, 3);
      await expectStrategyHoldsExactBalances(strategy6, 1, 3);
    });
    it('very large deposits', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      oracle.setPrice(busd.address, parseBusd("1"));
      oracle.setPrice(usdc.address, parseUsdc("1.01"));
      oracle.setPrice(usdt.address, parseUsdt("0.99"));

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 1000,
      });
      const strategy2 = await deployStrategy({
        token: usdc,
        weight: 5000,
      });
      const strategy3 = await deployStrategy({
        token: usdc,
        weight: 4000,
      });
      const strategy4 = await deployStrategy({
        token: usdt,
        weight: 3000,
      });
      const strategy5 = await deployStrategy({
        token: usdc,
        weight: 11000,
      });
      const strategy6 = await deployStrategy({
        token: usdt,
        weight: 1000,
      });

      await router.depositToBatch(busd.address, parseBusd((1_500_000).toString()));
      await router.depositToBatch(usdt.address, parseUsdt((750_000).toString()));
      await router.depositToBatch(usdc.address, parseUsdc((250_000).toString()));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);

      await expectStrategyHoldsExactBalances(strategy1, 100_000, 3);
      await expectStrategyHoldsExactBalances(strategy2, 500_000, 3);
      await expectStrategyHoldsExactBalances(strategy3, 400_000, 3);
      await expectStrategyHoldsExactBalances(strategy4, 300_000, 3);
      await expectStrategyHoldsExactBalances(strategy5, 1_100_000, 3);
      await expectStrategyHoldsExactBalances(strategy6, 100_000, 3);
    });
  });
  describe('strategy weight manipulation works as intended', async function () {
    it('saturate strategy1 desired balance in native token and swap tokens, strategy2 desired balance in native token and swap tokens', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      await router.depositToBatch(usdt.address, parseUsdt("4"));
      await router.depositToBatch(busd.address, parseBusd("6"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategiesHoldCorrectBalances(10, strategy1, strategy2);
    });
    it('saturate strategy1 desired balance in native token, strategy2 desired balance in native and in swap tokens', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      await router.depositToBatch(usdt.address, parseUsdt("6"));
      await router.depositToBatch(busd.address, parseBusd("4"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategiesHoldCorrectBalances(10, strategy1, strategy2);
    });
    it('saturate strategy1 desired balance in native token, strategy2 desired balance in swap tokens', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      await router.depositToBatch(usdt.address, parseUsdt("5"));
      await router.depositToBatch(busd.address, parseBusd("5"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategiesHoldCorrectBalances(10, strategy1, strategy2);
    });
    it('saturate strategy1 desired balance in native token, strategy2 desired balance in native token', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      await router.depositToBatch(usdt.address, parseUsdt("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategiesHoldCorrectBalances(10, strategy1, strategy2);
    });
    it('saturate strategy1 desired balance in swap tokens, strategy2 desired balance in swap tokens', async function () {
      // order of tokens usdc -> busd -> usdt
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadState);

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      await router.depositToBatch(busd.address, parseBusd("10"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectNoRemnants(batch);
      await expectStrategiesHoldCorrectBalances(10, strategy1, strategy2);
    });
  });
  describe('strategy unallocated balance manipulation works as intended', async function () {
    it('deposit has matching native strategies', async function () {
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroBps);

      // 1 BUSD = 1 USDT
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const strategy1 = await deployStrategy({
        token: busd,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: busd,
        weight: 5000,
      });
      const strategy3 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      // 0.05 BUSD deposit will not be included into unallocated amount
      await router.depositToBatch(busd.address, parseBusd("0.05"));
      await router.depositToBatch(usdt.address, parseUsdt("15"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectStrategyHoldsExactBalances(strategy1, 5, 0);
      await expectStrategyHoldsExactBalances(strategy2, 5, 0);
      await expectStrategyHoldsExactBalances(strategy3, 5, 0);
    });
    it('deposit doesnt have matching native strategies', async function () {
      const {
        router, oracle, batch,
        busd, parseBusd,
        usdc, parseUsdc,
        usdt, parseUsdt,
        fakeExchangePlugin,
        expectNoRemnants, deployStrategy
      } = await loadFixture(loadStateWithZeroBps);

      // 1 BUSD = 1 USDT
      await oracle.setPrice(busd.address, parseBusd("1"));
      await oracle.setPrice(usdt.address, parseUsdt("1"));

      const strategy1 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy2 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });
      const strategy3 = await deployStrategy({
        token: usdt,
        weight: 5000,
      });

      // 0.05 BUSD deposit will not be included into unallocated amount
      await router.depositToBatch(busd.address, parseBusd("0.05"));
      await router.depositToBatch(usdt.address, parseUsdt("15"));

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      await expectStrategyHoldsExactBalances(strategy1, 5, 0);
      await expectStrategyHoldsExactBalances(strategy2, 5, 0);
      await expectStrategyHoldsExactBalances(strategy3, 5, 0);
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
      expectNoRemnants, deployStrategy
    } = await loadFixture(loadState);

    const strategy1 = await deployStrategy({
      token: busd,
      weight: 5000,
    });
    const strategy2 = await deployStrategy({
      token: usdc,
      weight: 5000,
    });
    const strategy3 = await deployStrategy({
      token: usdt,
      weight: 5000,
    });

    await router.depositToBatch(busd.address, parseBusd("10"));
    await router.depositToBatch(usdc.address, parseUsdc("10"));
    await router.depositToBatch(usdt.address, parseUsdt("10"));

    await expect(router.allocateToStrategies()).not.to.be.reverted;

    await expectNoRemnants(batch);
    await expectStrategiesHoldCorrectBalances(30, strategy1, strategy2, strategy3);
  });
});