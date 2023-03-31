const { expect } = require("chai");
const { ethers } = require("hardhat");
const { provider, deployProxy } = require("./utils");
const { smock } = require('@defi-wonderland/smock');

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

        oracle = await deployProxy("ChainlinkOracle");
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
        await mockFeed.latestRoundData.returns([0, 0, 0, 0, 0]);
        await expect(oracle.getTokenUsdPrice(fakeToken1.address))
          .to.be.revertedWithCustomError(oracle, "StaleChainlinkPrice");
    });

    it("should getAssetUsdPrice revert on 0 price", async function () {
        let mockFeed = await getMockFeed();

        let tokens = [fakeToken1.address];
        let feeds = [mockFeed.address];
        await oracle.setPriceFeeds(tokens, feeds);

        // roundId = 0, answer = 0, startedAt = 0, updatedAt = 0, answeredInRound = 0
        let timestamp = (await provider.getBlock()).timestamp;
        await mockFeed.latestRoundData.returns([0, 0, 0, timestamp, 0]);

        await expect(oracle.getTokenUsdPrice(fakeToken1.address))
          .to.be.revertedWithCustomError(oracle, "BadPrice");
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
        await mockFeed.latestRoundData.returns([0, price, 0, timestamp, 0]);
        await mockFeed.decimals.returns(decimals);

        let returnData = await oracle.getTokenUsdPrice(fakeToken1.address);
        expect(returnData.price).to.be.equal(price);
        expect(returnData.decimals).to.be.equal(decimals);
    });

    describe('#isTokenSupported', async function () {
        it('return false on unsuppported token', async function () {
            expect(
              await oracle.isTokenSupported(fakeToken2.address)
            ).to.be.false;

            const mockFeed = await getMockFeed();
            const tokens = [fakeToken1.address];
            const feeds = [mockFeed.address];

            await oracle.setPriceFeeds(tokens, feeds);

            expect(
              await oracle.isTokenSupported(fakeToken2.address)
            ).to.be.false;
        });
        it('return true for supported token', async function () {
            const mockFeed = await getMockFeed();
            const tokens = [fakeToken1.address];
            const feeds = [mockFeed.address];

            await oracle.setPriceFeeds(tokens, feeds);

            expect(
              await oracle.isTokenSupported(fakeToken1.address)
            ).to.be.true;
        });
    });

    async function getMockFeed() {
        const abi = (await artifacts.readArtifact("AggregatorV3Interface")).abi;
        const mock = await smock.fake(abi);
        return mock;
    }
});

