const strategyTest = require("./shared/strategyTest");

describe("Test strategies", function () {
  let strategies = [
    { name: "DodoUsdt" },
    { name: "BiswapUsdcUsdt" },
    { name: "BiswapBusdUsdt" },
    { name: "StargateUsdt" },
    { name: "StargateBusd" },
  ];

  for (let i = 0; i < strategies.length; i++) {
    let strategy = strategies[i];
    strategyTest(strategy.name, strategy.needOracle);
  }
});
