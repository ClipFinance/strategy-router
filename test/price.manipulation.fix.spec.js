const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupCore,
  setupFakeTokens,
  setupTestParams,
  setupTokensLiquidityOnPancake,
  deployFakeStrategy,
  setupFakeExchangePlugin,
  mintFakeToken,
} = require("./shared/commonSetup");
const {
  saturateTokenBalancesInStrategies,
  MaxUint256,
  deployProxy,
  deploy,
  provider,
  create2Deploy,
} = require("./utils");
const { convertFromUsdToTokenAmount, applySlippageInBps } = require("./utils");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { formatEther, parseEther, formatUnits } = require("ethers/lib/utils");
const { BigNumber } = require("ethers");

describe("Test price manipulation exploit fix", function () {
  async function initialState(fakePluginSlippage = 0, fakePluginFee = 0) {
    return async function state() {
      const [owner, attacker, , , , , , , , feeAddress] =
        await ethers.getSigners();

      upgrades.silenceWarnings();

      // deploy core contracts
      const {
        router,
        oracle,
        exchange,
        admin,
        batch,
        receiptContract,
        sharesToken,
        create2Deployer,
        ProxyBytecode,
      } = await setupCore();

      allocationWindowTime = ethers.BigNumber.from(
        await provider.getStorageAt(router.address, 102)
      );

      // deploy mock tokens
      const { usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
        await setupFakeTokens(batch, router, create2Deployer, ProxyBytecode);

      const { contract: fakeExchangePlugin } = await create2Deploy({
        create2Deployer,
        ProxyBytecode,
        ContractName: "MockExchangePlugin",
        constructorArgs: [oracle.address, fakePluginSlippage, fakePluginFee],
      });
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
      // await admin.addSupportedToken(busd);
      await admin.addSupportedToken(usdt);

      // add fake strategies
      // await deployFakeStrategy({ batch, router, admin, token: busd, profitPercent: 10_000 }); // 1% profit
      await deployFakeStrategy({
        batch,
        router,
        admin,
        token: usdc,
        profitPercent: 0,
      });
      // await await deployFakeStrategy({ batch, router, admin, token: usdt, profitPercent: 10_000 }); // 1% profit

      // await saturateTokenBalancesInStrategies(router);
      // await router.setFeesPercent(0);

      async function setupBadPrice(tokenA, tokenB, amount) {
        const [owner] = await ethers.getSigners();
      }

      async function logs() {
        console.log(
          "-= = = = = = = = = = = = = = = = = = = = = = = = = = = =-"
        );
        let totalShares = formatEther(await sharesToken.totalSupply());
        let { totalBalance } = await router.getStrategiesValue();
        totalBalance = formatEther(totalBalance);
        let protocolShares = formatEther(
          await sharesToken.balanceOf(feeAddress.address)
        );
        let currentCycleId = await ethers.BigNumber.from(
          await provider.getStorageAt(router.address, 103)
        );
        let cycleData = await router.getCycle(currentCycleId - 1);
        console.log("  totalBalance", totalBalance);
        console.log("  totalShares", totalShares);
        console.log("  protocolShares", protocolShares);
        console.log("  currentCycleId", currentCycleId);
        console.log("  Closed cycle info:");
        console.log(
          "    totalDepositedInUsd",
          formatEther(cycleData.totalDepositedInUsd)
        );
        console.log(
          "    receivedByStrategiesInUsd",
          formatEther(cycleData.receivedByStrategiesInUsd)
        );
        console.log(
          "    strategiesBalanceWithCompoundAndBatchDepositsInUsd",
          formatEther(
            cycleData.strategiesBalanceWithCompoundAndBatchDepositsInUsd
          )
        );
        console.log("    pricePerShare", formatEther(cycleData.pricePerShare));
        console.log(
          "-= = = = = = = = = = = = = = = = = = = = = = = = = = = =-"
        );
      }

      return {
        owner,
        attacker,
        feeAddress,
        router,
        oracle,
        exchange,
        batch,
        receiptContract,
        sharesToken,
        fakeExchangePlugin,
        usdc,
        usdt,
        busd,
        parseUsdc,
        parseUsdt,
        parseBusd,
        setupBadPrice,
        logs,
      };
    };
  }

  describe("price manipulation exploit", function () {
    it("attacker should receive more than he deposited due to price manipulation", async function () {
      const state = await initialState();
      const {
        attacker,
        router,
        oracle,
        usdc,
        parseUsdc,
        usdt,
        parseUsdt,
        setupBadPrice,
      } = await loadFixture(state);
      // some initial deposit to strategies
      await router.depositToBatch(usdc.address, parseUsdc("10000"), "");
      await router.allocateToStrategies();

      // --------- START ATTACK ---------

      // setup bad price
      // await oracle.setPrice(usdt.address, parseUsdt("0.90"));
      // await oracle.setPrice(usdt.address, parseUsdt("1.00"));
      await oracle.setPrice(usdc.address, parseUsdc("0.90"));

      let attackerDepositAmount = parseUsdt("10000");
      await usdt.transfer(attacker.address, attackerDepositAmount);
      expect(await usdt.balanceOf(attacker.address)).to.be.equal(
        attackerDepositAmount
      );

      // deposit to strategies by attacker
      await usdt
        .connect(attacker)
        .approve(router.address, attackerDepositAmount);
      await router
        .connect(attacker)
        .depositToBatch(usdt.address, attackerDepositAmount, "");
      expect(await usdt.balanceOf(attacker.address)).to.be.equal(0);
      await router.allocateToStrategies();

      // try to reset price to normal
      // await oracle.setPrice(usdt.address, parseUsdt("1.00"));
      // await oracle.setPrice(usdt.address, parseUsdt("1.00"));
      await oracle.setPrice(usdc.address, parseUsdc("1.00"));

      let receipt = [1];
      let shares = await router.calculateSharesFromReceipts(receipt);
      await router
        .connect(attacker)
        .withdrawFromStrategies(receipt, usdt.address, shares, 0, false);

      // console.log("USDC:", formatUnits(await usdc.balanceOf(attacker.address), 18));
      // console.log("USDT:", formatUnits(await usdt.balanceOf(attacker.address), 6));

      expect(await usdt.balanceOf(attacker.address)).to.be.greaterThan(
        attackerDepositAmount
      );
    });

    describe("solution test", function () {
      it("should not revert when deviation is less than limit", async function () {
        const fakePluginSlippage = 500;
        const fakePluginFee = 100;
        const state = await initialState(fakePluginSlippage, fakePluginFee);
        const { router, exchange, fakeExchangePlugin, usdt, parseUsdt } =
          await loadFixture(state);

        const maxSlippage = 900;
        await exchange.setMaxStablecoinSlippageInBps(maxSlippage);

        // deposit to strategies
        await router.depositToBatch(usdt.address, parseUsdt("10000"), "");
        await expect(router.allocateToStrategies()).to.be.fulfilled;
      });

      it("should revert when deviation is greater than limit", async function () {
        const fakePluginSlippage = 1_000;
        const fakePluginFee = 600;
        const state = await initialState(fakePluginSlippage, fakePluginFee);
        const { router, exchange, fakeExchangePlugin, usdt, parseUsdt } =
          await loadFixture(state);

        const maxSlippage = 500;
        await exchange.setMaxStablecoinSlippageInBps(maxSlippage);
        // deposit to strategies
        await router.depositToBatch(usdt.address, parseUsdt("10000"), "");
        await expect(router.allocateToStrategies()).to.be.rejectedWith(
          "ReceivedTooLittleTokenB()"
        );
      });
    });
  });
});
