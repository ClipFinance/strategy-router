const strategyTest = require("./shared/strategyTest");

describe("Test strategies", function () {
  let strategies = [
    { name: "DodoUsdt", strategyToken: 'usdt', },
    { name: "BiswapUsdcUsdt", strategyToken: 'usdc', },
    { name: "BiswapBusdUsdt", strategyToken: 'busd', },
    { name: "StargateUsdt", strategyToken: 'usdt', },
    { name: "StargateBusd", strategyToken: 'busd', },
  ];

  for (let i = 0; i < strategies.length; i++) {
    let strategy = strategies[i];
    strategyTest(strategy.name, strategy.strategyToken, strategy.needOracle);
  }
});
