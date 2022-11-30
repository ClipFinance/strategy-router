const { ethers, upgrades } = require("hardhat");

async function main() {
    const StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
        libraries: {
            StrategyRouterLib: process.env.STRATEGY_ROUTER_LIB_ADDRESS
        }
    });
    const box = await upgrades.upgradeProxy(
        process.env.STRATEGY_ROUTER_PROXY_ADDRESS,
        StrategyRouter
    );
    console.log("Strategy Router upgraded");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });