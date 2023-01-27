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
    usdcHolder: "0x8894e0a0c962cb723c1976a4421c95949be2d4e3", // binance delisted usdc some time ago
    usdtHolder: "0x8894e0a0c962cb723c1976a4421c95949be2d4e3"
  };

  // acryptos curve-like pool
  bnb.acs4usd = {
    address: "0xb3F0C9ea1F05e312093Fdb031E789A756659B0AC",
    coinIds: [0, 1, 2, 3],
    tokens: [bnb.busd, bnb.usdt, bnb.dai, bnb.usdc]
  };

  bnb.uniswapRouter = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

  bnb.BusdUsdPriceFeed = "0xcBb98864Ef56E9042e7d2efef76141f15731B82f";
  bnb.UsdcUsdPriceFeed = "0x51597f405303C4377E36123cBc172b13269EA163";

  return bnb;
}

function bnbTestChain() {

  const bnb = {
    busd: "0x3304dd20f6Fe094Cb0134a6c8ae07EcE26c7b6A7",
    usdc: "0xCA8eB2dec4Fe3a5abbFDc017dE48E461A936623D",
    wbnb: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",

    cake: "0xFa60D973F7642B748046464e165A65B7323b0DEE",
  };

  bnb.uniswapRouter = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";

  bnb.BusdUsdPriceFeed = "0x9331b55D9830EF609A2aBCfAc0FBCE050A52fdEa";
  bnb.UsdcUsdPriceFeed = "0x90c069C4538adAc136E051052E14c1cD799C41B7";
  bnb.BnbUsdPriceFeed = "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526";
  bnb.CakeUsdPriceFeed = "0x81faeDDfeBc2F8Ac524327d70Cf913001732224C";

  return bnb;
}

const config = { bnb: bnbChain(), bnbTest: bnbTestChain(), localhost: bnbChain(), };

module.exports = config;
