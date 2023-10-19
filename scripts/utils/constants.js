const STRATEGY_ROUTER = {
  proxyAddress: "0xc903f9Ad53675cD5f6440B32915abfa955B8CbF4",
  contractName: "StrategyRouter",
  constructorArgs: [],
  initializerArgs: [],
};
const ORACLE = {
  proxyAddress: "0x8482807e1cae22e6EF248c0B2B6A02B8d581f537",
  contractName: "ChainlinkOracle",
  constructorArgs: [],
  initializerArgs: [],
};
const BATCH = {
  proxyAddress: "0xCEE26C4C6f155408cb1c966AaFcd8966Ec60E80b",
  contractName: "Batch",
  constructorArgs: [],
  initializerArgs: [],
};
const RECEIPT_CONTRACT = {
  proxyAddress: "0xa9AA2EdF9e11E72e1100eBBb4A7FE647C12B55Ab",
  contractName: "ReceiptNFT",
  constructorArgs: [],
  initializerArgs: [
    STRATEGY_ROUTER.proxyAddress,
    BATCH.proxyAddress,
    "https://www.clip.finance/",
    false,
  ],
  initializer: "initialize(address, address, string, bool)",
};
const SHARES_TOKEN = {
  proxyAddress: "0xf42b35d37eC8bfC26173CD66765dd5B84CCB03E3",
  contractName: "SharesToken",
  constructorArgs: [],
  initializerArgs: [STRATEGY_ROUTER.proxyAddress],
  initializer: "initialize(address)",
};
const EXCHANGE = {
  proxyAddress: "0xAA8f27ED1A3239EE99494379260a4de51047C445",
  contractName: "Exchange",
  constructorArgs: [],
  initializerArgs: [],
};
const DODO_USDT = {
  proxyAddress: "0x9e04B02321b8688157c981bE8B0d61c87AC8eBEB",
  contractName: "DodoUsdt",
  constructorArgs: [STRATEGY_ROUTER.proxyAddress],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    1_000_000_000_000_000_000_000_000n.toString(),
    500,
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};
const STARGATE_USD = {
  proxyAddress: "0xBceD7D47930d3F36Ba76AAaA4404C1eD7B9c5AbA",
  contractName: "StargateUsdt",
  constructorArgs: [STRATEGY_ROUTER.proxyAddress],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    1_000_000_000_000_000_000_000_000n.toString(),
    500,
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};
const DODO_BUSD = {
  proxyAddress: "0x3CCE51Dfb070f5123C9B19f40627D7255E95e29a",
  contractName: "DodoBusd",
  constructorArgs: [STRATEGY_ROUTER.proxyAddress],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    1_000_000_000_000_000_000_000_000n.toString(),
    500,
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};
const THENA_HAY = {
  proxyAddress: "0x9673c313c963B5175FF69D88830B3C1B1d6ccF27",
  contractName: "ThenaHay",
  constructorArgs: [STRATEGY_ROUTER.proxyAddress, ORACLE.proxyAddress, 300],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    1_000_000_000_000_000_000_000_000n.toString(),
    500,
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
  initializer: "initialize(address, uint256, uint16, address[])",
};
const BISWAP_HAY_USDT = {
  proxyAddress: "0x85cf9550C9F8370fB1132C28DFfDEcC517D31397",
  contractName: "BiswapHayUsdt",
  constructorArgs: [STRATEGY_ROUTER.proxyAddress, ORACLE.proxyAddress, 300],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    1_000_000_000_000_000_000_000_000n.toString(),
    500,
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};

const BUSD_IDLE = {
  proxyAddress: "0x1D1622FD086377c0E576e6b1a652336edc83Ed32",
  contractName: "DefaultIdleStrategy",
  constructorArgs: [
    STRATEGY_ROUTER.proxyAddress,
    "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
  ],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};
const USDC_IDLE = {
  proxyAddress: "0x1263c15790D0Eb4730d51dF109da1e23890102D0",
  contractName: "DefaultIdleStrategy",
  constructorArgs: [
    STRATEGY_ROUTER.proxyAddress,
    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  ],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};
const USDT_IDLE = {
  proxyAddress: "0xD3131374aEaE9091d7Ee3046C87B33A0988c1FD4",
  contractName: "DefaultIdleStrategy",
  constructorArgs: [
    STRATEGY_ROUTER.proxyAddress,
    "0x55d398326f99059fF775485246999027B3197955",
  ],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};
const HAY_IDLE = {
  proxyAddress: "0xaD00b5e83E7f5103A8644fDb5fEd6C8427AD352b",
  contractName: "DefaultIdleStrategy",
  constructorArgs: [
    STRATEGY_ROUTER.proxyAddress,
    "0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5",
  ],
  initializerArgs: [
    "0xcAD3e8A8A2D3959a90674AdA99feADE204826202", // upgrader
    [STRATEGY_ROUTER.proxyAddress, BATCH.proxyAddress],
  ],
};

const contractsData = {
  BATCH,
  RECEIPT_CONTRACT,
  SHARES_TOKEN,
  STRATEGY_ROUTER,
  EXCHANGE,
  ORACLE,
  DODO_USDT,
  STARGATE_USD,
  DODO_BUSD,
  THENA_HAY,
  BISWAP_HAY_USDT,
  BUSD_IDLE,
  USDC_IDLE,
  USDT_IDLE,
  HAY_IDLE,
};

module.exports = {
  contractsData,
};
