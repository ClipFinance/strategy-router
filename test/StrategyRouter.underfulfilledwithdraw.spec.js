const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTestParams,
  deployFakeUnderFulfilledWithdrawalStrategy,
  setupFakeExchangePlugin,
  mintFakeToken,
} = require("./shared/commonSetup");
const { applySlippageInBps, convertFromUsdToTokenAmount } = require("./utils");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Test StrategyRouter.withdrawFromStrategies reverts", function () {
  function deploySingleStrategy(underFulfilledWithdrawalBps) {
    return async function ({ admin, batch, router, usdc }) {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        admin,
        batch,
        router,
        token: usdc,
        underFulfilledWithdrawalBps,
      });
    };
  }

  function deployMultipleStrategies(
    busdUnderFulfilledWithdrawalBps,
    usdcUnderFulfilledWithdrawalBps,
    usdtUnderFulfilledWithdrawalBps
  ) {
    return async function ({ admin, batch, router, usdc, usdt, busd }) {
      await deployFakeUnderFulfilledWithdrawalStrategy({
        admin,
        batch,
        router,
        token: busd,
        underFulfilledWithdrawalBps: busdUnderFulfilledWithdrawalBps,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        admin,
        batch,
        router,
        token: usdc,
        underFulfilledWithdrawalBps: usdcUnderFulfilledWithdrawalBps,
      });
      await deployFakeUnderFulfilledWithdrawalStrategy({
        admin,
        batch,
        router,
        token: usdt,
        underFulfilledWithdrawalBps: usdtUnderFulfilledWithdrawalBps,
      });
    };
  }

  function loadState(strategyDeploymentFn, rateCoefBps = 0) {
    async function state() {
      [owner, nonReceiptOwner] = await ethers.getSigners();

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
      // deploy mock tokens
      ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
        await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode));

      const { exchangePlugin: fakeExchangePlugin } =
        await setupFakeExchangePlugin(
          oracle,
          rateCoefBps, // X% slippage,
          25 // fee %0.25
        );
      mintFakeToken(fakeExchangePlugin.address, usdc, parseUsdc("10000000"));
      mintFakeToken(fakeExchangePlugin.address, usdt, parseUsdt("10000000"));
      mintFakeToken(fakeExchangePlugin.address, busd, parseBusd("10000000"));
      // setup params for testing
      await setupTestParams(
        router,
        oracle,
        exchange,
        admin,
        usdc,
        usdt,
        busd,
        fakeExchangePlugin
      );

      // setup infinite allowance
      await busd.approve(router.address, parseBusd("1000000"));
      await usdc.approve(router.address, parseUsdc("1000000"));
      await usdt.approve(router.address, parseUsdt("1000000"));

      // setup supported tokens
      await admin.addSupportedToken(usdc);
      await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies

      await strategyDeploymentFn({ admin, batch, router, busd, usdc, usdt });

      // admin initial deposit to set initial shares and pps
      await router.depositToBatch(busd.address, parseBusd("1"), "");
      await router.allocateToStrategies();
      return {
        owner,
        nonReceiptOwner,
        admin,
        router,
        oracle,
        exchange,
        batch,
        receiptContract,
        sharesToken,
        usdc,
        usdt,
        busd,
        parseUsdc,
        parseBusd,
        parseUsdt,
        fakeExchangePlugin,
      };
    }

    return state;
  }

  describe("when withdraw from a single strategy", async function () {
    it("verify that less amount was withdrawn from a strategy than requested due to underfulfilled withdrawal on the strategy", async function () {
      const {
        owner,
        nonReceiptOwner,
        admin,
        router,
        oracle,
        busd,
        parseBusd,
        usdc,
        parseUsdc,
        batch,
      } = await loadFixture(loadState(deploySingleStrategy(300)));
      await router.depositToBatch(busd.address, parseBusd("100"), "");
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance.add(receiptsShares);
      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(
        router.withdrawFromStrategies(
          [1, 2],
          usdc.address,
          withdrawShares,
          expectedWithdrawAmount,
          false
        )
      ).to.be.revertedWithCustomError(
        router,
        "WithdrawnAmountLowerThanExpectedAmount"
      );
    });

    it("verify that less amount was withdrawn from a strategy than requested due to front-end and on-chain oracle different prices", async function () {
      const { router, sharesToken, oracle, busd, parseBusd, usdc, parseUsdc } =
        await loadFixture(loadState(deploySingleStrategy(0)));
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance.add(receiptsShares);
      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, busd, sharesValueUsd),
        100 // 1% slippage
      );

      // set up oracle price different from a client to get less BUSD than expected
      await oracle.setPrice(busd.address, parseBusd("1.1")); // $1.1

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(
        router.withdrawFromStrategies(
          [1, 2],
          busd.address,
          withdrawShares,
          expectedWithdrawAmount,
          false
        )
      ).to.be.revertedWithCustomError(
        router,
        "WithdrawnAmountLowerThanExpectedAmount"
      );
    });

    it("verify that less amount was withdrawn from a strategy than requested due to exchange slippage", async function () {
      const { router, sharesToken, oracle, busd, parseBusd, usdc, parseUsdc } =
        await loadFixture(
          loadState(
            deploySingleStrategy(0),
            500 // set 5% slippage on exchange
          )
        );
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance.add(receiptsShares);
      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, busd, sharesValueUsd),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(
        router.withdrawFromStrategies(
          [1, 2],
          busd.address,
          withdrawShares,
          expectedWithdrawAmount,
          false
        )
      ).to.be.revertedWithCustomError(
        router,
        "WithdrawnAmountLowerThanExpectedAmount"
      );
    });
  });

  describe("when withdraw from multiple strategies", async function () {
    it("verify that less amount was withdrawn from strategies than requested due to underfulfilled withdrawal on a single strategy", async function () {
      const { router, sharesToken, oracle, busd, parseBusd, usdc, parseUsdc } =
        await loadFixture(
          loadState(
            // deploy funds equally to 3 strategies
            // 5% slippage on busd strategy
            deployMultipleStrategies(500, 0, 0)
          )
        );
      await router.depositToBatch(busd.address, parseBusd("100"), "");
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance.add(receiptsShares);
      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(
        router.withdrawFromStrategies(
          [1, 2],
          usdc.address,
          withdrawShares,
          expectedWithdrawAmount,
          false
        )
      ).to.be.revertedWithCustomError(
        router,
        "WithdrawnAmountLowerThanExpectedAmount"
      );
    });

    it("verify that less amount was withdrawn from strategies than requested due to front-end and on-chain oracle different prices", async function () {
      const { router, sharesToken, oracle, busd, parseBusd, usdc, parseUsdc } =
        await loadFixture(
          loadState(
            // deploy funds equally to 3 strategies
            deployMultipleStrategies(0, 0, 0)
          )
        );
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance.add(receiptsShares);
      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, busd, sharesValueUsd),
        100 // 1% slippage
      );

      // set up oracle price different from a client to get less BUSD than expected
      await oracle.setPrice(busd.address, parseBusd("2")); // $2

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(
        router.withdrawFromStrategies(
          [1, 2],
          busd.address,
          withdrawShares,
          expectedWithdrawAmount,
          false
        )
      ).to.be.revertedWithCustomError(
        router,
        "WithdrawnAmountLowerThanExpectedAmount"
      );
    });

    it("verify that less amount was withdrawn from strategies than requested due to exchange slippage", async function () {
      const { router, sharesToken, oracle, busd, parseBusd, usdc, parseUsdc } =
        await loadFixture(
          loadState(
            deploySingleStrategy(0),
            500 // set 5% slippage on exchange
          )
        );
      await router.depositToBatch(usdc.address, parseUsdc("100"), "");
      await router.allocateToStrategies();

      let sharesBalance = await sharesToken.balanceOf(owner.address);
      let receiptsShares = await router.calculateSharesFromReceipts([1]);
      let withdrawShares = sharesBalance.add(receiptsShares);
      let sharesValueUsd = await router.calculateSharesUsdValue(withdrawShares);

      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, busd, sharesValueUsd),
        100 // 1% slippage
      );

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(
        router.withdrawFromStrategies(
          [1, 2],
          busd.address,
          withdrawShares,
          expectedWithdrawAmount,
          false
        )
      ).to.be.revertedWithCustomError(
        router,
        "WithdrawnAmountLowerThanExpectedAmount"
      );
    });
  });
});
