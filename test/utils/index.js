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
  getTokens, skipBlocks, skipTimeAndBlocks,
  printStruct, BLOCKS_MONTH, BLOCKS_DAY, MONTH_SECONDS, MaxUint256,
  parseUniform, provider, getUSDC, getBUSD, getUSDT,
  deploy, deployProxy,
  convertFromUsdToTokenAmount, applySlippageInBps,
}

// helper to reduce code duplication, transforms 3 lines of deployemnt into 1
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

async function getBUSD(receiverAddress = null) {
  return await mintTokens(hre.networkVariables.busd, receiverAddress);
}

async function getUSDC(receiverAddress = null) {
  return await mintTokens(hre.networkVariables.usdc, receiverAddress);
}

async function getUSDT(receiverAddress = null) {
  return await mintTokens(hre.networkVariables.usdt, receiverAddress);
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

async function mintTokens(tokenAddress, receiverAddress = null) {
  let topupEthBalance = false;
  if (!receiverAddress) {
    const [owner] = await ethers.getSigners();
    receiverAddress = owner.address;
    topupEthBalance = true;
  }

  let tokenContract = await ethers.getContractAt(
    [{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"spender","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Transfer","type":"event"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"burn","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"subtractedValue","type":"uint256"}],"name":"decreaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"getOwner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"addedValue","type":"uint256"}],"name":"increaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"symbol","type":"string"},{"internalType":"uint8","name":"decimals","type":"uint8"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"bool","name":"mintable","type":"bool"},{"internalType":"address","name":"owner","type":"address"}],"name":"initialize","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"mint","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"mintable","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"sender","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"}],
    tokenAddress
  );
  let decimals = await tokenContract.decimals();
  let parse = (args) => parseUnits(args, decimals);
  let tokenAmount = parse("10000000");
  let to = receiverAddress;

  const tokenOwnerAddress = await tokenContract.getOwner();
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [tokenOwnerAddress],
  });

  if (topupEthBalance) {
    // set eth in case if holderAddress has 0 eth.
    await network.provider.send("hardhat_setBalance", [
      receiverAddress,
      "0x" + Number(parseEther("10000").toHexString(2)).toString(2),
    ]);
  }

  let tokenOwner = await ethers.getSigner(tokenOwnerAddress);
  await tokenContract.connect(tokenOwner).mint(
    tokenAmount
  );
  await tokenContract.connect(tokenOwner).transfer(
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

async function convertFromUsdToTokenAmount(oracle, token, valueInUsd)
{
  let [priceInUsd, priceInUsdPrecision] = await oracle.getTokenUsdPrice(
    token.address
  );
  let expectedWithdrawAmount = valueInUsd
    .mul(
      BigNumber.from(10).pow(priceInUsdPrecision)
    )
    .div(
      priceInUsd
    )
    .div(
      BigNumber.from(10).pow(18 - (token.decimalNumber ?? 18))
    )
  ;

  return expectedWithdrawAmount;
}

function applySlippageInBps(amount, slippageInBps)
{
  return amount
    .mul(10000 - slippageInBps)
    .div(10000)
  ;
}