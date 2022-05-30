function bnbChain() {

  const bnb = {

    busd: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dai: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",

    // current holders for tests, may not work based on block number used in forking
    busdHolder: "0xf977814e90da44bfa03b6295a0616a897441acec",
    usdcHolder: "0x6782472a11987e6f4a8afb10def25b498cb622db",
    usdtHolder: "0xf977814e90da44bfa03b6295a0616a897441acec"
  };

  // acryptos curve-like pool
  bnb.acryptosUst4Pool = {
    address: "0x99c92765EfC472a9709Ced86310D64C4573c4b77",
    coinIds: [1, 2, 3, 4],
    tokens: [bnb.busd, bnb.usdt, bnb.dai, bnb.usdc]
  };

  bnb.exchangeTypes = {
    pancakeWithWeth: 0,
    pancakeDirect: 1,
    acryptosUst4Pool: 2
  };

  bnb.uniswapRouter = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

  return bnb;
}

const config = { bnb: bnbChain(), bnbTest: bnbChain() };

module.exports = config;
