const { parseEther, parseUnits } = require("ethers/lib/utils");
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");

MONTH_SECONDS = 60 * 60 * 24 * 30;
BLOCKS_MONTH = MONTH_SECONDS / 3;
BLOCKS_DAY = 60 * 60 * 24 / 3;
MaxUint256 = ethers.constants.MaxUint256;

provider = ethers.provider;
const parseUniform = (args) => parseUnits(args, 18);

module.exports = {
  matchTokenBalance, getTokens, skipBlocks, skipTimeAndBlocks,
  printStruct, BLOCKS_MONTH, BLOCKS_DAY, MONTH_SECONDS, MaxUint256,
  parseUniform, provider, getUSDC, getBUSD, getUSDT,
  deploy, deployProxy
}

// helper to reduce code duplication, transforms 3 lines of deployment into 1
async function deploy(contractName, ...constructorArgs) {
  let factory = await ethers.getContractFactory(contractName);
  let contract = await factory.deploy(...constructorArgs);
  return await contract.deployed();
}

async function deployProxy(contractName, initializeArgs = []) {
  let factory = await ethers.getContractFactory(contractName);
  let contract = await upgrades.deployProxy(factory, initializeArgs, {
    kind: 'uups',
  });
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

async function matchTokenBalance(tokenAddress, tokenHolder, matchAmount) {

  const [owner] = await ethers.getSigners();
  let tokenContract = await ethers.getContractAt("ERC20", tokenAddress);
  let tokenBalance = await tokenContract.balanceOf(tokenHolder);

  let tokenMaster;

  switch(tokenAddress) {
    case hre.networkVariables.busd:
      tokenMaster = hre.networkVariables.busdHolder;
      break;
    case hre.networkVariables.usdc:
      tokenMaster = hre.networkVariables.usdcHolder;
      break;
    case hre.networkVariables.usdt:
      tokenMaster = hre.networkVariables.usdtHolder;
      break;
    default: 
    tokenMaster = owner;
  }

  if (tokenBalance < matchAmount) {
    let diffAmount = BigNumber.from(matchAmount).sub(BigNumber.from(tokenBalance));
    await tokenContract.connect(tokenMaster).transfer(
      tokenHolder,
      diffAmount
    );
  }
}

// 'getTokens' functions are helpers to retrieve tokens during tests. 
// Simply saying to draw fake balance for test wallet.
async function getTokens(tokenAddress, holderAddress) {
  const [owner] = await ethers.getSigners();
  let tokenContract = await ethers.getContractAt("ERC20", tokenAddress);
  let decimals = await tokenContract.decimals();
  let parse = (args) => parseUnits(args, decimals);
  let tokenAmount = parse("10000000");
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

  return { tokenContract, parse };
}

// skip hardhat network blocks
async function skipBlocks(blocksNum) {
  blocksNum = Math.round(blocksNum);
  blocksNum = "0x" + blocksNum.toString(16);
  await hre.network.provider.send("hardhat_mine", [blocksNum]);
}

// 
async function skipTimeAndBlocks(timeToSkip, blocksToSkip) {
  await provider.send("evm_increaseTime", [Number(timeToSkip)]);
  await provider.send("evm_mine");
  skipBlocks(Number(blocksToSkip));
}

// Usually tuples returned by ethers.js contain duplicated data,
// named and unnamed e.g. [var:5, 5].
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