const { expect, should, use } = require("chai");
const { ethers } = require("hardhat");

describe("StrategyRouter", function () {

  provider = ethers.provider;

  it("Define globals", async function () {
    [owner, joe, bob] = await ethers.getSigners();
  });

  it("Deploy StrategyRouter", async function () {
    const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
    router = await StrategyRouter.deploy();
    await router.deployed();
  });

  it("Nothing to test yet", async function () {
    expect.fail()
  });

});
