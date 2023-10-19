const { expect } = require("chai");
const { parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { setupCore, setupParamsOnBNB, setupTokens } = require("./commonSetup");
const {
  skipBlocks,
  BLOCKS_MONTH,
  provider,
  create2DeployProxy,
} = require("../utils");
const { BigNumber } = require("ethers");
const {
  setBalance,
  impersonateAccount,
  stopImpersonatingAccount,
} = require("@nomicfoundation/hardhat-network-helpers");

module.exports = function strategyTest(
  strategyName,
  strategyToken,
  hasOracle = false
) {
  describe(`Test ${strategyName} strategy`, function () {
    let owner;
    // create2 deploy data
    let create2Deployer, ProxyBytecode;
    // core contracts
    let router, oracle, exchange;
    let strategy;
    // strategy's deposit token
    let depositToken;
    // helper function to parse deposit token amounts
    let parseAmount;

    let amountDeposit;
    let amountWithdraw;
    let snapshotId;

    before(async function () {
      [owner] = await ethers.getSigners();

      snapshotId = await provider.send("evm_snapshot");

      // deploy core contracts
      ({ router, oracle, exchange, admin, create2Deployer, ProxyBytecode } =
        await setupCore(
          hasOracle
            ? {
                batchContract: "Batch",
                oracleContract: "ChainlinkOracle",
              }
            : undefined
        ));

      // setup params for testing
      await setupParamsOnBNB(admin, router, oracle, exchange);

      // get tokens on bnb chain for testing
      const tokens = await setupTokens();

      // set oracle prices if needed
      if (hasOracle) {
        const { usdt, busd, usdc, hay } = tokens;

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
      }

      // get deposit token and parse helper function
      depositToken = tokens[strategyToken];
      let decimals = await depositToken.decimals();
      parseAmount = (amount) => parseUnits(amount, decimals);

      // deploy strategy to test
      // strategy = await deploy(strategyName, router.address);
      ({ proxyContract: strategy } = await create2DeployProxy({
        create2Deployer,
        ProxyBytecode,
        ContractName: strategyName,
        constructorArgs: hasOracle
          ? [router.address, oracle.address, 2000]
          : [router.address],

        initializeTypes: ["address", "uint256", "uint16", "address[]"],
        initializeArgs: [
          owner.address,
          parseAmount((1_000_000).toString()),
          500, // 5%
          [owner.address],
        ],
      }));
    });

    after(async function () {
      await provider.send("evm_revert", [snapshotId]);
    });

    it("deposit function", async function () {
      amountDeposit = parseAmount("10000");

      let balanceBefore = await depositToken.balanceOf(owner.address);
      await depositToken.transfer(strategy.address, amountDeposit);
      await strategy.deposit(amountDeposit);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      expect(totalTokens).to.be.closeTo(amountDeposit, parseAmount("100"));
      expect(balanceBefore.sub(balanceAfter)).to.be.equal(amountDeposit);
    });

    it("withdraw function", async function () {
      amountWithdraw = parseAmount("5000");

      let balanceBefore = await depositToken.balanceOf(owner.address);
      await strategy.withdraw(amountWithdraw);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      const amountWithdrawDelta = amountWithdraw.mul(12).div(10000); // 0.12%
      expect(totalTokens).to.be.closeTo(
        amountDeposit.sub(amountWithdraw),
        amountWithdrawDelta
      );
      expect(balanceAfter.sub(balanceBefore)).to.be.closeTo(
        amountWithdraw,
        amountWithdrawDelta
      );
    });

    it("Withdraw all", async function () {
      amountWithdraw = await strategy.totalTokens();
      let balanceBefore = await depositToken.balanceOf(owner.address);
      await strategy.withdraw(amountWithdraw);
      let balanceAfter = await depositToken.balanceOf(owner.address);
      let totalTokens = await strategy.totalTokens();

      const amountWithdrawDelta = amountWithdraw.mul(10).div(10000); // 0.1%
      expect(totalTokens).to.be.closeTo(BigNumber.from(0), amountWithdrawDelta);
      expect(balanceAfter.sub(balanceBefore)).to.be.closeTo(
        amountWithdraw,
        amountWithdrawDelta
      );
    });

    it("compound function, and protocol commissions", async function () {
      await depositToken.transfer(strategy.address, amountDeposit);
      await strategy.deposit(amountDeposit);

      // compound, should increase totalTokens
      let oldBalance = await strategy.totalTokens();

      // skip blocks
      !hasOracle ? await skipBlocks(BLOCKS_MONTH) : await skipBlocks(500);
      await strategy.compound();

      let newBalance = await strategy.totalTokens();

      expect(newBalance).to.be.gt(oldBalance);
      // withdraw all
      oldBalance = await depositToken.balanceOf(owner.address);
      amountWithdraw = await strategy.totalTokens();
      await strategy.withdraw(amountWithdraw);
      newBalance = await depositToken.balanceOf(owner.address);

      // the delta is 0.5% of the amountWithdraw because of compound
      const amountWithdrawDelta = amountWithdraw.mul(50).div(10000); // 0.5%
      expect(await strategy.totalTokens()).to.be.within(0, amountWithdrawDelta);
      expect(newBalance.sub(oldBalance)).to.be.closeTo(
        amountDeposit,
        amountWithdrawDelta
      );
    });

    it("withdrawAll function", async function () {
      amountDeposit = parseAmount("10000");
      await depositToken.transfer(strategy.address, amountDeposit);
      await strategy.deposit(amountDeposit);

      const totalTokensBeforeWithdrawAll = await strategy.totalTokens();

      let oldBalance = await depositToken.balanceOf(owner.address);
      await strategy.withdrawAll();
      let newBalance = await depositToken.balanceOf(owner.address);

      expect(await strategy.totalTokens()).to.be.equal(0);

      const totalTokensDelta = totalTokensBeforeWithdrawAll.mul(10).div(10000); // 0.1%
      expect(newBalance.sub(oldBalance)).to.be.closeTo(
        totalTokensBeforeWithdrawAll,
        totalTokensDelta
      );
    });
  });
};
