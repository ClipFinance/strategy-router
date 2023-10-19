const { expect } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const {
  setupTokens,
  setupCore,
  setupParamsOnBNB,
  setupIdleStrategies,
} = require("./shared/commonSetup");
const {
  setBalance,
  impersonateAccount,
  stopImpersonatingAccount,
} = require("@nomicfoundation/hardhat-network-helpers");
const {
  skipTimeAndBlocks,
  create2DeployProxy,
  provider,
  parseUniform,
  convertFromUsdToTokenAmount,
  applySlippageInBps,
} = require("./utils");

describe("Test StrategyRouter with two real strategies on bnb chain (happy scenario)", function () {
  let owner, user2;
  // mock tokens with different decimals
  let usdc, busd, usdt;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, admin, batch, receiptContract, sharesToken;
  let priceManipulationPercentThresholdInBps;
  let allocationWindowTime;
  let strategyBiswap, strategyBiswap2;

  let snapshotId, initialSnapshot;

  before(async function () {
    [owner, user2] = await ethers.getSigners();
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
    } = await setupCore({
      batchContract: "Batch",
      oracleContract: "ChainlinkOracle",
    }));

    // setup params for testing
    await setupParamsOnBNB(admin, router, oracle, exchange);
    allocationWindowTime = ethers.BigNumber.from(
      await provider.getStorageAt(router.address, 102)
    );

    // get tokens on bnb chain for testing
    priceManipulationPercentThresholdInBps = 2000;

    ({ usdc, busd, usdt, hay, parseUsdc, parseBusd } = await setupTokens());

    const oracleTokens = [
      busd.address,
      usdc.address,
      usdt.address,
      hay.address,
      hre.networkVariables.bsw,
      hre.networkVariables.wbnb,
    ];
    const priceFeeds = [
      hre.networkVariables.BusdUsdPriceFeed,
      hre.networkVariables.UsdcUsdPriceFeed,
      hre.networkVariables.UsdtUsdPriceFeed,
      hre.networkVariables.HayUsdPriceFeed,
      hre.networkVariables.BswUsdPriceFeed,
      hre.networkVariables.BnbUsdPriceFeed,
    ];

    await oracle.setPriceFeeds(oracleTokens, priceFeeds);

    // set oracle address to whitelist to get hay prices
    await setBalance(
      "0xccfb24799feedf1567e43edd47cdb9130343700a",
      hre.ethers.utils.parseEther("1")
    );
    // 0xccfb24799feedf1567e43edd47cdb9130343700a
    await impersonateAccount("0xccfb24799feedf1567e43edd47cdb9130343700a");
    let signer = await ethers.getSigner(
      "0xccfb24799feedf1567e43edd47cdb9130343700a"
    );
    // address to add
    const addressToAdd = oracle.address;

    // function selector for `addGlobalAccess(address)`
    const functionSelector = "0x0bdf33d2";

    // encode the address
    const encodedAddress = ethers.utils.defaultAbiCoder.encode(
      ["address"],
      [addressToAdd]
    );

    // remove the first 2 characters (0x) from the encoded address
    const cleanEncodedAddress = encodedAddress.substring(2);

    // construct the data field
    const data = functionSelector + cleanEncodedAddress;

    // construct the transaction
    const tx = await signer.sendTransaction({
      to: "0xCA03A93D81e6bE1ef1Cf0EC42D56D4ef6b5C6Df6",
      data: data,
    });

    console.log("Transaction sent: ", tx.hash);
    await tx.wait();
    console.log("Transaction confirmed");
    await stopImpersonatingAccount(
      "0xccfb24799feedf1567e43edd47cdb9130343700a"
    );

    await setupIdleStrategies(
      owner,
      batch,
      router,
      create2Deployer,
      ProxyBytecode,
      usdc,
      busd
    );

    // setup supported tokens
    await admin.addSupportedToken(usdc);
    await admin.addSupportedToken(busd);

    // setup infinite allowance
    await busd.approve(router.address, parseBusd("1000000"));
    await usdc.approve(router.address, parseUsdc("1000000"));

    // deploy strategies
    ({ proxyContract: strategyBiswap2 } = await create2DeployProxy({
      create2Deployer,
      ProxyBytecode,
      saltAddition: "BiswapBusdUsdt",
      ContractName: "BiswapBusdUsdt",
      constructorArgs: [
        router.address,
        oracle.address,
        priceManipulationPercentThresholdInBps,
      ],
      initializeTypes: ["address", "uint256", "uint16", "address[]"],
      initializeArgs: [
        owner.address,
        parseHay((1_000_000).toString()), // TODO change to real value on production deploy
        500, // 5%
        [router.address, batch.address],
      ],
    }));

    await strategyBiswap2.transferOwnership(router.address);

    // deploy strategies
    ({ proxyContract: strategyBiswap } = await create2DeployProxy({
      create2Deployer,
      ProxyBytecode,
      saltAddition: "BiswapUsdcUsdt",
      ContractName: "BiswapUsdcUsdt",
      constructorArgs: [
        router.address,
        oracle.address,
        priceManipulationPercentThresholdInBps,
      ],
      initializeTypes: ["address", "uint256", "uint16", "address[]"],
      initializeArgs: [
        owner.address,
        parseHay((1_000_000).toString()), // TODO change to real value on production deploy
        500, // 5%
        [router.address, batch.address],
      ],
    }));

    await strategyBiswap.transferOwnership(router.address);

    await admin.addStrategy(strategyBiswap2.address, 5000);
    await admin.addStrategy(strategyBiswap.address, 5000);
    // admin initial deposit to set initial shares and pps, receipt ID 1
    await router.depositToBatch(busd.address, parseBusd("1"), "");
    await router.allocateToStrategies();
  });

  beforeEach(async function () {
    snapshotId = await provider.send("evm_snapshot");
  });

  afterEach(async function () {
    await provider.send("evm_revert", [snapshotId]);
  });

  after(async function () {
    await provider.send("evm_revert", [initialSnapshot]);
  });

  describe("Test deposit to batch & withdraw from batch; allocate to strategies & withdraw from strategies", function () {
    const USER_1_RECEIPT_2 = 1;
    const USER_2_RECEIPT_3 = 2;
    const USER_1_RECEIPT_4 = 3;
    const USER_1_RECEIPT_5 = 4;
    const USER_1_RECEIPT_6 = 5;
    const USER_2_DEPOSIT_AMOUNT = "60";

    describe("Test deposit to batch and withdraw from batch", function () {
      // value is position in array while receipt_2 is ID number (ID is by 1 bigger than position in array)
      it("User deposit 100 usdc and verify batch balance", async function () {
        // receipt ID 2
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");

        // historically have this test with some delta
        expect(await usdc.balanceOf(batch.address)).to.be.closeTo(
          parseUsdc("100"),
          parseUsdc("0.1")
        );
        // returns exactly back, because we have simplified withdraw from batch
        expect(await usdc.balanceOf(batch.address)).to.be.equal(
          parseUsdc("100")
        );
      });

      it("User withdraw 100 usdc from batch current cycle", async function () {
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        // <---- end of 'fixture' ---->

        let receipt = await receiptContract.getReceipt(USER_1_RECEIPT_2); // by array position
        expect(receipt.cycleId).to.be.equal(1);
        expect(receipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
        expect(receipt.token).to.be.equal(usdc.address);
        let oldBalance = await usdc.balanceOf(owner.address);

        await expect(router.withdrawFromBatch([USER_1_RECEIPT_2]))
          .to.emit(router, "WithdrawFromBatch")
          .withArgs(
            owner.address,
            [USER_1_RECEIPT_2],
            [usdc.address],
            [parseUsdc("100")]
          );

        let newBalance = await usdc.balanceOf(owner.address);
        expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
      });

      it("2 users did multiple deposits and 1 user withdraws everything from current cycle", async function () {
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await router.withdrawFromBatch([USER_1_RECEIPT_2]);
        // <---- end of 'fixture' ---->

        // was withdrawn in last previous test
        await expect(
          receiptContract.getReceipt(USER_1_RECEIPT_2)
        ).to.be.revertedWithCustomError(receiptContract, "NonExistingToken");

        await usdc.transfer(user2.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await usdc
          .connect(user2)
          .approve(router.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await router
          .connect(user2)
          .depositToBatch(usdc.address, parseUsdc(USER_2_DEPOSIT_AMOUNT), "");

        let oldUsdcBal = await usdc.balanceOf(owner.address);
        let oldBusdBal = await busd.balanceOf(owner.address);

        await router.depositToBatch(usdc.address, parseUsdc("50"), "");
        await router.depositToBatch(busd.address, parseBusd("120"), "");
        await router.depositToBatch(usdc.address, parseUsdc("75"), "");

        // 3 receipts were just created, but the 4th one was initial admin deposit of 1 busd that is already allocated
        // to strategies, but since it was not removed, receipt is still there.
        expect(await receiptContract.balanceOf(owner.address)).to.equal(4);

        // 125 usdc and 120 busd in batch
        let batchUsdcBalance = await usdc.balanceOf(batch.address);
        let batchBusdBalance = await busd.balanceOf(batch.address);
        expect(batchUsdcBalance).to.be.equal(parseUsdc("185")); // 50+75=125 usdc of owner & 60 usdc of user2
        expect(batchBusdBalance).to.be.equal(parseBusd("120"));

        await expect(
          router.withdrawFromBatch([
            USER_1_RECEIPT_4,
            USER_1_RECEIPT_5,
            USER_1_RECEIPT_6,
          ])
        )
          .to.emit(router, "WithdrawFromBatch")
          .withArgs(
            owner.address,
            [USER_1_RECEIPT_4, USER_1_RECEIPT_5, USER_1_RECEIPT_6],
            [usdc.address, busd.address, usdc.address],
            [parseUsdc("50"), parseBusd("120"), parseUsdc("75")]
          );

        let newUsdcBal = await usdc.balanceOf(owner.address);
        let newBusdBal = await busd.balanceOf(owner.address);

        // 3 receipts from batch were burned during withdraw, so only 1 receipt is left that was allocated to strategies
        expect(await receiptContract.balanceOf(owner.address)).to.equal(1);
        // 1 initial receipt on position 0
        expect(
          (await receiptContract.getTokensOfOwner(owner.address)).toString()
        ).to.equal("0");

        // 1 receipt in batch belonging to user2
        expect(await receiptContract.balanceOf(user2.address)).to.equal(1);

        // old balance of user before deposit to batch andas  we withdraw everything from batch, we get initial balance
        expect(newUsdcBal).to.be.equal(oldUsdcBal);
        expect(newBusdBal).to.be.equal(oldBusdBal);
      });
    });

    describe("Test allocate to strategies and withdraw from strategies", function () {
      const USER_1_RECEIPT_7 = 6;

      it("Allocate batch to strategies", async function () {
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await router.withdrawFromBatch([USER_1_RECEIPT_2]);
        await usdc.transfer(user2.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await usdc
          .connect(user2)
          .approve(router.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await router
          .connect(user2)
          .depositToBatch(usdc.address, parseUsdc(USER_2_DEPOSIT_AMOUNT), "");
        await router.depositToBatch(usdc.address, parseUsdc("50"), "");
        await router.depositToBatch(busd.address, parseBusd("120"), "");
        await router.depositToBatch(usdc.address, parseUsdc("75"), "");
        await router.withdrawFromBatch([
          USER_1_RECEIPT_4,
          USER_1_RECEIPT_5,
          USER_1_RECEIPT_6,
        ]);
        // <---- end of 'fixture' ---->

        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);

        // user #2 from previous test has 60 usdc still sitting in batch, thus in strategies ~0 left with some dust
        expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
          parseUniform("0"), // 1.000354593918860232
          parseUniform("1.5")
        );

        await router.allocateToStrategies();

        expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
          parseUniform("60"), // 61.063235184928086817
          parseUniform("1.5")
        );
      });

      it("User #1 deposit 100 usdc and allocate batch to strategies", async function () {
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await router.withdrawFromBatch([USER_1_RECEIPT_2]);
        await usdc.transfer(user2.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await usdc
          .connect(user2)
          .approve(router.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await router
          .connect(user2)
          .depositToBatch(usdc.address, parseUsdc(USER_2_DEPOSIT_AMOUNT), "");
        await router.depositToBatch(usdc.address, parseUsdc("50"), "");
        await router.depositToBatch(busd.address, parseBusd("120"), "");
        await router.depositToBatch(usdc.address, parseUsdc("75"), "");
        await router.withdrawFromBatch([
          USER_1_RECEIPT_4,
          USER_1_RECEIPT_5,
          USER_1_RECEIPT_6,
        ]);
        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
        await router.allocateToStrategies();
        // <---- end of 'fixture' ---->

        await router.depositToBatch(usdc.address, parseUsdc("100"), "");

        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);

        await router.allocateToStrategies();

        expect((await router.getStrategiesValue()).totalBalance).to.be.closeTo(
          parseUniform("160"), // 161.102493729346097917
          parseUniform("2.0")
        );
      });

      it("Withdraw user #1 from strategies receipt ID 7", async function () {
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await router.withdrawFromBatch([USER_1_RECEIPT_2]);
        await usdc.transfer(user2.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await usdc
          .connect(user2)
          .approve(router.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await router
          .connect(user2)
          .depositToBatch(usdc.address, parseUsdc(USER_2_DEPOSIT_AMOUNT), "");
        await router.depositToBatch(usdc.address, parseUsdc("50"), "");
        await router.depositToBatch(busd.address, parseBusd("120"), "");
        await router.depositToBatch(usdc.address, parseUsdc("75"), "");
        await router.withdrawFromBatch([
          USER_1_RECEIPT_4,
          USER_1_RECEIPT_5,
          USER_1_RECEIPT_6,
        ]);
        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
        await router.allocateToStrategies();
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
        await router.allocateToStrategies();
        // <---- end of 'fixture' ---->

        let beforeWithdrawUserBalance = await usdc.balanceOf(owner.address); // 0
        let shares = await router.calculateSharesFromReceipts([
          USER_1_RECEIPT_7,
        ]); // 100,039,287,833,254,722,032
        let sharesValueUsd = await router.calculateSharesUsdValue(shares);
        let expectedWithdrawAmount = applySlippageInBps(
          await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
          100 // 1% slippage
        );
        await router.withdrawFromStrategies(
          [USER_1_RECEIPT_7],
          usdc.address,
          shares,
          expectedWithdrawAmount,
          false
        );
        let afterWithdrawUserBalance = await usdc.balanceOf(owner.address);

        expect(
          afterWithdrawUserBalance.sub(beforeWithdrawUserBalance)
        ).to.be.closeTo(parseUsdc("100"), parseUniform("1.0"));
      });

      it("Withdraw user #2 from strategies receipt ID 3", async function () {
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await router.withdrawFromBatch([USER_1_RECEIPT_2]);
        await usdc.transfer(user2.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await usdc
          .connect(user2)
          .approve(router.address, parseUsdc(USER_2_DEPOSIT_AMOUNT));
        await router
          .connect(user2)
          .depositToBatch(usdc.address, parseUsdc(USER_2_DEPOSIT_AMOUNT), "");
        await router.depositToBatch(usdc.address, parseUsdc("50"), "");
        await router.depositToBatch(busd.address, parseBusd("120"), "");
        await router.depositToBatch(usdc.address, parseUsdc("75"), "");
        await router.withdrawFromBatch([
          USER_1_RECEIPT_4,
          USER_1_RECEIPT_5,
          USER_1_RECEIPT_6,
        ]);
        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
        await router.allocateToStrategies();
        await router.depositToBatch(usdc.address, parseUsdc("100"), "");
        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
        await router.allocateToStrategies();
        let beforeWithdrawUserBalance = await usdc.balanceOf(owner.address); // 0
        let shares = await router.calculateSharesFromReceipts([
          USER_1_RECEIPT_7,
        ]); // 100,039,287,833,254,722,032
        let sharesValueUsd = await router.calculateSharesUsdValue(shares);
        let expectedWithdrawAmount = applySlippageInBps(
          await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
          100 // 1% slippage
        );
        await router.withdrawFromStrategies(
          [USER_1_RECEIPT_7],
          usdc.address,
          shares,
          expectedWithdrawAmount,
          false
        );
        // <---- end of 'fixture' ---->

        beforeWithdrawUserBalance = await usdc.balanceOf(user2.address); // 0
        shares = await router.calculateSharesFromReceipts([USER_2_RECEIPT_3]); // 60,023,588,917,116,858,591
        sharesValueUsd = await router.calculateSharesUsdValue(shares);
        expectedWithdrawAmount = applySlippageInBps(
          await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
          100 // 1% slippage
        );
        await router
          .connect(user2)
          .withdrawFromStrategies(
            [USER_2_RECEIPT_3],
            usdc.address,
            shares,
            expectedWithdrawAmount,
            false
          );
        let afterWithdrawUserBalance = await usdc.balanceOf(user2.address);

        // TODO describe on why result changes from time to time
        // 59,968,242,935,978,697,614
        // 59,906,344,997,371,393,851
        expect(
          afterWithdrawUserBalance.sub(beforeWithdrawUserBalance)
        ).to.be.closeTo(parseUsdc(USER_2_DEPOSIT_AMOUNT), parseUniform("0.3"));

        // Verify funds were withdrawn from strategies
        // should've withdrawn all (except admin), so verify that
        expect(await strategyBiswap2.totalTokens()).to.be.lt(parseBusd("1"));
        expect(await strategyBiswap.totalTokens()).to.be.lt(parseUsdc("1"));
        expect(await usdc.balanceOf(router.address)).to.be.lt(parseUsdc("1"));

        expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
        expect(await sharesToken.balanceOf(router.address)).to.be.closeTo(
          parseEther("1"), // admin deposit 1,000,354,593,918,860,232
          parseEther("0.025")
        );
      });
    });

    it("Farms should be empty on withdraw all multiple times", async function () {
      for (let i = 0; i < 5; i++) {
        await router.depositToBatch(usdc.address, parseUsdc("10"), "");
        await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
        await router.allocateToStrategies();
        let receipts = await receiptContract.getTokensOfOwner(owner.address);
        receipts = receipts.filter((id) => id != 0); // ignore nft of admin initial deposit
        let shares = await router.calculateSharesFromReceipts([receipts[0]]);
        let sharesValueUsd = await router.calculateSharesUsdValue(shares);
        let expectedWithdrawAmount = applySlippageInBps(
          await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
          100 // 1% slippage
        );
        await router.withdrawFromStrategies(
          [receipts[0]],
          usdc.address,
          shares,
          expectedWithdrawAmount,
          false
        );

        // console.log("strategies balance");
        // printStruct(await router.getStrategiesValue());
      }

      expect(await strategyBiswap2.totalTokens()).to.be.lt(parseBusd("1"));
      expect(await strategyBiswap.totalTokens()).to.be.lt(parseUsdc("1"));
      expect(await usdc.balanceOf(router.address)).to.be.lt(parseUsdc("1"));

      expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
      expect(await sharesToken.balanceOf(router.address)).to.be.closeTo(
        parseEther("1"),
        parseEther("0.01")
      );
    });

    it("Remove strategy", async function () {
      // deposit to strategies
      await router.depositToBatch(usdc.address, parseUsdc("10"), "");
      await skipTimeAndBlocks(allocationWindowTime, allocationWindowTime / 3);
      await router.allocateToStrategies();

      // deploy new strategy
      const { proxyContract: farm2 } = await create2DeployProxy({
        create2Deployer,
        ProxyBytecode,
        saltAddition: "BiswapBusdUsdtToRemove",
        ContractName: "BiswapBusdUsdt",
        constructorArgs: [
          router.address,
          oracle.address,
          priceManipulationPercentThresholdInBps,
        ],
        initializeTypes: ["address", "uint256", "uint16", "address[]"],
        initializeArgs: [
          owner.address,
          parseBusd((1_000_000).toString()),
          500, // 5%
          [router.address, batch.address],
        ],
      });
      await farm2.transferOwnership(router.address);

      // add new farm
      await admin.addStrategy(farm2.address, 1000);

      // remove 2nd farm with index 1
      await admin.removeStrategy(1);

      // withdraw user shares
      let receipts = await receiptContract.getTokensOfOwner(owner.address);
      receipts = receipts.filter((id) => id != 0); // ignore nft of admin initial deposit
      let oldBalance = await usdc.balanceOf(owner.address);
      let shares = await router.calculateSharesFromReceipts([receipts[0]]);
      let sharesValueUsd = await router.calculateSharesUsdValue(shares);
      let expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(oracle, usdc, sharesValueUsd),
        150 // 1% slippage
      );
      await router.withdrawFromStrategies(
        [receipts[0]],
        usdc.address,
        shares,
        expectedWithdrawAmount,
        false
      );
      let newBalance = await usdc.balanceOf(owner.address);
      expect(newBalance.sub(oldBalance)).to.be.closeTo(
        parseUsdc("10"),
        parseUniform("2.0")
      );

      ({ balances, totalBalance } = await router.getStrategiesValue());
      // console.log(totalBalance, balances);

      expect(await strategyBiswap2.totalTokens()).to.be.lt(parseUsdc("1"));
      expect(await strategyBiswap.totalTokens()).to.be.lt(parseUsdc("1"));
      expect(await usdc.balanceOf(router.address)).to.lt(parseUsdc("1"));

      expect(await sharesToken.balanceOf(owner.address)).to.be.equal(0);
      expect(await sharesToken.balanceOf(router.address)).to.be.closeTo(
        parseEther("1"),
        parseEther("0.01")
      );
    });

    // leave this test to verify rebalance threshold works until refactored
    it("When swap amount is below swap threshold rebalance doesn't happen", async function () {
      let { balances, totalBalance } = await router.getStrategiesValue();

      // strategies should be balanced as 00% and 100%
      expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        50,
        1
      );
      expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        50,
        1
      );

      // deposit to strategies
      await admin.updateStrategy(0, 0);
      await admin.updateStrategy(1, 10000);
      console.log("rebalance");

      await admin.rebalanceStrategies();
      console.log("rebalance2");

      ({ balances, totalBalance } = await router.getStrategiesValue());

      // strategies should be balanced as 00% and 100%
      expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        0,
        1
      );
      expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        100,
        1
      );

      await admin.updateStrategy(0, 500);
      await admin.updateStrategy(1, 9500);

      await admin.rebalanceStrategies();

      ({ balances, totalBalance } = await router.getStrategiesValue());
      // console.log(totalBalance, balances);
      // strategies should be balanced as 0% and 100% cause rebalance didn't happen
      // due to ~0.05 USD to be allocated to the first strategy below the rebalance threshold
      expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        0,
        1
      );
      expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        100,
        1
      );
    });

    it("Test rebalance function", async function () {
      // deposit to strategies
      await admin.updateStrategy(0, 2000);
      await admin.updateStrategy(1, 8000);

      await admin.rebalanceStrategies();

      let { balances, totalBalance } = await router.getStrategiesValue();
      // console.log(totalBalance, balances);
      // strategies should be balanced as 20% and 80%
      expect(balances[0].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        20,
        1
      );
      expect(balances[1].mul(100).div(totalBalance).toNumber()).to.be.closeTo(
        80,
        1
      );
    });
  });
});
