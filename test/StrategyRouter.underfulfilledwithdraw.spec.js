const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy, deployFakeUnderFulfilledWithdrawalStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { MaxUint256, parseUniform, applySlippageInBps, convertFromUsdToTokenAmount } = require("./utils");
const { BigNumber } = require("ethers");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");


describe("Test StrategyRouter.withdrawFromStrategies reverts", function () {
  function deploySingleStrategy(underFulfilledWithdrawalBps) {
    return async function ({router, usdc}) {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps,
      });
    }
  }

  function deployMultipleStrategies(
    busdUnderFulfilledWithdrawalBps,
    usdcUnderFulfilledWithdrawalBps,
    usdtUnderFulfilledWithdrawalBps
  ) {
    return async function ({router, usdc, usdt, busd}) {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: busd,
        underFulfilledWithdrawalBps: busdUnderFulfilledWithdrawalBps,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdc,
        underFulfilledWithdrawalBps: usdcUnderFulfilledWithdrawalBps,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        router,
        token: usdt,
        underFulfilledWithdrawalBps: usdtUnderFulfilledWithdrawalBps,
      });
    }
  }

  function loadState(strategyDeploymentFn, rateCoefBps = 0) {
    async function state () {
      [owner, nonReceiptOwner] = await ethers.getSigners();

      // deploy core contracts
      ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());

      // deploy mock tokens
      ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

      const { exchangePlugin: fakeExchangePlugin } = await setupFakeExchangePlugin(
        oracle,
        rateCoefBps, // X% slippage,
        25 // fee %0.25
      );
      mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc('10000000'));
      mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt('10000000'));
      mintFakeToken(fakeExchangePlugin.address, busd, parseBusd('10000000'));

      // setup params for testing
      await setupTestParams(router, oracle, exchange, usdc, usdt, busd, fakeExchangePlugin);

      // setup infinite allowance
      await busd.approve(router.address, parseBusd("1000000"));
      await usdc.approve(router.address, parseUsdc("1000000"));
      await usdt.approve(router.address, parseUsdt("1000000"));

      // setup supported tokens
      await router.setSupportedToken(usdc.address, true);
      await router.setSupportedToken(busd.address, true);
      await router.setSupportedToken(usdt.address, true);

      // add fake strategies
      await strategyDeploymentFn({router, busd, usdc, usdt});

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"));
      await router.allocateToStrategies();

      return {
        owner, nonReceiptOwner,
        router, oracle, exchange, batch, receiptContract, sharesToken,
        usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt,
        fakeExchangePlugin
      }
    }

    return state;
  }

  describe("when withdraw from a single strategy", async function () {
    it("verify that less amount was withdrawn from a strategy than requested due to underfulfilled withdrawal on the strategy", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          deploySingleStrategy(300)
        )
      );
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance
        .add(receiptsShares)
      ;

      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdc,
          sharesValueUsd
        ),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        usdc.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWithCustomError(router, "WithdrawnAmountLowerThanExpectedAmount");
    });

    it("verify that less amount was withdrawn from a strategy than requested due to front-end and on-chain oracle different prices", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          deploySingleStrategy(0)
        )
      );
      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance
        .add(receiptsShares)
      ;

      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          busd,
          sharesValueUsd
        ),
        100 // 1% slippage
      );

      // set up oracle price different from a client to get less BUSD than expected
      await oracle.setPrice(busd.address, parseBusd("1.1")); // $1.1

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWithCustomError(router, "WithdrawnAmountLowerThanExpectedAmount");
    });

    it("verify that less amount was withdrawn from a strategy than requested due to exchange slippage", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          deploySingleStrategy(0),
          5000 // set 5% slippage on exchange
        )
      );
      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance
        .add(receiptsShares)
      ;

      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          busd,
          sharesValueUsd
        ),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWithCustomError(router, "WithdrawnAmountLowerThanExpectedAmount");
    });
  });

  describe("when withdraw from multiple strategies", async function () {
    it("verify that less amount was withdrawn from strategies than requested due to underfulfilled withdrawal on a single strategy", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          // deploy funds equally to 3 strategies
          // 5% slippage on busd strategy
          deployMultipleStrategies(
            500,
            0,
            0
          )
        )
      );
      await router.depositToBatch(busd.address, parseBusd("100"));
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance
        .add(receiptsShares)
      ;

      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdc,
          sharesValueUsd
        ),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        usdc.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWithCustomError(router, "WithdrawnAmountLowerThanExpectedAmount");
    });

    it("verify that less amount was withdrawn from strategies than requested due to front-end and on-chain oracle different prices", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          // deploy funds equally to 3 strategies
          deployMultipleStrategies(
            0,
            0,
            0
          )
        )
      );
      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance
        .add(receiptsShares)
      ;

      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          busd,
          sharesValueUsd
        ),
        100 // 1% slippage
      );

      // set up oracle price different from a client to get less BUSD than expected
      await oracle.setPrice(busd.address, parseBusd('2')); // $2

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWithCustomError(router, "WithdrawnAmountLowerThanExpectedAmount");
    });

    it("verify that less amount was withdrawn from strategies than requested due to exchange slippage", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          deploySingleStrategy(0),
          5000 // set 5% slippage on exchange
        )
      );
      await router.depositToBatch(usdc.address, parseUsdc("100"));
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance
        .add(receiptsShares)
      ;

      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          busd,
          sharesValueUsd
        ),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWithCustomError(router, "WithdrawnAmountLowerThanExpectedAmount");
    });
  });
});
