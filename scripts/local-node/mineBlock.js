const { network } = require("hardhat");

async function main() {
  await network.provider.send("evm_increaseTime", [3600]);
  await network.provider.send("evm_mine");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });