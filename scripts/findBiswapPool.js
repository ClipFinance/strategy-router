const hre = require("hardhat");

/**
 * Helper script to find index of a pool inside of the Biswap's MasterChef contract.
 * USDC-USDT id 4
 */

async function main() {
  
  // Enter token pair of the target pool
  let tokenA = "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56";
  let tokenB = "0x55d398326f99059fF775485246999027B3197955";


  // dont touch these
  let biswapFactory = await hre.ethers.getContractAt(
    "IUniswapV2Factory",
    "0x858e3312ed3a876947ea49d572a7c42de08af7ee"
  );
  let pair = await biswapFactory.getPair(tokenA, tokenB);
  console.log("LP address", pair);
  let masterChef = await hre.ethers.getContractAt(
    "IBiswapFarm",
    "0xdbc1a13490deef9c3c12b44fe77b503c1b061739"
  );

  let found = [];
  for (let i = 0; ; i++) {
    try {
      let poolInfo = await masterChef.poolInfo(i);
      if(poolInfo.lpToken === pair) {
        found.push(i);
        console.log("found pool index:", i);
        // break;
      }
    } catch (error) {
        if(found.length == 0) console.log("POOL NOT FOUND");
        else console.log("pool id: ", found);
        break;
    }
  }

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
