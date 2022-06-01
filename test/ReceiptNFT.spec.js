const { expect } = require("chai");
const { ethers } = require("hardhat");
const { provider } = require("./utils");


describe("Test ReceiptNFT", function () {

    let fakeStrategyRouter, fakeBatching, nonManager, nftRecipient;
    let receiptContractStrategyRouter, receiptContractBatching;
    let snapshotId;
    let fakeTokenAddress = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'; // BSC USDC live chain
    // helper function to convert BigNumbers in array to Numbers
    let arrayToNumber = arr => arr.map(n => n.toNumber());

    beforeEach(async function () {
        snapshotId = await provider.send("evm_snapshot");
        [fakeStrategyRouter, fakeBatching, nonManager, nftRecipient] = await ethers.getSigners();

        receiptContractStrategyRouter = await ethers.getContractFactory("ReceiptNFT");
        receiptContractStrategyRouter = await receiptContractStrategyRouter.deploy();

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

        beforeEach(async function() {
            await receiptContractStrategyRouter.init(fakeStrategyRouter.address, fakeBatching.address);
        });

        it("StrategyRouter can mint receipt NFT", async function () {
            // strategy router mint token id 0
            await receiptContractStrategyRouter.mint(cycleId, amount, fakeTokenAddress, nonManager.address);

            // expect receipt 0, minted to non manager, fake token address used, amount
            const receipt0 = await receiptContractStrategyRouter.getReceipt(0); // returns data

            expect(receipt0.cycleId.toString()).to.be.eql("0"); // toString cause JS rocks
            expect(receipt0.cycleId).to.be.eql(new ethers.BigNumber.from(0)); // alternative

            expect(receipt0.amount.toString()).to.be.eql(amount.toString());
            expect(receipt0.token.toLowerCase()).to.be.eql(fakeTokenAddress); // lower case due to normalized eth checksum

            const receipt0owner = await receiptContractStrategyRouter.ownerOf(0);
            expect(receipt0owner).to.be.eql(nonManager.address);

            const nonManagerTokenAmount = await receiptContractStrategyRouter.balanceOf(nonManager.address);
            expect(nonManagerTokenAmount.toString()).to.be.eql("1");
        });

        it("Batching can mint receipt NFT", async function () {
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);

            const receipt0 = await receiptContractStrategyRouter.getReceipt(0); // returns data

            expect(receipt0.cycleId.toString()).to.be.eql("0"); // toString cause JS rocks
            expect(receipt0.cycleId).to.be.eql(new ethers.BigNumber.from(0)); // alternative

            expect(receipt0.amount.toString()).to.be.eql(amount.toString());
            expect(receipt0.token.toLowerCase()).to.be.eql(fakeTokenAddress); // lower case due to normalized eth checksum

            const receipt0owner = await receiptContractStrategyRouter.ownerOf(0);
            expect(receipt0owner).to.be.eql(nonManager.address);

            const nonManagerTokenAmount = await receiptContractStrategyRouter.balanceOf(nonManager.address);
            expect(nonManagerTokenAmount.toString()).to.be.eql("1");
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

        // TODO
        // cycleId is assigned correctly
        // cycleId is incremented
        // cycleId can't be lower than previous cycleId
        // managers issue multiple receipts to different users
        // managers issue multiple receipts to the same user
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

    describe("Test getTokensOwnedBy function", function () {

        beforeEach(async function () {
            await receiptContractStrategyRouter.init(fakeStrategyRouter.address, fakeStrategyRouter.address);
        });

        //  await receiptContract.init(owner.address, owner.address);
        it("Wallet with 0 tokens", async function () {
            expect(await receiptContractStrategyRouter.getTokensOwnedBy(fakeStrategyRouter.address)).to.be.empty;
        });

        it("Wallet with 1 token", async function () {
            await mintReceipt(fakeStrategyRouter.address);
            expect(arrayToNumber(await receiptContractStrategyRouter.getTokensOwnedBy(fakeStrategyRouter.address))).to.be.eql([0]);
            expect(await receiptContractStrategyRouter.getTokensOwnedBy(nonManager.address)).to.be.empty;
        });

        it("Two wallets with 1 token", async function () {
            await mintReceipt(fakeStrategyRouter.address);
            await mintReceipt(nonManager.address);
            expect(arrayToNumber(await receiptContractStrategyRouter.getTokensOwnedBy(fakeStrategyRouter.address))).to.be.eql([0]);
            expect(arrayToNumber(await receiptContractStrategyRouter.getTokensOwnedBy(nonManager.address))).to.be.eql([1]);
        });

        it("Two walets with more tokens", async function () {
            await mintReceipt(fakeStrategyRouter.address);
            await mintReceipt(nonManager.address);
            await mintReceipt(fakeStrategyRouter.address);
            await mintReceipt(nonManager.address);
            await mintReceipt(fakeStrategyRouter.address);
            await mintReceipt(nonManager.address);
            expect(arrayToNumber(await receiptContractStrategyRouter.getTokensOwnedBy(fakeStrategyRouter.address))).to.be.eql([4, 2, 0]);
            expect(arrayToNumber(await receiptContractStrategyRouter.getTokensOwnedBy(nonManager.address))).to.be.eql([5, 3, 1]);
        });
    });

    async function mintReceipt(to) {
        await receiptContractStrategyRouter.mint(0, 0, ethers.constants.AddressZero, to);
    }
});

