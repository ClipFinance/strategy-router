const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, parseUniform } = require("../utils");

describe("Test Hardcap API", function () {
  async function loadState() {
    const [ owner, nonOwner ] = await ethers.getSigners();

    const hardcapStrategy = await deploy(
      'TestableBaseStrategyWithHardcap',
      0,
      0,
      0
    );

    return { hardcapStrategy, owner, nonOwner };
  }

  it('#initialize', async function() {
    const { hardcapStrategy, owner, nonReceiptOwner } = await loadFixture(loadState);

    expect(await hardcapStrategy.owner()).to.be.equal(
      owner.address
    );

    await hardcapStrategy.initialize(parseUniform((1_000_000).toString()), 500);

    expect(await hardcapStrategy.owner()).to.be.equal(
      owner.address
    );
    expect(await hardcapStrategy.owner()).to.be.equal(
      owner.address
    );
    expect(await hardcapStrategy.hardcapTargetInToken()).to.be.equal(
      parseUniform((1_000_000).toString())
    );
    expect(await hardcapStrategy.hardcapDeviationInBps()).to.be.equal(
      500
    );
  });

  describe('#deposit', async function() {
    it('throws on non owner', async function () {
      const { hardcapStrategy, owner, nonOwner } = await loadFixture(loadState);

      await expect(hardcapStrategy.deposit(0))
        .to
        .be
        .revertedWithCustomError(hardcapStrategy, 'Ownable__CallerIsNotTheOwner');
    });
    it('throws when hardcap reached', async function () {
      const { owner, nonOwner } = await loadFixture(loadState);
      const hardcapStrategy = await deploy(
        'TestableBaseStrategyWithHardcap',
        parseUniform((1_100_000).toString()),
        parseUniform((1_000_000).toString()),
        0
      );

      await expect(
        hardcapStrategy.deposit(parseUniform((10_000).toString()))
      )
        .to
        .be
        .revertedWithCustomError(hardcapStrategy, 'HardcapLimitExceeded');
    });
    it('throws when deposit amount greater than underflow', async function () {
      const { owner, nonOwner } = await loadFixture(loadState);
      // capacity 100_000
      const hardcapStrategy = await deploy(
        'TestableBaseStrategyWithHardcap',
        parseUniform((900_000).toString()),
        parseUniform((1_000_000).toString()),
        0
      );

      await expect(
        hardcapStrategy.deposit(parseUniform((110_000).toString()))
      )
        .to
        .be
        .revertedWithCustomError(hardcapStrategy, 'HardcapLimitExceeded');
    });
    it('passes when deposit amount is lower than underflow', async function () {
      const { owner, nonOwner } = await loadFixture(loadState);
      // capacity 100_000
      const hardcapStrategy = await deploy(
        'TestableBaseStrategyWithHardcap',
        parseUniform((500_000).toString()),
        parseUniform((1_000_000).toString()),
        0
      );

      await hardcapStrategy.deposit(parseUniform((110_000).toString()));
    });
  });

  it('#getHardcardTargetInToken', async function () {
    // capacity 100_000
    const hardcapStrategy = await deploy(
      'TestableBaseStrategyWithHardcap',
      parseUniform((500_000).toString()),
      parseUniform((1_000_000).toString()),
      500
    );

    expect(
      await hardcapStrategy.getHardcardTargetInToken()
    ).to.be.equal(
      parseUniform((1_000_000).toString())
    );
  });

  it('#getHardcardDeviationInBps', async function () {
    // capacity 100_000
    const hardcapStrategy = await deploy(
      'TestableBaseStrategyWithHardcap',
      parseUniform((500_000).toString()),
      parseUniform((1_000_000).toString()),
      500
    );

    expect(
      await hardcapStrategy.getHardcardDeviationInBps()
    ).to.be.equal(
      500
    );
  });

  describe('#getCapacityData', async function () {
    it('correctly calculates underflow', async function () {
      // capacity 100_000
      const hardcapStrategy = await deploy(
        'TestableBaseStrategyWithHardcap',
        parseUniform((500_000).toString()),
        parseUniform((1_000_000).toString()),
        500
      );

      expect(
        await hardcapStrategy.getHardcardDeviationInBps()
      ).to.be.equal(
        500
      );
    });
  });
});