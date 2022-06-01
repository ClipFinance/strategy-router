const { expect } = require("chai");
const { ethers } = require("hardhat");
const { provider } = require("./utils");


describe("Test ReceiptNFT", function () {

    let owner, user1;
    let receiptContract;
    let snapshotId;
    // helper function to convert BigNumbers in array to Numbers
    let arrayToNubmer = arr => arr.map(n => n.toNumber());

    beforeEach(async function () {
        snapshotId = await provider.send("evm_snapshot");
        [owner, user1] = await ethers.getSigners();

        receiptContract = await ethers.getContractFactory("ReceiptNFT");
        receiptContract = await receiptContract.deploy();
    });

    afterEach(async function () {
        await provider.send("evm_revert", [snapshotId]);
    });

    it("Function with onlyManager modifier is only callable by managers", async function () {
        // set owner as manager
        await receiptContract.init(owner.address, owner.address);

        let receiptContractUser = receiptContract.connect(user1);
        // non-manager fails to mint
        await expect(receiptContractUser.mint(0, 0, owner.address, owner.address))
            .to.be.revertedWith("NotManager()");

        // manager mint token id 0
        await receiptContract.mint(0, 0, owner.address, owner.address);

        // non-manager fails to burn or setAmount
        await expect(receiptContractUser.burn(0)).to.be.revertedWith("NotManager()");
        await expect(receiptContractUser.setAmount(0, 0)).to.be.revertedWith("NotManager()");

    });

    describe("Test walletOfOwner function", function () {

        beforeEach(async function () {
            await receiptContract.init(owner.address, owner.address);
        });

        //  await receiptContract.init(owner.address, owner.address);
        it("Wallet with 0 tokens", async function () {
            expect(await receiptContract.walletOfOwner(owner.address)).to.be.empty;
        });

        it("Wallet with 1 token", async function () {
            await mintReceipt(owner.address);
            expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
            expect(await receiptContract.walletOfOwner(user1.address)).to.be.empty;
        });

        it("Two wallets with 1 token", async function () {
            await mintReceipt(owner.address);
            await mintReceipt(user1.address);
            expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([0]);
            expect(arrayToNubmer(await receiptContract.walletOfOwner(user1.address))).to.be.eql([1]);
        });

        it("Two walets with more tokens", async function () {
            await mintReceipt(owner.address);
            await mintReceipt(user1.address);
            await mintReceipt(owner.address);
            await mintReceipt(user1.address);
            await mintReceipt(owner.address);
            await mintReceipt(user1.address);
            expect(arrayToNubmer(await receiptContract.walletOfOwner(owner.address))).to.be.eql([4, 2, 0]);
            expect(arrayToNubmer(await receiptContract.walletOfOwner(user1.address))).to.be.eql([5, 3, 1]);
        });
    });

    async function mintReceipt(to) {
        await receiptContract.mint(0, 0, ethers.constants.AddressZero, to);
    }
});

