const { expect } = require("chai");
const { ethers } = require("hardhat");
const { provider, deployProxy, deploy } = require("./utils");
const { smock } = require('@defi-wonderland/smock');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { setupFakeToken } = require("./shared/commonSetup");

describe("Test ChainlinkOracle", function () {
  async function initialState() {
    const [ , fakeToken2, ] = await ethers.getSigners();
    const fakeOracle = await deploy('FakeOracle');
    const fakeToken1 = await setupFakeToken();

    return {
      fakeOracle,
      fakeToken1Address: fakeToken1.address,
      fakeToken2Address: fakeToken2.address,
    };
  }

  describe("#isTokenSupported", function() {
    it('returns false when token is not supported', async function () {
      const { fakeOracle, fakeToken1Address, fakeToken2Address }
        = await loadFixture(initialState);

      expect(
        await fakeOracle.isTokenSupported(fakeToken2Address)
      ).to.be.false;

      await fakeOracle.setPrice(fakeToken1Address, 1);

      expect(
        await fakeOracle.isTokenSupported(fakeToken2Address)
      ).to.be.false;
    });
    it('returns true when token is supported', async function () {
      const { fakeOracle, fakeToken1Address, }
        = await loadFixture(initialState);

      await fakeOracle.setPrice(fakeToken1Address, 1);

      expect(
        await fakeOracle.isTokenSupported(fakeToken1Address)
      ).to.be.true;
    });
  });
});