const strategyTest = require("./shared/strategyTest");

describe("Test strategies", function () {
  let strategies = [
    { name: "BiswapUsdcUsdt", needOracle: true },
    { name: "BiswapBusdUsdt", needOracle: true },
    { name: "StargateUsdt" },
    { name: "StargateBusd" },
  ];

  for (let i = 0; i < strategies.length; i++) {
    let strategy = strategies[i];
    strategyTest(strategy.name, strategy.needOracle);
  }
});
