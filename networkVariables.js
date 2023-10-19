function bnbChain() {
  const bnb = {
    wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",

    busd: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    hay: "0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5",
    dai: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",

    bsw: "0x965f527d9159dce6288a2219db51fc6eef120dd1",
    stg: "0xB0D502E938ed5f4df2E681fE6E419ff29631d62b",
    dodo: "0x67ee3Cb086F8a16f34beE3ca72FAD36F7Db929e2",
    the: "0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11",

    // current token holders for tests,
    // may not work based on block number used in forking, in such case try find other holders
    busdHolder: "0xf977814e90da44bfa03b6295a0616a897441acec",
    usdcHolder: "0x8894e0a0c962cb723c1976a4421c95949be2d4e3", // binance delisted usdc some time ago
    usdtHolder: "0x8894e0a0c962cb723c1976a4421c95949be2d4e3",
  };

  // acryptos curve-like pool
  // bnb.acs4usd = {
  //   address: "0xb3F0C9ea1F05e312093Fdb031E789A756659B0AC",
  //   coinIds: [0, 1, 2, 3],
  //   tokens: [bnb.busd, bnb.usdt, bnb.dai, bnb.usdc]
  // };

  bnb.biswapFarm = "0xDbc1A13490deeF9c3C12b44FE77b503c1B061739";
  bnb.biswapRouter = "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8";

  bnb.uniswapRouter = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

  bnb.uniswapV3Router = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
  bnb.uniswapV3Factory = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
  bnb.nonfungiblePositionManager = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";

  bnb.wombatRouter = "0x19609B03C976CCA288fbDae5c21d4290e9a4aDD7";
  bnb.wombatMainPool = "0x312Bc7eAAF93f1C60Dc5AfC115FcCDE161055fb0";
  bnb.wombatHayPool = "0x0520451B19AD0bb00eD35ef391086A692CFC74B2";

  bnb.thenaAlgebraRouter = "0x327Dd3208f0bCF590A66110aCB6e5e6941A4EfA0";
  bnb.thenaAlgebraFactory = "0x306F06C147f064A010530292A1EB6737c3e378e4";

  bnb.BnbUsdPriceFeed = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";
  bnb.BusdUsdPriceFeed = "0xcBb98864Ef56E9042e7d2efef76141f15731B82f";
  bnb.UsdcUsdPriceFeed = "0x51597f405303C4377E36123cBc172b13269EA163";
  bnb.UsdtUsdPriceFeed = "0xB97Ad0E74fa7d920791E90258A6E2085088b4320";
  bnb.HayUsdPriceFeed = "0xc02780d15b021fd2574a331982753fb5de542cc5";
  bnb.BswUsdPriceFeed = "0x08E70777b982a58D23D05E3D7714f44837c06A21";

  bnb.dodoMine = "0x01f9BfAC04E6184e90bD7eaFD51999CE430Cc750";
  bnb.dodoUsdtLp = "0x56ce908EeBafea026ab047CEe99a3afF039B4a33";
  bnb.dodoBusdLp = "0xBEb34A9d23E0fe41d7b08AE3A4cbAD9A63ce0aea";
  bnb.dodoBusdUsdtPool = "0xBe60d4c4250438344bEC816Ec2deC99925dEb4c7";

  bnb.stargateRouter = "0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8";
  bnb.stargateFarm = "0x3052A0F6ab15b4AE1df39962d5DdEFacA86DaB47";
  bnb.stargateUsdtLpPool = "0x9aA83081AA06AF7208Dcc7A4cB72C94d057D2cda";
  bnb.stargateBusdLpPool = "0x98a5737749490856b401DB5Dc27F522fC314A4e1";

  bnb.gammaUniProxy = "0x6B3d98406779DDca311E6C43553773207b506Fa6";
  bnb.hypervisorUsdtUsdc = "0x5EEca990E9B7489665F4B57D27D92c78BC2AfBF2";
  bnb.thenaGaugeUsdtUsdc = "0x1011530830c914970CAa96a52B9DA1C709Ea48fb";
  bnb.hypervisorHayUsdt = "0xDf0B9b59E92A2554dEdB6F6F4AF6918d79DD54c4";
  bnb.thenaGaugeHayUsdt = "0x2Da06b6338f3d503cb2F0ee0e66C8e98A6d8001C";

  return bnb;
}

function bnbTestChain() {
  const bnb = {
    wbnb: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
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

const config = {
  bnb: bnbChain(),
  bnbTest: bnbTestChain(),
  localhost: bnbChain(),
};

module.exports = config;
