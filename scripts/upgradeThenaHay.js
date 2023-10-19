const { ethers, upgrades } = require('hardhat');

async function main () {
  const STRATEGY_ROUTER = "0xc903f9Ad53675cD5f6440B32915abfa955B8CbF4";
  const ADMIN = "0xA6981177F8232D363a740ed98CbBC753424F3B94";
  const ORACLE = "0x8482807e1cae22e6EF248c0B2B6A02B8d581f537";
  const THENA_HAY_PROXI = "0x9673c313c963B5175FF69D88830B3C1B1d6ccF27";

  const admin = await ethers.getContractAt("RouterAdmin", ADMIN);
  try {
    await admin.rebalanceStrategies();
  } catch (error) {
    console.log("first attempt", error);
  }

  const ThenaHay = await ethers.getContractFactory('ThenaHay');
  // use it if you are not implementation of ThenaHay in .openzeppelin/upgrades/<network>.json
  // await upgrades.forceImport(
  //   THENA_HAY_PROXI,
  //   ThenaHay,
  //   {
  //     kind: "uups",
  //     constructorArgs: [STRATEGY_ROUTER, ORACLE, 300],
  //     unsafeAllow: ['delegatecall'],
  //     initializer: 'initialize(address, uint256, uint16, address[])',
  //   }
  // )
  console.log('Upgrading ThenaHay...');
  await upgrades.upgradeProxy(
    THENA_HAY_PROXI,
    ThenaHay,
    {
      kind: "uups",
      constructorArgs: [STRATEGY_ROUTER, ORACLE, 300],
      unsafeAllow: ['delegatecall'],
      initializer: 'initialize(address, uint256, uint16, address[])',
    }
  );
  console.log('ThenaHay upgraded');

  try {
    await admin.rebalanceStrategies();
    console.log("successfull rebalanceStrategies");
  } catch (error) {
    console.log("second attempt", error);
  }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
