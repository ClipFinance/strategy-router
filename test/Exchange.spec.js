const { expect, assert } = require("chai");
const { parseEther, parseUnits } = require("ethers/lib/utils");
const { ethers, artifacts } = require("hardhat");
const { provider, deploy, MaxUint256 } = require("./utils");
const { setupCore, setupFakeTokens, setupTestParams, setupTokensLiquidityOnPancake, deployFakeStrategy } = require("./shared/commonSetup");
const { deployMockContract } = require("ethereum-waffle");
const { BigNumber } = require("ethers");

describe("Test Exchange", function () {
    let owner, nonOwner, stubPlugin, stubPlugin2;
    // mock tokens with different decimals
    let usdc, usdt, busd;
    // helper functions to parse amounts of mock tokens
    let parseUsdc, parseBusd, parseUsdt;
    // core contracts
    let router, oracle, exchange, exchangeNonOwner;
    // revert to test-ready state
    let snapshotId;
    // revert to fresh fork state
    let initialSnapshot;

    before(async function () {

        [owner, nonOwner, stubPlugin, stubPlugin2] = await ethers.getSigners();
        initialSnapshot = await provider.send("evm_snapshot");

        // deploy core contracts
        ({ router, exchange, oracle } = await setupCore());
        exchangeNonOwner = await exchange.connect(nonOwner);

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
        await router.allocateToStrategies();
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


    // init smart contract with managers list
    describe("setRoute", function () {
        it("should be onlyOwner", async function () {
            await expect(exchangeNonOwner.setRoute([usdc.address], [usdc.address], [usdc.address]))
                .to.be.revertedWith("Ownable: caller is not the owner");
        });
        it("should store default route", async function () {
            await exchange.setRoute([usdc.address], [busd.address], [stubPlugin.address]);
            let [token0, token1] = BigNumber.from(usdc.address).lt(BigNumber.from(busd.address)) 
                ? [usdc.address, busd.address] 
                : [busd.address, usdc.address];
            let route = await exchange.routes(token0, token1);
            expect(route.defaultRoute).to.be.equal(stubPlugin.address);
        });
    });
    describe("setRouteEx", function () {
        it("should be onlyOwner", async function () {
            let routeParams = { defaultRoute: usdc.address, limit: 0, secondRoute: usdc.address };
            await expect(exchangeNonOwner.setRouteEx([usdc.address], [usdc.address], [routeParams]))
                .to.be.revertedWith("Ownable: caller is not the owner");
        });
        it("should store all RouteParams", async function () {
            let routeParams = { defaultRoute: stubPlugin.address, limit: parseUnits("1", 12), secondRoute: stubPlugin2.address };
            await exchange.setRouteEx([usdc.address], [busd.address], [routeParams])
            let [token0, token1] = BigNumber.from(usdc.address).lt(BigNumber.from(busd.address)) 
                ? [usdc.address, busd.address] 
                : [busd.address, usdc.address];
            let route = await exchange.routes(token0, token1);
            expect(route.defaultRoute).to.be.equal(routeParams.defaultRoute);
            expect(route.limit).to.be.equal(routeParams.limit);
            expect(route.secondRoute).to.be.equal(routeParams.secondRoute);
        });
    });
    describe("getPlugin", function () {
        it("should revert when plugin not set", async function () {
            await expect(exchangeNonOwner.getPlugin(0, usdc.address, usdc.address))
                .to.be.revertedWith("RouteNotFound()");
        });
        it("should return correct plugin based on input amount", async function () {
            // setup route
            let routeParams = { defaultRoute: stubPlugin.address, limit: parseUnits("1", 12), secondRoute: stubPlugin2.address };
            await exchange.setRouteEx([usdc.address], [busd.address], [routeParams])

            // get plugin
            let plugin = await exchangeNonOwner.getPlugin(0, usdc.address, busd.address);
            expect(plugin).to.be.equal(routeParams.defaultRoute);
            // exceed limit input amount
            plugin = await exchangeNonOwner.getPlugin(routeParams.limit, busd.address, usdc.address);
            expect(plugin).to.be.equal(routeParams.secondRoute);
        });
    });
    describe("getFee", function () {
        it("should revert when plugin not set", async function () {
            await expect(exchangeNonOwner.getFee(0, usdc.address, usdc.address))
                .to.be.revertedWith("RouteNotFound()");
        });
        it("should query correct plugin for fee based on input amount", async function () {
            // setup mocks
            let mockPlugin = await getMockPlugin();
            let fee = 100;
            await mockPlugin.mock.getFee.returns(fee);

            let mockPlugin2 = await getMockPlugin();
            let fee2 = 333;
            await mockPlugin2.mock.getFee.returns(fee2);

            // setup route
            let routeParams = { defaultRoute: mockPlugin.address, limit: parseUnits("1", 12), secondRoute: mockPlugin2.address };
            await exchange.setRouteEx([usdc.address], [busd.address], [routeParams])

            // get fee
            let feeReturned = await exchangeNonOwner.getFee(0, usdc.address, busd.address);
            expect(feeReturned).to.be.equal(fee);
            // exceed limit input amount
            feeReturned = await exchangeNonOwner.getFee(parseUsdc("1.1"), usdc.address, busd.address);
            expect(feeReturned).to.be.equal(fee2);
        });
    });
    describe("swap", function () {
        it("should revert when plugin not set", async function () {
            await expect(exchangeNonOwner.swap(0, usdc.address, usdc.address, owner.address))
                .to.be.revertedWith("RouteNotFound()");
        });
        it("should revert when received 0", async function () {
            // setup mocks
            let mockPlugin = await getMockPlugin();
            let swapReturns = 0;
            await mockPlugin.mock.swap.returns(swapReturns);

            // setup route
            let routeParams = { defaultRoute: mockPlugin.address, limit: parseUnits("1", 12), secondRoute: stubPlugin.address };
            await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

            // do swap
            await expect(exchangeNonOwner.swap(0, usdc.address, busd.address, owner.address))
                .to.be.revertedWith("RoutedSwapFailed()")
        });
        it("should swap on correct plugin based on input amount", async function () {
            // setup mocks
            let mockPlugin = await getMockPlugin();
            let swapReturns = 1337;
            await mockPlugin.mock.swap.returns(swapReturns);

            let mockPlugin2 = await getMockPlugin();
            let swapReturns2 = 666;
            await mockPlugin2.mock.swap.returns(swapReturns2);

            // setup route
            let routeParams = { defaultRoute: mockPlugin.address, limit: parseUnits("1", 12), secondRoute: mockPlugin2.address };
            await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

            // do swap
            let received = await exchangeNonOwner.callStatic.swap(0, usdc.address, busd.address, owner.address);
            expect(received).to.be.equal(swapReturns);
            
            // exceed limit input amount
            await usdc.transfer(exchangeNonOwner.address, parseUsdc("1.1"));
            received = await exchangeNonOwner.callStatic.swap(parseUsdc("1.1"), usdc.address, busd.address, owner.address);
            expect(received).to.be.equal(swapReturns2);
        });
    });
    describe("getAmountOut", function () {
        it("should revert when plugin not set", async function () {
            await expect(exchangeNonOwner.getAmountOut(0, usdc.address, usdc.address))
                .to.be.revertedWith("RouteNotFound()");
        });
        it("should query correct plugin based on input amount", async function () {
            // setup mocks
            let mockPlugin = await getMockPlugin();
            let amountOut = 1337;
            await mockPlugin.mock.getAmountOut.returns(amountOut);

            let mockPlugin2 = await getMockPlugin();
            let amountOut2 = 1337;
            await mockPlugin2.mock.getAmountOut.returns(amountOut2);

            // setup route
            let routeParams = { defaultRoute: mockPlugin.address, limit: parseUnits("1", 12), secondRoute: mockPlugin2.address };
            await exchange.setRouteEx([usdc.address], [busd.address], [routeParams]);

            // do swap
            let received = await exchangeNonOwner.getAmountOut(0, usdc.address, busd.address);
            expect(received).to.be.equal(amountOut);
            
            // exceed limit input amount
            received = await exchangeNonOwner.getAmountOut(parseUsdc("1.1"), usdc.address, busd.address);
            expect(received).to.be.equal(amountOut2);
        });
    });
    async function getMockPlugin() {
        const abi = (await artifacts.readArtifact("IExchangePlugin")).abi;
        const mock = await deployMockContract(owner, abi);
        return mock;
    }
});

