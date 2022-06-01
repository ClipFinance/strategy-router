const { parseEther, parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");

MONTH_SECONDS = 60 * 60 * 24 * 30;
BLOCKS_MONTH = MONTH_SECONDS / 3;
BLOCKS_DAY = 60 * 60 * 24 / 3;
MaxUint256 = ethers.constants.MaxUint256;

provider = ethers.provider;
parseUsdc = (args) => parseUnits(args, 18);
parseUsdt = (args) => parseUnits(args, 18);
parseBusd = (args) => parseUnits(args, 18);
parseUst = (args) => parseUnits(args, 18);
parseUniform = (args) => parseUnits(args, 18);

module.exports = {
  getTokens, skipBlocks, skipCycleAndBlocks,
  printStruct, BLOCKS_MONTH, BLOCKS_DAY, MONTH_SECONDS, MaxUint256,
  parseUsdt, parseUsdc, parseBusd, parseUst, parseUniform, provider, getUSDC, getBUSD, getUSDT,
  deploy
}

async function deploy(contractName, ...constructorArgs) {
  // console.log(contractName, "constructorArgs", constructorArgs);
  // console.log("destructed", ...constructorArgs);
  let factory = await ethers.getContractFactory(contractName);
  let contract = await factory.deploy(...constructorArgs);
  return await contract.deployed();
}

async function getBUSD() {
  return await getTokens(hre.networkVariables.busd, hre.networkVariables.busdHolder);
}

async function getUSDC() {
  return await getTokens(hre.networkVariables.usdc, hre.networkVariables.usdcHolder);
}

async function getUSDT() {
  return await getTokens(hre.networkVariables.usdt, hre.networkVariables.usdtHolder);
}

// 'getTokens' functions are helpers to retrieve tokens during tests. 
// Simply saying to draw fake balance for test wallet.
async function getTokens(tokenAddress, holderAddress) {
  const [owner] = await ethers.getSigners();
  let tokenContract = await ethers.getContractAt("ERC20", tokenAddress);
  let decimals = await tokenContract.decimals();
  let parse = (args) => parseUnits(args, decimals);
  let tokenAmount = parse("500000");
  let to = owner.address;

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [holderAddress],
  });
  let holder = await ethers.getSigner(holderAddress);
  // set eth in case if holderAddress has 0 eth.
  await network.provider.send("hardhat_setBalance", [
    holder.address.toString(),
    "0x" + Number(parseEther("10000").toHexString(2)).toString(2),
  ]);
  await tokenContract.connect(holder).transfer(
    to,
   tokenAmount 
  );

  return tokenContract;
}

async function skipBlocks(blocksNum) {
  blocksNum = "0x" + blocksNum.toString(16);
  await hre.network.provider.send("hardhat_mine", [blocksNum]);
}

async function skipCycleAndBlocks() {
  await provider.send("evm_increaseTime", [CYCLE_DURATION]);
  await provider.send("evm_mine");
  skipBlocks(CYCLE_DURATION / 3);
}

// Usually tuples returned by solidity (or ethers.js) contain duplicated data
// one data is named variables and second unnamed (e.g. {var:5, 5}).
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