const hre = require("hardhat");
const { ethers } = require("hardhat");
const { provider } = require("../test/utils");
const { parseEther, formatEther } = require("ethers/lib/utils");
const main = async () => {
  const [signer1] = await ethers.getSigners()
  const contractAddress = "0x0E7c63268FB39e7B65007aBdbCDB36433ba2bb8A";

  const routerContract = await ethers.getContractAt('StrategyRouter', contractAddress, signer1)
  const batchDeposit = await routerContract.getBatchValueUsd();
  console.log(formatEther(batchDeposit.totalBalance));
  const out = await routerContract.allocateToStrategies()

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });