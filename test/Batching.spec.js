const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTokensLiquidityOnPancake, setupTestParams, deployFakeStrategy } = require("./shared/commonSetup");
const { provider, parseUniform } = require("./utils");


describe("Test Batching", function () {

    let owner, nonReceiptOwner;
    // mock tokens with different decimals
    let usdc, usdt, busd;
    // helper functions to parse amounts of mock tokens
    let parseUsdc, parseBusd, parseUsdt;
    // core contracts
    let router, oracle, exchange, batching, receiptContract, sharesToken;
    // revert to test-ready state
    let snapshotId;
    // revert to fresh fork state
    let initialSnapshot;

    before(async function () {

        [owner, nonReceiptOwner] = await ethers.getSigners();
        initialSnapshot = await provider.send("evm_snapshot");

        // deploy core contracts
        ({ router, oracle, exchange, batching, receiptContract, sharesToken } = await setupCore());

        // deploy mock tokens 
        ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens());

        // setup fake token liquidity
        let amount = (1_000_000).toString();
        await setupTokensLiquidityOnPancake(usdc, busd, amount);
        await setupTokensLiquidityOnPancake(busd, usdt, amount);
        await setupTokensLiquidityOnPancake(usdc, usdt, amount);

        // setup params for testing
        await setupTestParams(router, oracle, exchange, usdc, usdt, busd);

        // setup infinite allowance
        await busd.approve(router.address, parseBusd("1000000"));
        await usdc.approve(router.address, parseUsdc("1000000"));
        await usdt.approve(router.address, parseUsdt("1000000"));

        // setup supported tokens
        await router.setSupportedToken(usdc.address, true);
        await router.setSupportedToken(busd.address, true);
        await router.setSupportedToken(usdt.address, true);

        // add fake strategies
        await deployFakeStrategy({ router, token: busd });
        await deployFakeStrategy({ router, token: usdc });
        await deployFakeStrategy({ router, token: usdt });

        // admin initial deposit to set initial shares and pps
        await router.depositToBatch(busd.address, parseBusd("1"));
        await router.depositToStrategies();

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

    describe("deposit", function () {

        it("should revert depositToBatch no allowance", async function () {
            await busd.approve(router.address, 0);
            await expect(router.depositToBatch(busd.address, parseBusd("100"))).to.be.reverted;
        });

        it("should revert depositToBatch if token unsupported", async function () {
            await expect(router.depositToBatch(router.address, parseBusd("100")))
                .to.be.revertedWith("UnsupportedToken");
        });

        it("should depositToBatch create receipt with correct values", async function () {
            let depositAmount = parseBusd("100");
            await router.depositToBatch(busd.address, depositAmount);

            let newReceipt = await receiptContract.getReceipt(1);
            expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
            expect(newReceipt.token).to.be.equal(busd.address);
            expect(newReceipt.amount).to.be.equal(parseUniform("100"));
            expect(newReceipt.cycleId).to.be.equal(1);
            expect(await busd.balanceOf(batching.address)).to.be.equal(depositAmount);
        });
        it("should revert when user deposits depegged token that numerically match minimum amount", async function () {
            await router.setMinDeposit(parseUniform("1.0"));
            await oracle.setPrice(busd.address, parseBusd("0.1"));
            await expect(router.depositToBatch(busd.address, parseBusd("2.0")))
                .to.be.revertedWith("DepositUnderMinimum");
        });
    });

    describe("getBatchingTotalUsdValue", function () {
        it("happy paths: 1 supported token", async function () {
            await oracle.setPrice(busd.address, parseBusd("0.5"));

            await router.removeStrategy(1);
            await router.removeStrategy(1);
            await router.setSupportedToken(usdt.address, false);
            await router.setSupportedToken(usdc.address, false);

            await router.depositToBatch(busd.address, parseBusd("100.0"))
            let { totalBalance, balances } = await router.getBatchingValue();
            expect(totalBalance).to.be.equal(parseUniform("50"));
            expect(balances.toString()).to.be.equal(`${parseUniform("50")}`);
        });

        it("3 supported token", async function () {
            await oracle.setPrice(busd.address, parseBusd("0.9"));
            await oracle.setPrice(usdc.address, parseUsdc("0.9"));
            await oracle.setPrice(usdt.address, parseUsdt("1.1"));

            await router.depositToBatch(busd.address, parseBusd("100.0"))
            await router.depositToBatch(usdc.address, parseUsdc("100.0"))
            await router.depositToBatch(usdt.address, parseUsdt("100.0"))

            let { totalBalance, balances } = await router.getBatchingValue();
            // 0.9 + 0.9 + 1.1 = 2.9
            expect(totalBalance).to.be.equal(parseUniform("290"));
            expect(balances.toString()).to.be.equal(`${parseUniform("90")},${parseUniform("90")},${parseUniform("110")}`);
        });

    });

    describe("withdraw", function () {

        it("shouldn't be able to withdrawFromBatching receipt that doesn't belong to you", async function () {
            await router.depositToBatch(usdc.address, parseUsdc("100"))
            await expect(router.connect(nonReceiptOwner).withdrawFromBatching([1], usdc.address, [MaxUint256]))
                .to.be.revertedWith("NotReceiptOwner()");
        });

        it("should withdrawFromBatching whole amount", async function () {
            await router.depositToBatch(usdc.address, parseUsdc("100"));

            let oldBalance = await usdc.balanceOf(owner.address);
            await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
            let newBalance = await usdc.balanceOf(owner.address);

            expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
        });

        it("should withdrawFromBatching token y when deposited token x", async function () {
            await router.depositToBatch(busd.address, parseBusd("100"))

            let oldBalance = await usdc.balanceOf(owner.address);
            await router.withdrawFromBatching([1], usdc.address, [MaxUint256]);
            let newBalance = await usdc.balanceOf(owner.address);
            expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("100"), parseUsdc("1"));
        });

        it("should withdrawFromBatching half of receipt value", async function () {
            await router.depositToBatch(busd.address, parseBusd("100"))

            // WITHDRAW PART
            oldBalance = await usdc.balanceOf(owner.address);
            await router.withdrawFromBatching([1], usdc.address, [parseUniform("50")]);
            newBalance = await usdc.balanceOf(owner.address);

            let receipt = await receiptContract.getReceipt(1);
            expect(receipt.amount).to.be.closeTo(parseUniform("50"), parseUniform("1"));
            expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
        });

        it("should withdrawFromBatching (and swap tokens x,y into z)", async function () {
            await router.depositToBatch(busd.address, parseBusd("100"));
            await router.depositToBatch(usdc.address, parseUsdc("100"));

            // WITHDRAW PART
            oldBalance = await usdt.balanceOf(owner.address);
            await router.withdrawFromBatching([1, 2], usdt.address, [parseUniform("100"), parseUniform("100")]);
            newBalance = await usdt.balanceOf(owner.address);

            expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdt("200"), parseUsdt("1"));
        });

        it("should withdrawFromBatching correct amount when price changes", async function () {
            await router.depositToBatch(busd.address, parseBusd("100"))

            // set price x10
            await oracle.setPrice(busd.address, parseBusd("10"));

            // current balance is 100 BUSD = 1000$
            // but dex's rates aren't changed! so we'll receive only 50usdc instead of 500.
            oldBalance = await usdc.balanceOf(owner.address);
            await router.withdrawFromBatching([1], usdc.address, [parseUniform("50")]);
            newBalance = await usdc.balanceOf(owner.address);

            let receipt = await receiptContract.getReceipt(1);
            expect(receipt.amount).to.be.closeTo(parseUniform("50"), parseUniform("1"));
            expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdc("50"), parseUsdc("1"));
        });
    });

    describe("setSupportedToken", function () {

        before(async () => {
            // remove strategies and clear supported tokens to be able to test the target function
            await router.removeStrategy(2);
            await router.removeStrategy(1);
            await router.setSupportedToken(usdt.address, false);
            await router.setSupportedToken(usdc.address, false);
            expect((await router.getSupportedTokens()).length).to.be.equal(1);
        })

        it("should add supported token", async function () {
            await router.setSupportedToken(usdt.address, true);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${busd.address},${usdt.address}`
            );
        });

        it("should be idempotent", async function () {
            await router.setSupportedToken(usdt.address, true);
            await router.setSupportedToken(usdt.address, false);
            await router.setSupportedToken(usdt.address, true);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${busd.address},${usdt.address}`
            );
        });

        it("should revert when adding the same token twice", async function () {
            await router.setSupportedToken(usdt.address, true);
            await expect(router.setSupportedToken(usdt.address, true)).to.be.reverted;
        });

        it("should revert when removing token that is in use by strategy", async function () {
            await expect(router.setSupportedToken(busd.address, false)).to.be.reverted;
        });

        it("pass address that is not a token", async function () {
            await router.setSupportedToken(owner.address, true);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${busd.address},${owner.address}`
            );
            await router.setSupportedToken(owner.address, false);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${busd.address}`
            );
        });
    });
});