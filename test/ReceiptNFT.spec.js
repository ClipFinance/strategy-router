const { expect, assert } = require("chai");
const { ethers } = require("hardhat");
const { provider, deploy, MaxUint256 } = require("./utils");


describe("Test ReceiptNFT", function () {

    let fakeStrategyRouter, fakeBatching, nonManager, nftRecipient;
    let receiptContractStrategyRouter, receiptContractBatching;
    let snapshotId;
    const fakeTokenAddress = hre.networkVariables.usdc; // BSC USDC live chain

    beforeEach(async function () {
        snapshotId = await provider.send("evm_snapshot");
        [fakeStrategyRouter, fakeBatching, nonManager, nftRecipient] = await ethers.getSigners();

        // get instance that is controlled by fakeStrategyRouter (one of managers)
        receiptContractStrategyRouter = await deploy("ReceiptNFT", fakeStrategyRouter.address, fakeBatching.address);

        // get instance that is controlled by fakeBatching (one of managers)
        receiptContractBatching = receiptContractStrategyRouter.connect(fakeBatching);
    });

    afterEach(async function () {
        await provider.send("evm_revert", [snapshotId]);
    });

    // init smart contract with managers list
    describe("Minting", function () {
        const cycleId = 0;
        const amount = 5000000000000000000n; // bigint

        it("StrategyRouter can mint receipt NFT", async function () {
            // strategy router mint token id 0
            await receiptContractStrategyRouter.mint(cycleId, amount, fakeTokenAddress, nonManager.address);

            // expect receipt 0, minted to non manager, fake token address used, amount
            const receipt0 = await receiptContractStrategyRouter.getReceipt(0); // returns data

            expect(receipt0.cycleId).to.be.eq(0);
            expect(receipt0.amount).to.be.eq(amount);
            expect(receipt0.token).to.be.eq(fakeTokenAddress);

            const receipt0owner = await receiptContractStrategyRouter.ownerOf(0);
            expect(receipt0owner).to.be.eql(nonManager.address);

            const nonManagerTokenAmount = await receiptContractStrategyRouter.balanceOf(nonManager.address);
            expect(nonManagerTokenAmount).to.be.eq(1);
        });

        it("Batching can mint receipt NFT", async function () {
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);

            const receipt0 = await receiptContractStrategyRouter.getReceipt(0); // returns data

            expect(receipt0.cycleId).to.be.eq("0");

            expect(receipt0.amount).to.be.eq(amount);
            expect(receipt0.token).to.be.eq(fakeTokenAddress);

            const receipt0owner = await receiptContractStrategyRouter.ownerOf(0);
            expect(receipt0owner).to.be.eq(nonManager.address);

            const nonManagerTokenAmount = await receiptContractStrategyRouter.balanceOf(nonManager.address);
            expect(nonManagerTokenAmount).to.be.eq(1);
        });

        it("Non manager is not able to mint", async function () {
            // change person who will be making transaction
            let receiptContractNonManager = receiptContractStrategyRouter.connect(nonManager);
            // non-manager fails to mint to himself
            await expect(receiptContractNonManager.mint(0, 0, fakeTokenAddress, nonManager.address))
                .to.be.revertedWith("NotManager()");
            // non-manager fails to mint to 3rd-party nft recipient
            await expect(receiptContractNonManager.mint(0, 0, fakeTokenAddress, nftRecipient.address))
                .to.be.revertedWith("NotManager()");

            // manager mint token id 0
            await receiptContractStrategyRouter.mint(0, 0, fakeTokenAddress, fakeStrategyRouter.address);

            // non-manager fails to burn or setAmount
            await expect(receiptContractNonManager.burn(0)).to.be.revertedWith("NotManager()");
            await expect(receiptContractNonManager.setAmount(0, 0)).to.be.revertedWith("NotManager()");

        });

        //     // TODO
        //     // cycleId is assigned correctly
        //     // cycleId is incremented
        //     // cycleId can't be lower than previous cycleId
        //     // managers issue multiple receipts to different users
        //     // managers issue multiple receipts to the same user
    });

    // TODO implement
    describe("Burning", function () {
        // Manager1 can burn receipt created by himself
        //   Changed quantity of receipts owned by user
        //   Receipt with specific data is not returned anymore
        //   Owner of receipt revoked ownership with provided receipt ID
        // Non-existing receipt can not be burned
        //   Does not change quantity of receipts owned by user
        //   Does not revoke ownership of any existing receipts
        // Manager1 can burn receipt created by other manager
        // Non manager user can't burn receipt
        // After last receipt was burned when manager issues a new receipt and receipt ID counter is incremented
    });

    // TODO implement
    describe("Changing amount", function () {
        // Manager1 can change amount of existing receipt
        // Manager1 can change amount of receipt created by other manager
        // Non manager can't change amount
        // Can't change amount non-existing receipt
        // We can't increase amount and can only decrease (logic in StrategyRouter.sol and Batching.sol)
    });

    describe("Test getTokensOfOwner function", function () {

        it("Wallet with 0 tokens", async function () {
            let tokens = await receiptContractStrategyRouter.getTokensOfOwner(fakeStrategyRouter.address);
            expect(tokens).to.be.empty;
        });

        it("Wallet with 1 token", async function () {
            await mintEmptyReceipt(fakeStrategyRouter.address);

            let tokensRouter = await receiptContractStrategyRouter.getTokensOfOwner(fakeStrategyRouter.address);
            expect(tokensRouter.toString()).to.be.eq("0");

            let tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwner(nonManager.address)
            expect(tokensNonManager).to.be.empty;
        });

        it("Two wallets with 1 token", async function () {
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);
            let tokensRouter = await receiptContractStrategyRouter.getTokensOfOwner(fakeStrategyRouter.address);
            expect(tokensRouter.toString()).to.be.eq("0");
            let tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwner(nonManager.address)
            expect(tokensNonManager.toString()).to.be.eq("1");
        });

        it("Two walets with more tokens", async function () {
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);

            let tokensRouter = await receiptContractStrategyRouter.getTokensOfOwner(fakeStrategyRouter.address);
            expect(tokensRouter.toString()).to.be.eq("4,2,0");
            let tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwner(nonManager.address)
            expect(tokensNonManager.toString()).to.be.eq("5,3,1");
        });
    });

    describe("Test getTokensOfOwnerIn function", function () {

        it("Should revert on wrong range", async function () {
            // start > stop is error!
            await expect(receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 1, 0))
                .to.be.revertedWith("InvalidQueryRange()");
            // start == stop is error!
            await expect(receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 0, 0))
                .to.be.revertedWith("InvalidQueryRange()");
        });

        it("Wallet with 0 tokens", async function () {
            let tokens = await receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 0, 1);
            expect(tokens).to.be.empty;
            tokens = await receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 5, 10);
            expect(tokens).to.be.empty;
        });

        it("Wallet with 1 token", async function () {
            await mintEmptyReceipt(fakeStrategyRouter.address);

            let tokensRouter = await receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 0, 1);
            expect(tokensRouter.toString()).to.be.eq("0");

            let tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwnerIn(nonManager.address, 0, 1)
            expect(tokensNonManager).to.be.empty;
        });

        it("Two wallets with 1 token", async function () {
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);
            let tokensRouter = await receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 0, 1);
            expect(tokensRouter.toString()).to.be.eq("0");

            let tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwnerIn(nonManager.address, 1, 2)
            expect(tokensNonManager.toString()).to.be.eq("1");
        });

        it("Two walets with more tokens", async function () {
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);
            await mintEmptyReceipt(fakeStrategyRouter.address);
            await mintEmptyReceipt(nonManager.address);

            let tokensRouter = await receiptContractStrategyRouter.getTokensOfOwnerIn(fakeStrategyRouter.address, 0, MaxUint256);
            expect(tokensRouter.toString()).to.be.eq("0,2,4");

            let tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwnerIn(nonManager.address, 1, 6);
            expect(tokensNonManager.toString()).to.be.eq("1,3,5");
            // range [3...5], will scan [3,4]
            tokensNonManager = await receiptContractStrategyRouter.getTokensOfOwnerIn(nonManager.address, 3, 5);
            expect(tokensNonManager.toString()).to.be.eq("3");
        });

    });
    // helper to mint NFT with zeroed data, for cases when data is unnecessary
    async function mintEmptyReceipt(to) {
        await receiptContractStrategyRouter.mint(0, 0, ethers.constants.AddressZero, to);
    }
});

