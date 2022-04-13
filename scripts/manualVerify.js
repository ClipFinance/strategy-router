const hre = require("hardhat");
const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");
const { getTokens, skipCycleTime, printStruct, logFarmLPs, BLOCKS_MONTH, skipBlocks, BLOCKS_DAY } = require("../test/utils");

// deploy script for testing on mainnet
// to test on hardhat network:
//   remove block pinning from config and uncomment 'accounts'
//   in .env set account with bnb and at least 0.1 ust

async function main() {

  // ~~~~~~~~~~~ GET UST ADDRESS ON MAINNET ~~~~~~~~~~~ 
  UST = "0x23396cf899ca06c4472205fc903bdb4de249d6fc";
  ust = await ethers.getContractAt("ERC20", UST);

  exchange = "0x68535F755BcEC41C863877f151029A5B29f1C3Ee"
  router = "0x4d8474c69346f5C05e1fca78729b5052721Afd12"
  receiptContract = "0x85cF1D70e23A2fAe979EBf49D13Ee8Cb3b707ACC"
  sharesToken = "0x6a75747d146F2c68C5d0fDAC9a373052ca1e5691"
  strategyAcryptos = "0xc49DAFeb1ED29b627C45A8A21a390f3DA21aF45D"
  strategyBiswap = "0x3b0440b2bB831Bea21407d520C2F2E91483498c8"

  let deployedContracts = [
    exchange,
    router,
    receiptContract,
    sharesToken,
  ];

  await hre.run("verify:verify", {
    address: strategyAcryptos,
    constructorArguments: [router],
  });

  await hre.run("verify:verify", {
    address: strategyBiswap,
    constructorArguments: [router],
  });

  for (let i = 0; i < deployedContracts.length; i++) {
    try {
      const contract = deployedContracts[i];
      if(typeof contract === "string") {
        await hre.run("verify:verify", {
          address: contract,
          constructorArguments: [],
        });
      } else {
        await hre.run("verify:verify", {
          address: contract.address,
          constructorArguments: contract.constructorArgs,
        });
      }
    } catch (error) {
      console.log(error)
    }
  }

}

function setupVerificationHelper() {
  let oldDeploy = hre.ethers.ContractFactory.prototype.deploy;
  hre.ethers.ContractFactory.prototype.deploy = async function (...args) {
    let contract = await oldDeploy.call(this, ...args);
    contract.constructorArgs = args;
    return contract;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
