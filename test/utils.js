const { expect, should, use } = require("chai");
const { BigNumber } = require("ethers");
const { parseEther, parseUnits, formatEther, formatUnits } = require("ethers/lib/utils");
const { ethers, waffle } = require("hardhat");

BLOCKS_MONTH = 60 * 60 * 24 * 30 / 3;
BLOCKS_DAY = 60 * 60 * 24 / 3;

module.exports = { logFarmLPs, getTokens, skipBlocks, skipCycleTime, printStruct, BLOCKS_MONTH, BLOCKS_DAY}


// await network.provider.send("hardhat_setBalance", [ ((await ethers.getSigners())[0]).address.toString(), "0x" + Number(ethers.utils.parseEther("10000").toHexString(2)).toString(2), ]);

async function logFarmLPs() {
  userInfo = await farmAcryptos.userInfo(lpTokenAcryptos.address, strategyAcryptos.address);
  console.log("acryptos farm lp tokens %s", userInfo.amount);
  userInfo = await farmBiswap.userInfo(poolIdBiswap, strategyBiswap.address);
  console.log("biswap farm lp tokens %s", userInfo.amount);
}

async function getTokens(token, holder, amount, to) {
  token = await ethers.getContractAt("ERC20", token);

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [holder],
  });
  holder = await ethers.getSigner(holder);
  // set eth in case if holder has 0 eth.
  await network.provider.send("hardhat_setBalance", [
    holder.address.toString(),
    "0x" + Number(parseEther("10000").toHexString(2)).toString(2),
  ]);
  await token.connect(holder).transfer(
    to,
    amount
  );

  return token;
}

async function skipBlocks(blocksNum) {
  blocksNum = "0x" + blocksNum.toString(16);
  await hre.network.provider.send("hardhat_mine", [blocksNum]);
}

async function skipCycleTime() {
  await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  await provider.send("evm_mine");
}

// Usually tuples returned by solidity (or ethers.js) contain duplicated data
// one data is named variables and second unnamed.
// This helper should remove such duplication and print result in console.
function printStruct(struct) {
  let obj = struct;
  let out = {};
  for (let key in obj) {
    if (!Number.isInteger(Number(key))) {
      out[key] = obj[key];
    }
  }
  console.log(out);
}