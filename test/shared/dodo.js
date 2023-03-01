const { parseUnits, parseEther } = require("ethers/lib/utils");
const { ethers, upgrades } = require("hardhat");
const { getContract } = require("./forkHelper");

module.exports = {
  getLpAmountFromAmount,
  getAmountFromLpAmount,
};

async function getLpAmountFromAmount(poolAddr, lpTokenAddr, isQuote, amount) {
  const dodoPool = await getContract("IDodoSingleAssetPool", poolAddr);
  const lpToken = await getContract("MockToken", lpTokenAddr);

  const expectedTarget = await dodoPool.getExpectedTarget();
  const lpSupply = await lpToken.totalSupply();

  return amount.mul(lpSupply).div(expectedTarget[isQuote ? 1 : 0]);
}

async function getAmountFromLpAmount(poolAddr, lpTokenAddr, isQuote, lpAmount) {
  const dodoPool = await getContract("IDodoSingleAssetPool", poolAddr);
  const lpToken = await getContract("MockToken", lpTokenAddr);

  const expectedTarget = await dodoPool.getExpectedTarget();
  const lpSupply = await lpToken.totalSupply();

  return lpAmount.mul(expectedTarget[isQuote ? 1 : 0]).div(lpSupply);
}
