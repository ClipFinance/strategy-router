const { utils, BigNumber } = require("ethers");

async function getTokenContract(addr) {
  let token = await ethers.getContractAt("MockToken", addr);
  let decimals = Number((await token.decimals()).toString());

  token.decimalNumber = decimals;
  let parseToken = (args) => utils.parseUnits(args, decimals);

  return { token, parseToken };
}

async function getContract(contractName, addr) {
  let contract = await ethers.getContractAt(contractName, addr);

  return contract;
}

function encodeSlot(types, values) {
  return utils.defaultAbiCoder.encode(types, values);
}

// source:  https://blog.euler.finance/brute-force-storage-layout-discovery-in-erc20-contracts-with-hardhat-7ff9342143ed
async function bruteForceTokenBalanceSlotIndex(tokenAddress) {
  const account = ethers.constants.AddressZero;

  const probeA = encodeSlot(["uint"], [1]);
  const probeB = encodeSlot(["uint"], [2]);

  const token = await ethers.getContractAt("ERC20", tokenAddress);

  for (let i = 0; i < 100; i++) {
    let probedSlot = utils.keccak256(
      encodeSlot(["address", "uint"], [account, i])
    ); // remove padding for JSON RPC

    const prev = await network.provider.send("eth_getStorageAt", [
      tokenAddress,
      probedSlot,
      "latest",
    ]);

    while (probedSlot.startsWith("0x0"))
      probedSlot = "0x" + probedSlot.slice(3);

    // make sure the probe will change the slot value
    const probe = prev === probeA ? probeB : probeA;

    await network.provider.send("hardhat_setStorageAt", [
      tokenAddress,
      probedSlot,
      probe,
    ]);

    const balance = await token.balanceOf(account); // reset to previous value
    await network.provider.send("hardhat_setStorageAt", [
      tokenAddress,
      probedSlot,
      prev,
    ]);

    if (balance.eq(ethers.BigNumber.from(probe))) return i;
  }
  throw "Balances slot not found!";
}

// WTF
// https://github.com/nomiclabs/hardhat/issues/1585
const dirtyFix = (s) => {
  return s.toString().replace(/0x0+/, "0x");
};

async function mintForkedToken(token, account, amount) {
  const index = await bruteForceTokenBalanceSlotIndex(token);

  const slot = dirtyFix(
    utils.keccak256(
      encodeSlot(
        ["address", "uint"],
        [typeof account === "string" ? account : account.address, index]
      )
    )
  );

  const prevAmount = await network.provider.send("eth_getStorageAt", [
    token,
    slot,
    "latest",
  ]);

  await network.provider.send("hardhat_setStorageAt", [
    token,
    slot,
    encodeSlot(["uint"], [dirtyFix(BigNumber.from(amount).add(prevAmount))]),
  ]);
}

module.exports = {
  getTokenContract,
  getContract,
  mintForkedToken,
};
