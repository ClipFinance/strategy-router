const hre = require("hardhat");

const main = async () => {
  await hre.run("verify:verify", {
    contract: "contracts/StrategyRouter.sol:StrategyRouter",
    address: "0x6f96752776a37971ca962744112f030183c9f0e9",
    libraries: {
      StrategyRouterLib: "0xc39e145636067e6761C798fF6358731f91DF332C"
    }
  });

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
