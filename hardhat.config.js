const { parseEther } = require("ethers/lib/utils");

require("dotenv").config();
require("@nomiclabs/hardhat-waffle");
require("hardhat-gas-reporter");
require("@nomiclabs/hardhat-etherscan");
require('hardhat-contract-sizer');
require('solidity-docgen');

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  networks: {
    hardhat: {
      forking: {
        url: process.env.BNB_URL,
        blockNumber: 18089846, // use this only with archival node
        enabled: true
      },
      allowUnlimitedContractSize: true,
      // loggingEnabled: false
      // accounts: [{privateKey: process.env.PRIVATE_KEY, balance: parseEther("10000").toString()}],
    },
    bnb: {
      url: process.env.BNB_URL,
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
      gas: 20e6 // lets see if this solves problem, as auto gas estimation makes deploy scripts to fail
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
  },
  mocha: {
    bail: true,
    timeout: 6000000
  },
  etherscan: {
    apiKey: {
      bsc: process.env.BSCSCAN_API_KEY
    }
  },
  docgen: {
    pages: "files"
  },
  solidity: {
    compilers: [
      {
        version: "0.8.4",
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
              ],
            },
          },
        },
      },
    ]
  },
};
