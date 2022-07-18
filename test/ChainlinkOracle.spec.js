const { expect, assert } = require("chai");
const { deployMockContract } = require("ethereum-waffle");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { provider, deploy, MaxUint256, parseUniform } = require("./utils");


describe("Test ChainlinkOracle", function () {

    let owner, nonOwner;
    let fakePriceFeed, fakeToken1, fakeToken2,
        fakePriceFeed2, fakeToken3, fakeToken4;
    let snapshotId;
    let oracle;

    beforeEach(async function () {
        snapshotId = await provider.send("evm_snapshot");
        [owner, nonOwner,
            fakePriceFeed, fakeToken1, fakeToken2,
            fakePriceFeed2, fakeToken3, fakeToken4] = await ethers.getSigners();

        // silence warnings about proxy's unsafeAllow, for tests
        upgrades.silenceWarnings();
        // get instance that is controlled by fakeStrategyRouter (one of managers)
        let ChainlinkOracle = await ethers.getContractFactory("ChainlinkOracle");
        oracle = await upgrades.deployProxy(ChainlinkOracle, [], {
            kind: 'uups',
            unsafeAllow: ["constructor"],
        });
        await oracle.deployed();
    });

    afterEach(async function () {
        await provider.send("evm_revert", [snapshotId]);
    });

    it("should setPriceFeeds be onlyOwner", async function () {
        await expect(oracle.connect(nonOwner).setPriceFeeds([], [])).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should setPriceFeeds store feed address", async function () {
        let tokens = [fakeToken1.address, fakeToken2.address];
        let feeds = [fakePriceFeed.address, fakePriceFeed2.address];
        await oracle.setPriceFeeds(tokens, feeds);
        expect(await oracle.feeds(fakeToken1.address)).to.be.eq(fakePriceFeed.address);
    });

    it("should getAssetUsdPrice revert on stale price", async function () {
        let mockFeed = await getMockFeed();

        let tokens = [fakeToken1.address];
        let feeds = [mockFeed.address];
        await oracle.setPriceFeeds(tokens, feeds);

        // roundId = 0, answer = 0, startedAt = 0, updatedAt = 0, answeredInRound = 0
        await mockFeed.mock.latestRoundData.returns(0, 0, 0, 0, 0);
        await expect(oracle.getTokenUsdPrice(fakeToken1.address)).to.be.revertedWith("StaleChainlinkPrice()");
    });

    it("should getAssetUsdPrice revert on 0 price", async function () {
        let mockFeed = await getMockFeed();

        let tokens = [fakeToken1.address];
        let feeds = [mockFeed.address];
        await oracle.setPriceFeeds(tokens, feeds);

        // roundId = 0, answer = 0, startedAt = 0, updatedAt = 0, answeredInRound = 0
        let timestamp = (await provider.getBlock()).timestamp;
        await mockFeed.mock.latestRoundData.returns(0, 0, 0, timestamp, 0);

        await expect(oracle.getTokenUsdPrice(fakeToken1.address)).to.be.revertedWith("BadPrice()");
    });

    it("should getAssetUsdPrice return price and price decimals", async function () {
        let mockFeed = await getMockFeed();

        let tokens = [fakeToken1.address];
        let feeds = [mockFeed.address];
        await oracle.setPriceFeeds(tokens, feeds);

        // roundId = 0, answer = 0, startedAt = 0, updatedAt = 0, answeredInRound = 0
        let timestamp = (await provider.getBlock()).timestamp;
        let price = 1337;
        let decimals = 18;
        await mockFeed.mock.latestRoundData.returns(0, price, 0, timestamp, 0);
        await mockFeed.mock.decimals.returns(decimals);

        let returnData = await oracle.getTokenUsdPrice(fakeToken1.address);
        expect(returnData.price).to.be.equal(price);
        expect(returnData.decimals).to.be.equal(decimals);
    });

    async function getMockFeed() {
        const abi = (await artifacts.readArtifact("AggregatorV3Interface")).abi;
        const mock = await deployMockContract(owner, abi);
        return mock;
    }
});

