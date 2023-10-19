const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  parseUniform,
  getCreate2DeployerAndProxyBytecode,
} = require("../utils");

describe("Test Hardcap API", function () {
  function loadState({
    totalTokens = 0,
    hardcapInTokens = 0,
    hardcapDeviationInBps = 0,
  }) {
    return async function loadStateImpl() {
      const [owner, nonOwner] = await ethers.getSigners();

      // Deploy the new Implementation contract which is TestableBaseStrategyWithHardcap
      const Implementation = await ethers.getContractFactory(
        "TestableBaseStrategyWithHardcap"
      );
      const implementation = await Implementation.deploy(
        totalTokens,
        hardcapInTokens,
        hardcapDeviationInBps,
        [owner.address]
      );
      await implementation.deployed();

      return {
        hardcapStrategy: implementation,
        owner,
        nonOwner,
      };
    };
  }

  it("#initialize with create2Deployer", async function () {
    const { hardcapStrategy, owner } = await loadFixture(
      loadState({
        totalTokens: 0,
        hardcapInTokens: 0,
        hardcapDeviationInBps: 0,
      })
    );

    const { create2Deployer, ProxyBytecode } =
      await getCreate2DeployerAndProxyBytecode();

    // Salt
    const salt = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("TestableBaseStrategyWithHardcapSalt")
    );

    // Call the deploy function using the imported ProxyBytecode
    const initializeData = ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint16", "address[]"],
      [parseUniform(1_000_000), 500, [owner.address]]
    );
    await create2Deployer.deployProxy(
      0,
      salt,
      ProxyBytecode,
      hardcapStrategy.address,
      initializeData
    );

    // Compute the expected address
    const codeHash = ethers.utils.keccak256(ProxyBytecode);
    const expectedHardcapStrategyProxyAddress =
      await create2Deployer.computeAddress(salt, codeHash);

    const hardcapStrategyProxy = await ethers.getContractAt(
      "TestableBaseStrategyWithHardcap",
      expectedHardcapStrategyProxyAddress
    );

    expect(await hardcapStrategyProxy.owner()).to.be.equal(owner.address);

    expect(
      await hardcapStrategyProxy.hasRole(
        await hardcapStrategyProxy.DEPOSITOR_ROLE(),
        owner.address
      )
    ).to.be.true;
    expect(await hardcapStrategyProxy.owner()).to.be.equal(owner.address);
    expect(await hardcapStrategyProxy.hardcapTargetInToken()).to.be.equal(
      parseUniform(1_000_000)
    );
    expect(await hardcapStrategyProxy.hardcapDeviationInBps()).to.be.equal(500);
  });

  describe("#deposit", async function () {
    it("throws on non owner", async function () {
      const { hardcapStrategy, owner, nonOwner } = await loadFixture(
        loadState({
          totalTokens: 0,
          hardcapInTokens: 0,
          hardcapDeviationInBps: 0,
        })
      );

      await expect(
        hardcapStrategy.connect(nonOwner).deposit(0)
      ).to.be.revertedWithCustomError(
        hardcapStrategy,
        "OnlyDepositorsAllowedToDeposit"
      );
    });
    it("throws when hardcap reached", async function () {
      const { hardcapStrategy } = await loadFixture(
        loadState({
          totalTokens: parseUniform(1_100_000),
          hardcapInTokens: parseUniform(1_000_000),
          hardcapDeviationInBps: 0,
        })
      );

      await expect(
        hardcapStrategy.deposit(parseUniform(10_000))
      ).to.be.revertedWithCustomError(hardcapStrategy, "HardcapLimitExceeded");
    });
    it("throws when deposit amount greater than underflow", async function () {
      // capacity 100_000
      const { hardcapStrategy } = await loadFixture(
        loadState({
          totalTokens: parseUniform(900_000),
          hardcapInTokens: parseUniform(1_000_000),
          hardcapDeviationInBps: 0,
        })
      );

      await expect(
        hardcapStrategy.deposit(parseUniform(110_000))
      ).to.be.revertedWithCustomError(hardcapStrategy, "HardcapLimitExceeded");
    });
    it("passes when deposit amount is lower than underflow", async function () {
      // capacity 100_000
      const { hardcapStrategy } = await loadFixture(
        loadState({
          totalTokens: parseUniform(500_000),
          hardcapInTokens: parseUniform(1_000_000),
          hardcapDeviationInBps: 0,
        })
      );

      await hardcapStrategy.deposit(parseUniform(110_000));
    });
  });

  it("#getHardcardTargetInToken", async function () {
    const { hardcapStrategy } = await loadFixture(
      loadState({
        totalTokens: parseUniform(500_000),
        hardcapInTokens: parseUniform(1_000_000),
        hardcapDeviationInBps: 500,
      })
    );

    expect(await hardcapStrategy.getHardcardTargetInToken()).to.be.equal(
      parseUniform(1_000_000)
    );
  });

  it("#getHardcardDeviationInBps", async function () {
    const { hardcapStrategy } = await loadFixture(
      loadState({
        totalTokens: parseUniform(500_000),
        hardcapInTokens: parseUniform(1_000_000),
        hardcapDeviationInBps: 500,
      })
    );

    expect(await hardcapStrategy.getHardcardDeviationInBps()).to.be.equal(500);
  });

  describe("#getCapacityData", async function () {
    describe("correctly calculates underflow", async function () {
      it("0% deviation", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(900_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 0, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(false);
        expect(capacityData.underflow).to.be.equal(parseUniform(100_000));
        expect(capacityData.overflow).to.be.equal(0);
      });
      it("5% deviation", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(900_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 500, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(false);
        expect(capacityData.underflow).to.be.equal(parseUniform(100_000));
        expect(capacityData.overflow).to.be.equal(0);
      });
      it("0 total tokens, 5% deviation", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: 0,
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 500, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(false);
        expect(capacityData.underflow).to.be.equal(parseUniform(1_000_000));
        expect(capacityData.overflow).to.be.equal(0);
      });
    });
    describe("correctly calculates overflow", async function () {
      it("0% deviation", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(1_100_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 0, // 0%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(true);
        expect(capacityData.underflow).to.be.equal(0);
        expect(capacityData.overflow).to.be.equal(parseUniform(100_000));
      });
      it("5% deviation", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(1_100_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 500, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(true);
        expect(capacityData.underflow).to.be.equal(0);
        expect(capacityData.overflow).to.be.equal(parseUniform(100_000));
      });
    });
    describe("correctly calculates total tokens in hardcap range", async function () {
      it("0% deviation", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(1_000_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 0, // 0%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(true);
        expect(capacityData.underflow).to.be.equal(0);
        expect(capacityData.overflow).to.be.equal(0);
      });
      it("5% deviation, lower edge of the range", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(950_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 500, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(true);
        expect(capacityData.underflow).to.be.equal(0);
        expect(capacityData.overflow).to.be.equal(0);
      });
      it("5% deviation, upper edge of the range", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(1_050_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 500, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(true);
        expect(capacityData.underflow).to.be.equal(0);
        expect(capacityData.overflow).to.be.equal(0);
      });
      it("5% deviation, the middle of the range", async function () {
        const { hardcapStrategy } = await loadFixture(
          loadState({
            totalTokens: parseUniform(1_000_000),
            hardcapInTokens: parseUniform(1_000_000),
            hardcapDeviationInBps: 500, // 5%
          })
        );

        const capacityData = await hardcapStrategy.getCapacityData();
        expect(capacityData.limitReached).to.be.equal(true);
        expect(capacityData.underflow).to.be.equal(0);
        expect(capacityData.overflow).to.be.equal(0);
      });
    });
  });
});
