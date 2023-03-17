const { getContract } = require("./forkHelper");

module.exports = {
  getLpAmountFromAmount,
};

async function getLpAmountFromAmount(lpTokenAddr, amount) {
  const stargatePool = await getContract("IStargatePool", lpTokenAddr);
  const convertRate = await stargatePool.convertRate();

  const amountSD = amount.div(convertRate);
  const totalSupply = await stargatePool.totalSupply();
  const totalLiquidity = await stargatePool.totalLiquidity();
  return amountSD.mul(totalSupply).div(totalLiquidity);
}
