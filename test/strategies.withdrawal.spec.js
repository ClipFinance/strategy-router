const strategyTest = require("./shared/strategyTest");

describe("Test strategies", function () {

  let strategies = [
    { name: "BiswapUsdcUsdt", strategyToken: 'usdc', },
    { name: "BiswapBusdUsdt", strategyToken: 'busd', },
  ];

  for (let i = 0; i < strategies.length; i++) {
      let strategy = strategies[i];
      strategyTest(strategy.name, strategy.strategyToken);
  }
});
