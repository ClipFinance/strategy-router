function bnbChain() {

  const bnb = {

    busd: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dai: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",

    bsw: "0x965f527d9159dce6288a2219db51fc6eef120dd1",

    // current token holders for tests, 
    // may not work based on block number used in forking, in such case try find other holders
    busdHolder: "0xf977814e90da44bfa03b6295a0616a897441acec",
    usdcHolder: "0xf977814e90da44bfa03b6295a0616a897441acec",
    usdtHolder: "0xf977814e90da44bfa03b6295a0616a897441acec"
  };

  // acryptos curve-like pool
  bnb.acs4usd = {
    address: "0xb3F0C9ea1F05e312093Fdb031E789A756659B0AC",
    coinIds: [0, 1, 2, 3],
    tokens: [bnb.busd, bnb.usdt, bnb.dai, bnb.usdc]
  };

  bnb.uniswapRouter = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

  return bnb;
}

const config = { bnb: bnbChain(), bnbTest: bnbChain(), localhost: bnbChain(), };

module.exports = config;
