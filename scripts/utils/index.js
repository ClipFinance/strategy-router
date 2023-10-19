const hre = require("hardhat");
const { ethers, upgrades } = hre;

const DELAY = 20_000; // 20 sec
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Function caches deploy arguments at runtime of this script
async function setupVerificationHelper() {
  let oldDeploy = hre.ethers.ContractFactory.prototype.deploy;
  hre.ethers.ContractFactory.prototype.deploy = async function (...args) {
    let contract = await oldDeploy.call(this, ...args);
    contract.constructorArgs = args;
    return contract;
  };
}

// Helper function that won't exit script on error
async function safeVerify(verifyArgs) {
  try {
    await hre.run("verify:verify", verifyArgs);
  } catch (error) {
    console.error(error);
  }
}

async function safeVerifyMultiple(deployedContracts) {
  for (let i = 0; i < deployedContracts.length; i++) {
    try {
      const contract = deployedContracts[i];
      if (typeof contract === "string") {
        await safeVerify({
          address: contract,
          constructorArguments: [],
        });
      } else {
        await safeVerify({
          address: contract.address,
          constructorArguments: contract.constructorArgs,
        });
      }
    } catch (error) {
      console.error(error);
    }
  }
}

async function deployProxyIdleStrategy(
  owner,
  batch,
  router,
  moderatorAddress,
  token,
  tokenName,
  WAIT_CONFIRMATIONS = 1
) {
  console.log(`Deploying ${tokenName} IdleStrategy...`);
  const IdleStrategyFactory = await ethers.getContractFactory(
    "DefaultIdleStrategy"
  );
  const idleStrategy = await upgrades.deployProxy(
    IdleStrategyFactory,
    [owner.address, [router.address, batch.address]],
    {
      kind: "uups",
      constructorArgs: [router.address, token.address],
      unsafeAllow: ["delegatecall"],
    }
  );
  await idleStrategy.deployed();
  console.log(`${tokenName} IdleStrategy deployed to:`, idleStrategy.address);

  // set moderator and transfer ownership to router
  console.log("Setting moderator...");
  await (
    await idleStrategy.setModerator(moderatorAddress)
  ).wait(WAIT_CONFIRMATIONS);
  console.log("Transferring ownership to router...");
  await (
    await idleStrategy.transferOwnership(router.address)
  ).wait(WAIT_CONFIRMATIONS);

  return idleStrategy;
}

async function create2DeployProxyIdleStrategy(
  create2Deployer,
  ProxyBytecode,
  owner,
  batch,
  router,
  moderatorAddress,
  token,
  tokenName,
  WAIT_CONFIRMATIONS = 1
) {
  console.log(`Deploying ${tokenName} IdleStrategy...`);

  const {
    proxyAddress: idleStrategyProxyAddress,
    proxyContract: idleStrategy,
    implementation: implIdleStrategy,
  } = await create2DeployProxy({
    create2Deployer,
    ProxyBytecode,
    saltAddition: tokenName,
    ContractName: "DefaultIdleStrategy",
    constructorArgs: [router.address, token.address],
    initializeTypes: ["address", "address[]"],
    initializeArgs: [owner.address, [router.address, batch.address]],
  });
  console.log(
    `${tokenName} IdleStrategy deployed proxy to:`,
    idleStrategyProxyAddress
  );

  // set moderator and transfer ownership to router
  console.log("Setting moderator...");
  await (
    await idleStrategy.setModerator(moderatorAddress)
  ).wait(WAIT_CONFIRMATIONS);
  console.log("Transferring ownership to router...");
  await (
    await idleStrategy.transferOwnership(router.address)
  ).wait(WAIT_CONFIRMATIONS);

  return {
    idleStrategyProxyAddress,
    idleStrategy,
    implIdleStrategy,
  };
}

async function create2DeployProxy({
  create2Deployer,
  ProxyBytecode,
  saltAddition = "",
  ContractName,
  factoryOptions = {},
  constructorArgs = [],
  initializeTypes = [],
  initializeArgs = [],
  signer = "",
}) {
  // Get the implementation contract factory
  const Implementation = await ethers.getContractFactory(
    ContractName,
    factoryOptions
  );

  // Deploy the implementation contract
  const implementation = await Implementation.deploy(...constructorArgs);
  await implementation.deployed();

  // Generate the salt
  const salt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(ContractName + saltAddition + "Salt")
  );

  // Encode the initialization function arguments
  const initializeData = ethers.utils.defaultAbiCoder.encode(
    initializeTypes,
    initializeArgs
  );

  // Call the deployProxy function using the imported ProxyBytecode
  const tx = await create2Deployer.deployProxy(
    0,
    salt,
    ProxyBytecode,
    implementation.address,
    initializeData
  );
  const receipt = await tx.wait();

  // Compute the expected address
  const codeHash = ethers.utils.keccak256(ProxyBytecode);
  const proxyAddress = await create2Deployer.computeAddress(salt, codeHash);

  // Get the proxy contract instance
  if (!signer) signer = (await ethers.getSigners())[0]; // default to first signer
  const proxyContract = await ethers.getContractAt(
    ContractName,
    proxyAddress,
    signer
  );

  return { proxyAddress, proxyContract, receipt, implementation };
}

async function create2Deploy({
  create2Deployer,
  saltAddition = "",
  ContractName,
  factoryOptions = {},
  constructorArgs = [],
  signer = "",
}) {
  // Get the contract factory
  const Factory = await ethers.getContractFactory(ContractName, factoryOptions);

  // Add the constructor arguments to the bytecode to get the deployment bytecode
  const deploymentBytecode = Factory.getDeployTransaction(
    ...constructorArgs
  ).data;

  // Generate the salt
  const salt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(ContractName + saltAddition + "Salt")
  );

  // Call the deploy function using the imported deploymentBytecode of the contract
  const tx = await create2Deployer.deploy(0, salt, deploymentBytecode);
  const receipt = await tx.wait();

  // Compute the expected address
  const codeHash = ethers.utils.keccak256(deploymentBytecode);
  const contractAddress = await create2Deployer.computeAddress(salt, codeHash);

  // Get the contract instance
  if (!signer) signer = (await ethers.getSigners())[0]; // default to first signer
  const contract = await ethers.getContractAt(
    ContractName,
    contractAddress,
    signer
  );

  return { contractAddress, contract, receipt };
}

module.exports = {
  DELAY,
  delay,

  setupVerificationHelper,
  safeVerify,
  safeVerifyMultiple,

  deployProxyIdleStrategy,
  create2DeployProxyIdleStrategy,
  create2DeployProxy,
  create2Deploy,
};
