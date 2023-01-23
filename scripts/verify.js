const hre = require("hardhat");

const main = async () => {
  await hre.run("verify:verify", {
    contract: "contracts/StrategyRouter.sol:StrategyRouter",
    address: "0xa55b2c1a428534e74e551d1756d1fbd511f4975b",
    libraries: {
      StrategyRouterLib: "0x672fa3e919848BfCca1BB7F8667D33DB16a12a05"
    }
  });

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
