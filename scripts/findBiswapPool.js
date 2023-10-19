const hre = require("hardhat");

/**
 * Helper script to find index of a pool inside of the Biswap's MasterChef contract.
 * Usage: set tokenA and tokenB, run script against bnb chain fork
 * 
 * 
 * USDC-USDT id:4 lp:0x1483767E665B3591677Fd49F724bf7430C18Bf83
 * BUSD-USDT id:1 lp:0xDA8ceb724A06819c0A5cDb4304ea0cB27F8304cF
 * HAY-USDT id:135 lp: 0xE0Aa23541960BdAF33Ac9601a28123b385554E59
 */

async function main() {

  // Enter token pair of the target pool
  let tokenA = "0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5";
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
    "0xDbc1A13490deeF9c3C12b44FE77b503c1B061739"
  );

  let poolLength = await masterChef.poolLength();
  console.log("pool length:", poolLength.toString());

  let found = [];
  for (let i = 0; i < poolLength; i++) {
    try {
      let poolInfo = await masterChef.poolInfo(i);
      if(poolInfo.lpToken === pair) {
        found.push(i);
        console.log("found pool index:", i);
        break;
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
