const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const {
  setupFakeTokens,
  setupFakeUnderFulfilledTransferToken,
  setupCore,
} = require("../shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployProxyIdleStrategy } = require("../utils");

describe("Test DefaultIdleStrategy API", function () {
  async function loadState() {
    const [owner, user1] = await ethers.getSigners();

    const { router, batch, create2Deployer, ProxyBytecode } = await setupCore();

    const { usdc } = await setupFakeTokens(
      batch,
      router,
      create2Deployer,
      ProxyBytecode
    );
    const depositToken = usdc;
    // imitate router.batch function
    owner.batch = async function () {
      return owner.address;
    };
    const idleStrategy = await deployProxyIdleStrategy(
      owner,
      batch,
      router,
      owner.address,
      depositToken,
      "Dummy",
      create2Deployer,
      ProxyBytecode,
      false
    );
    await idleStrategy.grantRole(
      await idleStrategy.DEPOSITOR_ROLE(),
      owner.address
    );

    return { owner, user1, router, depositToken, idleStrategy };
  }

  it("access control", async function () {
    const { owner, idleStrategy } = await loadFixture(loadState);

    expect(
      await idleStrategy.hasRole(
        await idleStrategy.DEPOSITOR_ROLE(),
        owner.address
      )
    ).to.be.true;
  });

  it("#transferOwnership", async function () {
    const { user1, idleStrategy } = await loadFixture(loadState);

    await idleStrategy.transferOwnership(user1.address);

    expect(await idleStrategy.owner()).to.be.equal(user1.address);
  });

  describe("upgrade permissions checks are correct", async function () {
    it("throws on non-upgrader", async function () {
      const { user1, idleStrategy, router, depositToken } = await loadFixture(
        loadState
      );

      // Get the implementation contract factory
      const Implementation = await ethers.getContractFactory(
        "DefaultIdleStrategy"
      );

      // Deploy the implementation contract
      const implementation = await Implementation.deploy(
        router.address,
        depositToken.address
      );
      await implementation.deployed();

      await expect(
        idleStrategy.connect(user1).upgradeTo(implementation.address)
      ).to.be.revertedWithCustomError(idleStrategy, "CallerUpgrader");
    });
    it("upgrades when called by upgrader", async function () {
      const { owner, idleStrategy, router, depositToken } = await loadFixture(
        loadState
      );
      const initialImplementationAddress =
        upgrades.erc1967.getImplementationAddress(idleStrategy.address);

      // Get the implementation contract factory
      const Implementation = await ethers.getContractFactory(
        "DefaultIdleStrategy"
      );

      // Deploy the implementation contract
      const implementation = await Implementation.deploy(
        router.address,
        depositToken.address
      );
      await implementation.deployed();

      idleStrategy.upgradeTo(implementation.address);

      expect(
        upgrades.erc1967.getImplementationAddress(idleStrategy.address)
      ).not.to.be.equal(initialImplementationAddress);
    });
  });

  it("#depositToken", async function () {
    const { depositToken, idleStrategy } = await loadFixture(loadState);

    expect(await idleStrategy.depositToken()).to.be.equal(depositToken.address);
  });

  describe("#deposit", async function () {
    it("reverts when called by non owner", async function () {
      const { idleStrategy, user1 } = await loadFixture(loadState);

      await expect(
        idleStrategy.connect(user1).deposit(0)
      ).to.be.revertedWithCustomError(
        idleStrategy,
        "OnlyDepositorsAllowedToDeposit"
      );
    });
    it("zero value", async function () {
      const { idleStrategy } = await loadFixture(loadState);

      expect(await idleStrategy.deposit(0)).not.to.be.reverted;
    });
    it("non-zero value", async function () {
      const { depositToken, idleStrategy } = await loadFixture(loadState);

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      expect(await idleStrategy.deposit(depositToken.parse("100"))).not.to.be
        .reverted;
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(
        depositToken.parse("100")
      );
    });
  });

  describe("#withdraw", async function () {
    it("reverts when called by non owner", async function () {
      const { idleStrategy, user1 } = await loadFixture(loadState);

      await expect(
        idleStrategy.connect(user1).withdraw(0)
      ).to.be.revertedWithCustomError(
        idleStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });
    it("zero value", async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      await idleStrategy.deposit(depositToken.parse("100"));

      expect(await idleStrategy.withdraw(0)).not.to.be.reverted;
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(
        depositToken.parse("100")
      );
    });
    it("non-zero value, fraction of funds", async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      await idleStrategy.deposit(depositToken.parse("100"));

      await idleStrategy.withdraw(depositToken.parse("10"));
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(
        depositToken.parse("90")
      );

      await idleStrategy.withdraw(depositToken.parse("20"));
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(
        depositToken.parse("70")
      );
    });
    it("non-zero value, all funds", async function () {
      const { depositToken, idleStrategy } = await loadFixture(loadState);

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      await idleStrategy.deposit(depositToken.parse("100"));

      await idleStrategy.withdraw(depositToken.parse("100"));
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(
        depositToken.parse("0")
      );
    });
    it("requested more than funds available", async function () {
      const { owner, depositToken, idleStrategy } = await loadFixture(
        loadState
      );

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      await idleStrategy.deposit(depositToken.parse("100"));

      const previousBalance = await depositToken.balanceOf(owner.address);

      await idleStrategy.withdraw(depositToken.parse("200"));

      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(
        depositToken.parse("0")
      );
      expect(
        (await depositToken.balanceOf(owner.address)).sub(previousBalance)
      ).to.be.equal(depositToken.parse("100"));
    });
  });

  describe("#withdrawAll", async function () {
    it("reverts when called by non owner", async function () {
      const { idleStrategy, user1 } = await loadFixture(loadState);

      await expect(
        idleStrategy.connect(user1).withdrawAll()
      ).to.be.revertedWithCustomError(
        idleStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });
    it("no error when no funds", async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      expect(await idleStrategy.withdrawAll()).not.to.be.reverted;
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(0);
    });
    it("successfully withdraw all funds", async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      await idleStrategy.deposit(depositToken.parse("100"));

      await idleStrategy.withdrawAll();
      expect(await depositToken.balanceOf(idleStrategy.address)).to.be.equal(0);
    });
    it("reverts when withdrawn not all coins", async function () {
      const [owner] = await ethers.getSigners();

      const { router, batch, create2Deployer, ProxyBytecode } =
        await setupCore();

      const depositToken = await setupFakeUnderFulfilledTransferToken(
        50_00, // 50%
        18
      );

      // imitate router.batch function
      owner.batch = async function () {
        return owner.address;
      };

      const idleStrategy = await deployProxyIdleStrategy(
        owner,
        batch,
        router,
        owner.address,
        depositToken,
        "Dummy",
        create2Deployer,
        ProxyBytecode,
        false
      );

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );

      await idleStrategy.grantRole(
        await idleStrategy.DEPOSITOR_ROLE(),
        owner.address
      );

      await idleStrategy.deposit(depositToken.parse("100"));

      await expect(idleStrategy.withdrawAll()).to.be.revertedWithCustomError(
        idleStrategy,
        "NotAllAssetsWithdrawn"
      );
    });
  });

  describe("#totalTokens", async function () {
    it("correctly reflects the initial state", async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      expect(await idleStrategy.totalTokens()).to.be.equal(0);
    });
    it("correctly reflects state after chain of deposits and withdraws", async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("100")
      );
      await idleStrategy.deposit(depositToken.parse("100"));
      expect(await idleStrategy.totalTokens()).to.be.equal(
        depositToken.parse("100")
      );

      await idleStrategy.withdraw(depositToken.parse("10"));
      expect(await idleStrategy.totalTokens()).to.be.equal(
        depositToken.parse("90")
      );

      await idleStrategy.withdrawAll();
      expect(await idleStrategy.totalTokens()).to.be.equal(
        depositToken.parse("0")
      );

      await depositToken.transfer(
        idleStrategy.address,
        depositToken.parse("10")
      );
      await idleStrategy.deposit(depositToken.parse("10"));
      expect(await idleStrategy.totalTokens()).to.be.equal(
        depositToken.parse("10")
      );
    });
  });
});
