const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupCore, setupFakeTokens, setupTokensLiquidityOnPancake, setupTestParams, deployFakeStrategy } = require("./shared/commonSetup");
const { provider, parseUniform, deployProxyIdleStrategy } = require("./utils");

describe("Test Batch", function () {

    let owner, nonReceiptOwner;
    // mock tokens with different decimals
    let usdc, usdt, busd;
    // helper functions to parse amounts of mock tokens
    let parseUsdc, parseBusd, parseUsdt;
    // core contracts
    let router, oracle, exchange, batch, receiptContract, sharesToken;
    // revert to test-ready state
    let snapshotId;
    // revert to fresh fork state
    let initialSnapshot;

    before(async function () {

        [owner, nonReceiptOwner] = await ethers.getSigners();
        initialSnapshot = await provider.send("evm_snapshot");

        // deploy core contracts
        ({ router, oracle, exchange, batch, receiptContract, sharesToken } = await setupCore());

        // deploy mock tokens 
        ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } = await setupFakeTokens(router));

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
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);
            await router.addSupportedToken(usdt);

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
                .to.be.revertedWithCustomError(router, "UnsupportedToken");
        });

        it("should depositToBatch create receipt with correct values", async function () {
            let depositAmount = parseBusd("100");
            await router.depositToBatch(busd.address, depositAmount);

            let newReceipt = await receiptContract.getReceipt(1);
            expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
            expect(newReceipt.token).to.be.equal(busd.address);
            expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
            expect(newReceipt.cycleId).to.be.equal(1);
            expect(await busd.balanceOf(batch.address)).to.be.equal(depositAmount);
        });
        it("should revert when user deposits depegged token that numerically match minimum amount", async function () {
            await router.setMinDepositUsd(parseUniform("1.0"));
            await oracle.setPrice(busd.address, parseBusd("0.1"));
            await expect(router.depositToBatch(busd.address, parseBusd("2.0")))
                .to.be.revertedWithCustomError(batch,"DepositUnderMinimum");
        });
    });

    describe("deposit in other tokens than strategy tokens", function () {
        // snapshot to revert state changes that are made in this scope
        let _snapshot;

        beforeEach(async () => {
            _snapshot = await provider.send("evm_snapshot");

            // setup supported tokens
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);

            // add fake strategies
            await deployFakeStrategy({ router, token: usdc });
            await deployFakeStrategy({ router, token: usdc });
            await deployFakeStrategy({ router, token: usdc });

            // admin initial deposit to set initial shares and pps
            await router.depositToBatch(busd.address, parseBusd("1"));
            await router.allocateToStrategies();

        });

        afterEach(async () => {
            await provider.send("evm_revert", [_snapshot]);
        });

        it("should depositToBatch create receipt with correct values", async function() {
            let depositAmount = parseBusd("100");
            await router.depositToBatch(busd.address, depositAmount);

            let newReceipt = await receiptContract.getReceipt(1);
            expect(await receiptContract.ownerOf(1)).to.be.equal(owner.address);
            expect(newReceipt.token).to.be.equal(busd.address);
            expect(newReceipt.tokenAmountUniform).to.be.equal(parseUniform("100"));
            expect(newReceipt.cycleId).to.be.equal(1);
            expect(await busd.balanceOf(batch.address)).to.be.equal(depositAmount);
        });
    });

    describe("getBatchTotalUsdValue", function () {

        it("happy paths: 1 supported token", async function () {
            await oracle.setPrice(busd.address, parseBusd("0.5"));

            // setup supported tokens
            await router.addSupportedToken(busd);
            // add fake strategies
            await deployFakeStrategy({ router, token: busd });

            await router.depositToBatch(busd.address, parseBusd("100.0"))
            let { totalBalanceUsd, supportedTokenBalancesUsd } = await batch.getBatchValueUsd();

            expect(totalBalanceUsd).to.be.equal(parseUniform("50"));
            expect(supportedTokenBalancesUsd.toString()).to.be.equal(`${parseUniform("50")}`);
        });

        it("3 supported token", async function () {
            await oracle.setPrice(busd.address, parseBusd("0.9"));
            await oracle.setPrice(usdc.address, parseUsdc("0.9"));
            await oracle.setPrice(usdt.address, parseUsdt("1.1"));

            // setup supported tokens
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);
            await router.addSupportedToken(usdt);

            // add fake strategies
            await deployFakeStrategy({ router, token: busd });
            await deployFakeStrategy({ router, token: usdc });
            await deployFakeStrategy({ router, token: usdt });

            await router.depositToBatch(busd.address, parseBusd("100.0"))
            await router.depositToBatch(usdc.address, parseUsdc("100.0"))
            await router.depositToBatch(usdt.address, parseUsdt("100.0"))

            let { totalBalanceUsd, supportedTokenBalancesUsd } = await batch.getBatchValueUsd();
            // 0.9 + 0.9 + 1.1 = 2.9
            expect(totalBalanceUsd).to.be.equal(parseUniform("290"));
            expect(supportedTokenBalancesUsd.toString()).to.be.equal(`${parseUniform("90")},${parseUniform("90")},${parseUniform("110")}`);
        });

    });

    describe("getSupportedTokensWithPriceInUsd", function () {

        it("0 supported tokens", async function () {
            let supportedTokenPrices = await batch.getSupportedTokensWithPriceInUsd();

            expect(supportedTokenPrices.length).to.be.equal(0);
        });

        it("1 supported token", async function () {
            let price = parseBusd("0.5");
            await oracle.setPrice(busd.address, price);
            let priceDecimals = (await oracle.getTokenUsdPrice(busd.address)).decimals;
            // setup supported tokens
            await router.addSupportedToken(busd);

            let supportedTokenPrices = await batch.getSupportedTokensWithPriceInUsd();

            expect(supportedTokenPrices.length).to.be.equal(1);
            expect(supportedTokenPrices[0].price).to.be.equal(price);
            expect(supportedTokenPrices[0].token).to.be.equal(busd.address);
            expect(supportedTokenPrices[0].priceDecimals).to.be.equal(priceDecimals);
        });

        it("3 supported token", async function () {

            let price = parseBusd("0.5");
            let testData = [
                { token: usdc, price: parseBusd("0.7"), priceDecimals: 0 },
                { token: busd, price: parseBusd("0.5"), priceDecimals: 0 },
                { token: usdt, price: parseBusd("0.8"), priceDecimals: 0 },
            ]

            for (let i = 0; i < testData.length; i++) {
                await oracle.setPrice(testData[i].token.address, testData[i].price);
                testData[i].priceDecimals = (await oracle.getTokenUsdPrice(testData[i].token.address)).decimals;
            }

            // setup supported tokens 
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);
            await router.addSupportedToken(usdt);

            let supportedTokenPrices = await batch.getSupportedTokensWithPriceInUsd();

            expect(supportedTokenPrices.length).to.be.equal(3);

            for (let i = 0; i < testData.length; i++) {
                expect(supportedTokenPrices[i].price).to.be.equal(testData[i].price);
                expect(supportedTokenPrices[i].token).to.be.equal(testData[i].token.address);
                expect(supportedTokenPrices[i].priceDecimals).to.be.equal(testData[i].priceDecimals);
            }
            
        });

    });

    describe.skip("getStrategyIndexToSupportedTokenIndexMap", function () {

        it("0 supported tokens 0 strategies", async function () {
            let indexMap = await batch.getStrategyIndexToSupportedTokenIndexMap();

            expect(indexMap.length).to.be.equal(0);
        });

        it("1 supported tokens 0 strategies", async function () {
            await router.addSupportedToken(busd);

            let indexMap = await batch.getStrategyIndexToSupportedTokenIndexMap();

            expect(indexMap.length).to.be.equal(0);
        });

        it("1 supported token 1 strategy", async function () {
            await router.addSupportedToken(busd);
            await deployFakeStrategy({ router, token: busd });
            let indexMap = await batch.getStrategyIndexToSupportedTokenIndexMap();
            expect(indexMap.length).to.be.equal(1);

            let strategyIndex = 0;
            let supportedTokenIndex = 0;
            expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
        });

        it("2 supported token 1 strategy", async function () {
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);
            await deployFakeStrategy({ router, token: busd });
            let indexMap = await batch.getStrategyIndexToSupportedTokenIndexMap();

            expect(indexMap.length).to.be.equal(1);
            let strategyIndex = 0;
            let supportedTokenIndex = 1;
            expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
        });

        it("2 supported token 3 strategy", async function () {
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);
            await deployFakeStrategy({ router, token: busd });
            await deployFakeStrategy({ router, token: usdc });
            await deployFakeStrategy({ router, token: busd });
            let indexMap = await batch.getStrategyIndexToSupportedTokenIndexMap();

            expect(indexMap.length).to.be.equal(3);
            let strategyIndex = 0;
            let supportedTokenIndex = 1;
            expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
            strategyIndex = 1;
            supportedTokenIndex = 0;
            expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
            strategyIndex = 2;
            supportedTokenIndex = 1;
            expect(indexMap[strategyIndex]).to.be.equal(supportedTokenIndex);
        });

    });

    describe("withdraw", function () {

        // snapshot to revert state changes that are made in this scope
        let _snapshot;

        before(async () => {
            _snapshot = await provider.send("evm_snapshot");

            // setup supported tokens
            await router.addSupportedToken(usdc);
            await router.addSupportedToken(busd);
            await router.addSupportedToken(usdt);

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
                .to.be.revertedWithCustomError(batch, "NotReceiptOwner");
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
            await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${usdt.address}`
            );
        });

        it("should be idempotent", async function () {
            await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
            await router.setSupportedToken(usdt.address, false, ethers.constants.AddressZero);
            await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
            expect((await router.getSupportedTokens()).toString()).to.be.equal(
                `${usdt.address}`
            );
        });

        it("should revert when adding the same token twice", async function () {
            await router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address);
            await expect(router.setSupportedToken(usdt.address, true, usdt.idleStrategy.address)).to.be.reverted;
        });

        it("should revert when removing token that is in use by strategy", async function () {
            await router.setSupportedToken(busd.address, true, busd.idleStrategy.address);
            await deployFakeStrategy({ router, token: busd });
            await expect(router.setSupportedToken(busd.address, false, ethers.constants.AddressZero)).to.be.reverted;
        });

        it("reverts on an address that is not a token and has no oracle configured for it", async function () {
            const ownerIdleStrategy = await deployProxyIdleStrategy(owner, router, owner)
            await expect(
              router.setSupportedToken(owner.address, true, ownerIdleStrategy.address)
            ).to.be.reverted;
        });
    });
});