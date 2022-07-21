const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTokensLiquidityOnPancake, setupTestParams, deployFakeStrategy } = require("./shared/commonSetup");
const { provider, parseUniform } = require("./utils");


describe("Test Batch", function () {

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
        // snapshot to revert state changes that are made in this scope
        let _snapshot;

        before(async () => {
            _snapshot = await provider.send("evm_snapshot");

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
            await router.allocateToStrategies();

        });

        after(async () => {
            await provider.send("evm_revert", [_snapshot]);
        });

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
            expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
            expect(newReceipt.cycleId).to.be.equal(1);
            expect(await busd.balanceOf(batching.address)).to.be.equal(depositAmount);
        });
        it("should revert when user deposits depegged token that numerically match minimum amount", async function () {
            await router.setMinDepositUsd(parseUniform("1.0"));
            await oracle.setPrice(busd.address, parseBusd("0.1"));
            await expect(router.depositToBatch(busd.address, parseBusd("2.0")))
                .to.be.revertedWith("DepositUnderMinimum");
        });
    });

    describe("getBatchTotalUsdValue", function () {

        it("happy paths: 1 supported token", async function () {
            await oracle.setPrice(busd.address, parseBusd("0.5"));

            // setup supported tokens
            await router.setSupportedToken(busd.address, true);
            // add fake strategies
            await deployFakeStrategy({ router, token: busd });

            await router.depositToBatch(busd.address, parseBusd("100.0"))
            let { totalBalance, balances } = await router.getBatchValueUsd();
            expect(totalBalance).to.be.equal(parseUniform("50"));
            expect(balances.toString()).to.be.equal(`${parseUniform("50")}`);
        });

        it("3 supported token", async function () {
            await oracle.setPrice(busd.address, parseBusd("0.9"));
            await oracle.setPrice(usdc.address, parseUsdc("0.9"));
            await oracle.setPrice(usdt.address, parseUsdt("1.1"));

            // setup supported tokens
            await router.setSupportedToken(usdc.address, true);
            await router.setSupportedToken(busd.address, true);
            await router.setSupportedToken(usdt.address, true);

            // add fake strategies
            await deployFakeStrategy({ router, token: busd });
            await deployFakeStrategy({ router, token: usdc });
            await deployFakeStrategy({ router, token: usdt });

            await router.depositToBatch(busd.address, parseBusd("100.0"))
            await router.depositToBatch(usdc.address, parseUsdc("100.0"))
            await router.depositToBatch(usdt.address, parseUsdt("100.0"))

            let { totalBalance, balances } = await router.getBatchValueUsd();
            // 0.9 + 0.9 + 1.1 = 2.9
            expect(totalBalance).to.be.equal(parseUniform("290"));
            expect(balances.toString()).to.be.equal(`${parseUniform("90")},${parseUniform("90")},${parseUniform("110")}`);
        });

    });

    describe("withdraw", function () {

        // snapshot to revert state changes that are made in this scope
        let _snapshot;

        before(async () => {
            _snapshot = await provider.send("evm_snapshot");

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
            await router.allocateToStrategies();

        });

        after(async () => {
            await provider.send("evm_revert", [_snapshot]);
        });

        it("shouldn't be able to withdraw receipt that doesn't belong to you", async function () {
            await router.depositToBatch(usdc.address, parseUsdc("100"))
            await expect(router.connect(nonReceiptOwner).withdrawFromBatch([1]))
                .to.be.revertedWith("NotReceiptOwner()");
        });

        it("should burn receipts when withdraw whole amount noted in it", async function () {
            await router.depositToBatch(usdc.address, parseUsdc("100"));

            let receipts = await receiptContract.getTokensOfOwner(owner.address);
            expect(receipts.toString()).to.be.eq("1,0");

            await router.withdrawFromBatch([1]);

            receipts = await receiptContract.getTokensOfOwner(owner.address);
            expect(receipts.toString()).to.be.eq("0");
        });

        it("should withdraw whole amount", async function () {
            await router.depositToBatch(usdc.address, parseUsdc("100"));

            let oldBalance = await usdc.balanceOf(owner.address);
            await router.withdrawFromBatch([1]);
            let newBalance = await usdc.balanceOf(owner.address);

            expect(newBalance.sub(oldBalance)).to.be.equal(parseUsdc("100"));
        });

        it("should withdraw two receipts and receive tokens noted in them", async function () {
            await router.depositToBatch(busd.address, parseBusd("100"));
            await router.depositToBatch(usdt.address, parseUsdt("100"));

            // WITHDRAW PART
            oldBalance = await usdt.balanceOf(owner.address);
            oldBalance2 = await busd.balanceOf(owner.address);
            await router.withdrawFromBatch([1, 2]);
            newBalance = await usdt.balanceOf(owner.address);
            newBalance2 = await busd.balanceOf(owner.address);

            expect(newBalance.sub(oldBalance)).to.be.closeTo(parseUsdt("100"), parseUsdt("1"));
            expect(newBalance2.sub(oldBalance2)).to.be.closeTo(parseBusd("100"), parseBusd("1"));
        });

    });

    describe("setSupportedToken", function () {

        it("should add supported token", async function () {
            await router.setSupportedToken(usdt.address, true);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${usdt.address}`
            );
        });

        it("should be idempotent", async function () {
            await router.setSupportedToken(usdt.address, true);
            await router.setSupportedToken(usdt.address, false);
            await router.setSupportedToken(usdt.address, true);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${usdt.address}`
            );
        });

        it("should revert when adding the same token twice", async function () {
            await router.setSupportedToken(usdt.address, true);
            await expect(router.setSupportedToken(usdt.address, true)).to.be.reverted;
        });

        it("should revert when removing token that is in use by strategy", async function () {
            await router.setSupportedToken(busd.address, true);
            await deployFakeStrategy({ router, token: busd });
            await expect(router.setSupportedToken(busd.address, false)).to.be.reverted;
        });

        it("pass address that is not a token", async function () {
            await router.setSupportedToken(owner.address, true);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${owner.address}`
            );
            await router.setSupportedToken(owner.address, false);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                ``
            );
        });
    });
});