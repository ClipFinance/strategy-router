const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy, deployFakeUnderflowStrategy, setupFakeExchangePlugin, mintFakeToken } = require("./shared/commonSetup");
const { MaxUint256, parseUniform } = require("./utils");
const { BigNumber } = require("ethers");
const { loadFixture } = require("ethereum-waffle");

describe("Test StrategyRouter.withdrawFromStrategies reverts", function () {
  function deploySingleStrategy(underflowBps) {
    return async function ({router, usdc}) {
      await deployFakeUnderflowStrategy({
        router,
        token: usdc,
        underflowBps,
      });
    }
  }

  function deployMultipleStrategies(
    busdUnderflowBps,
    usdcUnderflowBps,
    usdtUnderflowBps
  ) {
    return async function ({router, usdc, usdt, busd}) {
      await deployFakeUnderflowStrategy({
        router,
        token: busd,
        underflowBps: busdUnderflowBps,
      });
      await deployFakeUnderflowStrategy({
        router,
        token: usdc,
        underflowBps: usdcUnderflowBps,
      });
      await deployFakeUnderflowStrategy({
        router,
        token: usdt,
        underflowBps: usdtUnderflowBps,
      });
    }
  }

  function loadState(strategyDeploymentFn, rateCoefBps = 0) {
    return (async function () {
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
    });
  }

  describe("when withdraw from a single strategy", async function () {
    it("when less then expected withdrawn from a strategy", async function () {
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
      let [price, pricePrecision] = await oracle.getTokenUsdPrice(usdc.address);
      let expectedWithdrawAmount = sharesValueUsd
        .mul(price)
        .div(
          BigNumber.from(10).pow(pricePrecision)
        )
        .mul(99)
        .div(100)
        .div(
          BigNumber.from(10).pow(18 - usdc.decimalNumber)
        )
      ; // 1% slippage

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        usdc.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWith("WithdrawnAmountLowerThanExpectedAmount()");

      // let newBalance = await usdc.balanceOf(owner.address);
      // expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("2"));
      // // if this not revert, means receipt still exists and not burned
      // let receipt = await receiptContract.getReceipt(1);
      // expect(receipt.tokenAmountUniform).to.be.closeTo(parseUniform("50"), parseUniform("1"));
    });

    it("when less then expected withdrawn due to oracle different prices", async function () {
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
      let [price, pricePrecision] = await oracle.getTokenUsdPrice(busd.address);
      let expectedWithdrawAmount = sharesValueUsd
        .mul(price)
        .div(
          BigNumber.from(10).pow(pricePrecision)
        )
        .mul(99)
        .div(100)
        .div(
          BigNumber.from(10).pow(18 - busd.decimalNumber)
        )
      ; // 1% slippage

      // set up oracle price different from a client to get less BUSD than expected
      await oracle.setPrice(busd.address, 9_000_000_000); // $0.9

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWith("WithdrawnAmountLowerThanExpectedAmount()");

      // let newBalance = await usdc.balanceOf(owner.address);
      // expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("2"));
      // // if this not revert, means receipt still exists and not burned
      // let receipt = await receiptContract.getReceipt(1);
      // expect(receipt.tokenAmountUniform).to.be.closeTo(parseUniform("50"), parseUniform("1"));
    });

    it("when less then expected withdrawn due to exchange slippage", async function () {
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
      let [price, pricePrecision] = await oracle.getTokenUsdPrice(busd.address);
      let expectedWithdrawAmount = sharesValueUsd
        .mul(price)
        .div(
          BigNumber.from(10).pow(pricePrecision)
        )
        .mul(99)
        .div(100)
        .div(
          BigNumber.from(10).pow(18 - busd.decimalNumber)
        )
      ; // 1% slippage

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWith("WithdrawnAmountLowerThanExpectedAmount()");
    });
  });

  describe("when withdraw from multiple strategies", async function () {
    it("when less then expected withdrawn from a strategy", async function () {
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
      let [price, pricePrecision] = await oracle.getTokenUsdPrice(usdc.address);
      let expectedWithdrawAmount = sharesValueUsd
        .mul(price)
        .div(
          BigNumber.from(10).pow(pricePrecision)
        )
        .mul(99)
        .div(100)
        .div(
          BigNumber.from(10).pow(18 - usdc.decimalNumber)
        )
      ; // 1% slippage

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        usdc.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWith("WithdrawnAmountLowerThanExpectedAmount()");

      // let newBalance = await usdc.balanceOf(owner.address);
      // expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("2"));
      // // if this not revert, means receipt still exists and not burned
      // let receipt = await receiptContract.getReceipt(1);
      // expect(receipt.tokenAmountUniform).to.be.closeTo(parseUniform("50"), parseUniform("1"));
    });

    it("when less then expected withdrawn due to oracle different prices", async function () {
      const {
        router, sharesToken, oracle,
        busd, parseBusd, usdc, parseUsdc
      } = await loadFixture(
        loadState(
          // deploy funds equally to 3 strategies
          // 5% slippage on busd strategy
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
      let [price, pricePrecision] = await oracle.getTokenUsdPrice(busd.address);
      let expectedWithdrawAmount = sharesValueUsd
        .mul(price)
        .div(
          BigNumber.from(10).pow(pricePrecision)
        )
        .mul(99)
        .div(100)
        .div(
          BigNumber.from(10).pow(18 - busd.decimalNumber)
        )
      ; // 1% slippage

      // set up oracle price different from a client to get less BUSD than expected
      await oracle.setPrice(busd.address, parseBusd('2')); // $2

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWith("WithdrawnAmountLowerThanExpectedAmount()");

      // let newBalance = await usdc.balanceOf(owner.address);
      // expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("2"));
      // // if this not revert, means receipt still exists and not burned
      // let receipt = await receiptContract.getReceipt(1);
      // expect(receipt.tokenAmountUniform).to.be.closeTo(parseUniform("50"), parseUniform("1"));
    });

    it("when less then expected withdrawn due to exchange slippage", async function () {
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
      let [price, pricePrecision] = await oracle.getTokenUsdPrice(busd.address);
      let expectedWithdrawAmount = sharesValueUsd
        .mul(price)
        .div(
          BigNumber.from(10).pow(pricePrecision)
        )
        .mul(99)
        .div(100)
        .div(
          BigNumber.from(10).pow(18 - busd.decimalNumber)
        )
      ; // 1% slippage

      // let oldBalance = await usdc.balanceOf(owner.address);
      await expect(router.withdrawFromStrategies(
        [1, 2],
        busd.address,
        withdrawShares,
        expectedWithdrawAmount
      )).to.be.revertedWith("WithdrawnAmountLowerThanExpectedAmount()");
    });
  });
});
