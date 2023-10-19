const { ethers } = require("hardhat");
const { getUSDC } = require("../../test/utils");

async function main() {
  // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~

  [owner] = await ethers.getSigners();

  await getUSDC(owner.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
