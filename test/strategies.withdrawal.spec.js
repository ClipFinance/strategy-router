const strategyTest = require("./shared/strategyTest");

describe("Test strategies", function () {
  let strategies = [
    // TODO: fix dodo tests in another PR
    // { name: "DodoBusd", strategyToken: "busd", hasOracle: false },
    // { name: "DodoUsdt", strategyToken: "usdt", hasOracle: false },
    { name: "BiswapUsdcUsdt", strategyToken: "usdc", hasOracle: true },
    { name: "BiswapBusdUsdt", strategyToken: "busd", hasOracle: true },
    { name: "BiswapHayUsdt", strategyToken: "hay", hasOracle: true },
    { name: "StargateUsdt", strategyToken: "usdt", hasOracle: false },
    { name: "StargateBusd", strategyToken: "busd", hasOracle: false },
    { name: "ThenaUsdt", strategyToken: "usdt", hasOracle: true },
    { name: "ThenaUsdc", strategyToken: "usdc", hasOracle: true },
    // { name: "ThenaHay", strategyToken: 'hay', hasOracle: true, }, // Improper ratio error
    // { name: "ThenaUsdtHay", strategyToken: 'usdt', hasOracle: true, },
  ];

  for (let i = 0; i < strategies.length; i++) {
    let strategy = strategies[i];
    strategyTest(strategy.name, strategy.strategyToken, strategy.hasOracle);
  }
});
