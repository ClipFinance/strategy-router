const { expect, assert } = require("chai");
const { parseEther } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { provider, deploy, MaxUint256 } = require("./utils");


describe("Test ReceiptNFT", function () {

    let fakeStrategyRouter, fakeBatching, nonManager, nftRecipient;
    let receiptContractStrategyRouter, receiptContractBatching, receiptContractNonManager;
    let snapshotId;
    const fakeTokenAddress = hre.networkVariables.usdc; // BSC USDC live chain
    let cycleId = 0;
    let amount = parseEther("1"); // 1e18

    beforeEach(async function () {
        snapshotId = await provider.send("evm_snapshot");
        [fakeStrategyRouter, fakeBatching, nonManager, nftRecipient] = await ethers.getSigners();

        // get instance that is controlled by fakeStrategyRouter (one of managers)
        receiptContractStrategyRouter = await deploy("ReceiptNFT", fakeStrategyRouter.address, fakeBatching.address);

        // get instance that is controlled by fakeBatching (one of managers)
        receiptContractBatching = receiptContractStrategyRouter.connect(fakeBatching);

        // get instance that is controlled by non-manager 
        receiptContractNonManager = receiptContractStrategyRouter.connect(nonManager);

    });

    afterEach(async function () {
        await provider.send("evm_revert", [snapshotId]);
    });

    // init smart contract with managers list
    describe("Minting", function () {

        it("StrategyRouter can mint receipt NFT", async function () {
            // strategy router mint token id 0
            cycleId = 5;
            await receiptContractStrategyRouter.mint(cycleId, amount, fakeTokenAddress, nonManager.address);

            // expect receipt 0, minted to non manager, fake token address used, amount
            const receipt0 = await receiptContractStrategyRouter.getReceipt(0); 

            expect(receipt0.cycleId).to.be.eq(cycleId);
            expect(receipt0.amount).to.be.eq(amount);
            expect(receipt0.token).to.be.eq(fakeTokenAddress);

            const receipt0owner = await receiptContractStrategyRouter.ownerOf(0);
            expect(receipt0owner).to.be.eql(nonManager.address);

            const nonManagerTokenAmount = await receiptContractStrategyRouter.balanceOf(nonManager.address);
            expect(nonManagerTokenAmount).to.be.eq(1);
        });

        it("Batching can mint receipt NFT", async function () {
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);

            const receipt0 = await receiptContractStrategyRouter.getReceipt(0); 

            expect(receipt0.cycleId).to.be.eq(cycleId);

            expect(receipt0.amount).to.be.eq(amount);
            expect(receipt0.token).to.be.eq(fakeTokenAddress);

            const receipt0owner = await receiptContractStrategyRouter.ownerOf(0);
            expect(receipt0owner).to.be.eq(nonManager.address);

            const nonManagerTokenAmount = await receiptContractStrategyRouter.balanceOf(nonManager.address);
            expect(nonManagerTokenAmount).to.be.eq(1);
        });

        it("Non manager is not able to mint", async function () {
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

        it("Managers issue multiple receipts to different users", async function () {

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            await verifyReceiptData(0, cycleId, amount, fakeTokenAddress, nonManager);

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nftRecipient.address);
            await verifyReceiptData(1, cycleId, amount, fakeTokenAddress, nftRecipient);

            await receiptContractStrategyRouter.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            await verifyReceiptData(2, cycleId, amount, fakeTokenAddress, nonManager);

            await receiptContractStrategyRouter.mint(cycleId, amount, fakeTokenAddress, nftRecipient.address);
            await verifyReceiptData(3, cycleId, amount, fakeTokenAddress, nftRecipient);

            let balanceOfNonManager = await receiptContractBatching.balanceOf(nonManager.address);
            expect(balanceOfNonManager).to.be.eq(2);
            let balanceOfNftRecipient = await receiptContractBatching.balanceOf(nftRecipient.address);
            expect(balanceOfNftRecipient).to.be.eq(2);
        });
    });

    describe("Burning", function () {
        it("Non manager user can't burn receipt", async function () {

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            let balanceOfNonManager = await receiptContractBatching.balanceOf(nonManager.address);
            expect(balanceOfNonManager).to.be.eq(1);

            await expect(receiptContractNonManager.burn(1)).to.be.revertedWith("NotManager");
        });

        it("Non-existing receipt can not be burned", async function () {
            await expect(receiptContractBatching.burn(0))
                .to.be.revertedWith("ERC721: owner query for nonexistent token");
        });

        it("Manager can burn receipt created by himself", async function () {

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            await receiptContractBatching.burn(0);
            await expect(receiptContractStrategyRouter.ownerOf(0))
                .to.be.revertedWith("ERC721: owner query for nonexistent token");
            await expect(receiptContractStrategyRouter.getReceipt(0))
                .to.be.revertedWith("NonExistingToken()");

            let balanceOfNonManager = await receiptContractBatching.balanceOf(nonManager.address);
            expect(balanceOfNonManager).to.be.eq(0);
        });

        it("Manager can burn receipt created by other manager", async function () {

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            await receiptContractStrategyRouter.burn(0);
            await expect(receiptContractStrategyRouter.ownerOf(0))
                .to.be.revertedWith("ERC721: owner query for nonexistent token");
            await expect(receiptContractStrategyRouter.getReceipt(0))
                .to.be.revertedWith("NonExistingToken()");

            let balanceOfNonManager = await receiptContractBatching.balanceOf(nonManager.address);
            expect(balanceOfNonManager).to.be.eq(0);
        });

        it("After last receipt was burned when manager issues a new receipt and receipt ID counter is incremented", async function () {

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            await receiptContractStrategyRouter.burn(0);

            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            await verifyReceiptData(1, cycleId, amount, fakeTokenAddress, nonManager);

            let balanceOfNonManager = await receiptContractBatching.balanceOf(nonManager.address);
            expect(balanceOfNonManager).to.be.eq(1);
        });
    });

    describe("Changing amount", function () {
        it("Manager can change amount of existing receipt", async function () {
            let amount = parseEther("3");
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            amount = parseEther("2");
            await receiptContractBatching.setAmount(0, amount);

            const receipt = await receiptContractStrategyRouter.getReceipt(0); 
            expect(receipt.amount).to.be.eq(amount);
        });

        it("Manager can change amount of receipt created by other manager", async function () {
            let amount = parseEther("3");
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            amount = parseEther("2");
            await receiptContractStrategyRouter.setAmount(0, amount);

            const receipt = await receiptContractStrategyRouter.getReceipt(0); 
            expect(receipt.amount).to.be.eq(amount);
        });

        it("Non manager can't change amount", async function () {
            let amount = parseEther("3");
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            amount = parseEther("1");
            await expect(receiptContractNonManager.setAmount(0, amount))
                .to.be.revertedWith("NotManager()");
        });

        it("Can't change amount non-existing receipt", async function () {
            let amount = parseEther("1");
            await expect(receiptContractBatching.setAmount(0, amount))
                .to.be.revertedWith("NonExistingToken()");
        });
        
        it("Can't change amount non-existing receipt", async function () {
            let amount = parseEther("1");
            await expect(receiptContractBatching.setAmount(0, amount))
                .to.be.revertedWith("NonExistingToken()");
        });
        
        it("We can't increase amount and can only decrease (logic in StrategyRouter.sol and Batching.sol)", async function () {
            let amount = parseEther("1");
            await receiptContractBatching.mint(cycleId, amount, fakeTokenAddress, nonManager.address);
            amount = parseEther("3");
            await expect(receiptContractStrategyRouter.setAmount(0, amount))
                .to.be.revertedWith("ReceiptAmountCanOnlyDecrease()");
        });
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

    async function verifyReceiptData(receiptId, cycleId, amount, token, owner) {
        const receipt = await receiptContractStrategyRouter.getReceipt(receiptId); 
        expect(receipt.cycleId).to.be.eq(cycleId);
        expect(receipt.amount).to.be.eq(amount);
        expect(receipt.token).to.be.eq(token);
        expect(await receiptContractBatching.ownerOf(receiptId)).to.be.eq(owner.address);
    }
});

