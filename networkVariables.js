function bnbChain() {

  const bnb = {

    busd: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    dai: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",

    bsw: "0x965f527d9159dce6288a2219db51fc6eef120dd1",

    dodo: "0x67ee3Cb086F8a16f34beE3ca72FAD36F7Db929e2",

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
  bnb.biswapFarm = "0xDbc1A13490deeF9c3C12b44FE77b503c1B061739";
  bnb.biswapRouter = "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8"

  bnb.BusdUsdPriceFeed = "0xcBb98864Ef56E9042e7d2efef76141f15731B82f";
  bnb.UsdcUsdPriceFeed = "0x51597f405303C4377E36123cBc172b13269EA163";
  bnb.UsdtUsdPriceFeed = "0xB97Ad0E74fa7d920791E90258A6E2085088b4320";

  bnb.dodoMine = "0x01f9BfAC04E6184e90bD7eaFD51999CE430Cc750";
  bnb.dodoUsdtLp = "0x56ce908EeBafea026ab047CEe99a3afF039B4a33";
  bnb.dodoBusdUsdtPool = "0xBe60d4c4250438344bEC816Ec2deC99925dEb4c7";

  return bnb;
}


function bnbTestChain() {

  const bnb = {
    // https://testnet.bscscan.com/address/0x3304dd20f6Fe094Cb0134a6c8ae07EcE26c7b6A7
    busd: "0x3304dd20f6Fe094Cb0134a6c8ae07EcE26c7b6A7",
    // https://testnet.bscscan.com/address/0xCA8eB2dec4Fe3a5abbFDc017dE48E461A936623D
    usdc: "0xCA8eB2dec4Fe3a5abbFDc017dE48E461A936623D",
  };

  // https://testnet.bscscan.com/address/0xD99D1c33F9fC3444f8101754aBC46c52416550D1
  bnb.uniswapRouter = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";

  // https://testnet.bscscan.com/address/0x9331b55D9830EF609A2aBCfAc0FBCE050A52fdEa
  bnb.BusdUsdPriceFeed = "0x9331b55D9830EF609A2aBCfAc0FBCE050A52fdEa";
  // https://testnet.bscscan.com/address/0x90c069C4538adAc136E051052E14c1cD799C41B7
  bnb.UsdcUsdPriceFeed = "0x90c069C4538adAc136E051052E14c1cD799C41B7";

  return bnb;
}

const config = { bnb: bnbChain(), bnbTest: bnbTestChain(), localhost: bnbChain(), };

module.exports = config;
