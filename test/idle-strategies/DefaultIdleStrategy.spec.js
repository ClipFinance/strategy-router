const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { setupFakeToken } = require("../shared/commonSetup");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployProxyIdleStrategy } = require("../utils");

describe("Test DefaultIdleStrategy API", function () {
  async function loadState() {
    const [owner, user1] = await ethers.getSigners();

    const depositToken = await setupFakeToken(18);

    const idleStrategy = await deployProxyIdleStrategy(owner, owner, depositToken);

    return { owner, user1, depositToken, idleStrategy };
  }

  it('#transferOwnership', async function () {
    const { user1, idleStrategy } = await loadFixture(loadState);

    await idleStrategy.transferOwnership(user1.address);

    expect(await idleStrategy.owner()).to.be.equal(user1.address);
  });

  describe('upgrade permissions checks are correct', async function () {
    it('throws on non-upgrader', async function () {
      const { user1, idleStrategy } = await loadFixture(loadState);

      const newIdleStrategyFactory = await ethers.getContractFactory(
        "DefaultIdleStrategy",
        {
          signer: user1,
        }
      );
      await expect(
        upgrades.upgradeProxy(
          idleStrategy,
          newIdleStrategyFactory,
          {
            kind: 'uups',
            constructorArgs: [user1.address, user1.address],
            unsafeAllow: ['delegatecall'],
          }
        )
      ).to.be.revertedWithCustomError(idleStrategy, 'CallerUpgrader');
    });
    it('upgrades when called by upgrader', async function () {
      const { owner, idleStrategy } = await loadFixture(loadState);

      const initialImplementationAddress = upgrades
        .erc1967
        .getImplementationAddress(idleStrategy.address);

      const newIdleStrategyFactory = await ethers.getContractFactory(
        "DefaultIdleStrategy",
        {
          signer: owner,
        }
      );
      const upgradedIdleStrategy = await upgrades.upgradeProxy(
        idleStrategy,
        newIdleStrategyFactory,
        {
          kind: 'uups',
          constructorArgs: [owner.address, owner.address],
          unsafeAllow: ['delegatecall'],
        }
      );

      expect(upgradedIdleStrategy.address).to.be.equal(idleStrategy.address);
      expect(
        upgrades.erc1967.getImplementationAddress(idleStrategy.address)
      ).not.to.be.equal(
        initialImplementationAddress
      );
    });
  });

  it('#depositToken', async function () {
    const { depositToken, idleStrategy } = await loadFixture(loadState);

    expect(await idleStrategy.depositToken()).to.be.equal(depositToken.address);
  });

  describe('#deposit', async function () {
    it('reverts when called by non owner', async function () {
      const { idleStrategy, user1 } = await loadFixture(loadState);

      await expect(idleStrategy.connect(user1).deposit(0))
        .to
        .be
        .revertedWithCustomError(idleStrategy, 'Ownable__CallerIsNotTheOwner');
    });
    it('zero value', async function () {
      const { idleStrategy } = await loadFixture(loadState);

      expect(await idleStrategy.deposit(0)).not.to.be.reverted;
    });
    it('non-zero value', async function () {
      const { depositToken, idleStrategy } = await loadFixture(loadState);

      await depositToken.transfer(idleStrategy.address, depositToken.parse('100'));
      expect(
        await idleStrategy.deposit(depositToken.parse('100'))
      ).not.to.be.reverted;
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(depositToken.parse('100'));
    });
  });

  describe('#withdraw', async function () {
    it('reverts when called by non owner', async function () {
      const { idleStrategy, user1 } = await loadFixture(loadState);

      await expect(idleStrategy.connect(user1).withdraw(0))
        .to
        .be
        .revertedWithCustomError(idleStrategy, 'Ownable__CallerIsNotTheOwner');
    });
    it('zero value', async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(idleStrategy.address, depositToken.parse('100'));
      await idleStrategy.deposit(depositToken.parse('100'));

      expect(await idleStrategy.withdraw(0)).not.to.be.reverted;
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(depositToken.parse('100'));
    });
    it('non-zero value, fraction of funds', async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(idleStrategy.address, depositToken.parse('100'));
      await idleStrategy.deposit(depositToken.parse('100'));

      await idleStrategy.withdraw(depositToken.parse('10'));
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(depositToken.parse('90'));

      await idleStrategy.withdraw(depositToken.parse('20'));
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(depositToken.parse('70'));
    });
    it('non-zero value, all funds', async function () {
      const { depositToken, idleStrategy } = await loadFixture(loadState);

      await depositToken.transfer(idleStrategy.address, depositToken.parse('100'));
      await idleStrategy.deposit(depositToken.parse('100'));

      await idleStrategy.withdraw(depositToken.parse('100'));
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(depositToken.parse('0'));
    });
  });

  describe('#withdrawAll', async function () {
    it('reverts when called by non owner', async function () {
      const { idleStrategy, user1 } = await loadFixture(loadState);

      await expect(idleStrategy.connect(user1).withdrawAll())
        .to
        .be
        .revertedWithCustomError(idleStrategy, 'Ownable__CallerIsNotTheOwner');
    });
    it('no error when no funds', async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      expect(await idleStrategy.withdrawAll()).not.to.be.reverted;
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(0);
    });
    it('successfully withdraw all funds', async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(idleStrategy.address, depositToken.parse('100'));
      await idleStrategy.deposit(depositToken.parse('100'));

      await idleStrategy.withdrawAll();
      expect(
        await depositToken.balanceOf(idleStrategy.address)
      ).to.be.equal(0);
    });
  });

  describe('#totalTokens', async function () {
    it('correctly reflects the initial state', async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      expect(
        await idleStrategy.totalTokens()
      ).to.be.equal(0);
    });
    it('correctly reflects state after chain of deposits and withdraws', async function () {
      const { idleStrategy, depositToken } = await loadFixture(loadState);

      await depositToken.transfer(idleStrategy.address, depositToken.parse('100'));
      await idleStrategy.deposit(depositToken.parse('100'));
      expect(
        await idleStrategy.totalTokens()
      ).to.be.equal(depositToken.parse('100'));

      await idleStrategy.withdraw(depositToken.parse('10'));
      expect(
        await idleStrategy.totalTokens()
      ).to.be.equal(depositToken.parse('90'));

      await idleStrategy.withdrawAll();
      expect(
        await idleStrategy.totalTokens()
      ).to.be.equal(depositToken.parse('0'));

      await depositToken.transfer(idleStrategy.address, depositToken.parse('10'));
      await idleStrategy.deposit(depositToken.parse('10'));
      expect(
        await idleStrategy.totalTokens()
      ).to.be.equal(depositToken.parse('10'));
    });
  });
});