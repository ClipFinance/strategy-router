const { parseEther } = require("ethers/lib/utils");
const { extendEnvironment } = require("hardhat/config");
require("hardhat-tracer");

require("dotenv").config();
require("hardhat-gas-reporter");
require("@nomiclabs/hardhat-etherscan");
require("hardhat-contract-sizer");
require("@openzeppelin/hardhat-upgrades");
require("solidity-docgen");
require("solidity-coverage");

require("@nomicfoundation/hardhat-chai-matchers");
require("@nomiclabs/hardhat-ethers");

const networkVariables = require("./networkVariables");

// Fill networkVariables object with settings and addresses based on current network or fork.
extendEnvironment((hre) => {
  if (hre.network.name == "hardhat") {
    if (hre.network.config.forking.enabled) {
      switch (hre.network.config.forking.url) {
        case process.env.BNB_URL:
          hre.networkVariables = networkVariables["bnb"];
          break;
        case process.env.BNB_TEST_URL:
          hre.networkVariables = networkVariables["bnbTest"];
          break;
      }
    }
  } else {
    hre.networkVariables = networkVariables[hre.network.name];
  }
  if (!hre.networkVariables) throw Error("network variables are missing");
  // console.log(hre.networkVariables);
});

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  networks: {
    hardhat: {
      forking: {
        url: process.env.BNB_URL,
        blockNumber: Number(process.env.FORK_BLOCK_NUMBER) || undefined,
        enabled: true,
      },
      allowUnlimitedContractSize: true,
      // loggingEnabled: false,
      // accounts: [{privateKey: process.env.PRIVATE_KEY, balance: parseEther("10000").toString()}],
    },
    bnb: {
      url: process.env.BNB_URL,
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
      gas: 20e6, // lets see if this solves problem, as auto gas estimation makes deploy scripts to fail
    },
    bnbTest: {
      url: process.env.BNB_TEST_URL ?? "",
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
      gas: 20e6, // lets see if this solves problem, as auto gas estimation makes deploy scripts to fail
    },
    localhost: {
      timeout: 100_000, // 100 seconds
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
  },
  mocha: {
    bail: true,
    timeout: 6000000,
  },
  etherscan: {
    apiKey: {
      bsc: process.env.BSCSCAN_API_KEY,
      bscTestnet: process.env.BSCSCAN_API_KEY,
    },
  },
  docgen: {
    pages: "files",
  },
  solidity: {
    compilers: [
      {
        version: "0.8.19",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1,
            details: {
              peephole: true,
              yulDetails: {
                stackAllocation: true,
                optimizerSteps: "dhfoD[xarrscLMcCTU]uljmul",
              },
            },
          },
        },
      },
      {
        version: "0.8.2",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
          outputSelection: {
            "*": {
              "": ["ast"],
              "*": [
                "evm.bytecode.object",
                "evm.deployedBytecode.object",
                "abi",
                "evm.bytecode.sourceMap",
                "evm.deployedBytecode.sourceMap",
                "metadata",
                "storageLayout",
              ],
            },
          },
        },
      },
      {
        version: "0.6.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
          outputSelection: {
            "*": {
              "": ["ast"],
              "*": [
                "evm.bytecode.object",
                "evm.deployedBytecode.object",
                "abi",
                "evm.bytecode.sourceMap",
                "evm.deployedBytecode.sourceMap",
                "metadata",
                "storageLayout",
              ],
            },
          },
        },
      },
    ],
  },
};
