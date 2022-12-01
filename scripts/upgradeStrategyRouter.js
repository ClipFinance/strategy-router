const { ethers, upgrades } = require("hardhat");

async function main() {
    if (!process.env.STRATEGY_ROUTER_PROXY_ADDRESS || !process.env.STRATEGY_ROUTER_LIB_ADDRESS) {
        console.log('STRATEGY_ROUTER_PROXY_ADDRESS and STRATEGY_ROUTER_LIB_ADDRESS env variables MUST be defined');
        
        throw new Error('STRATEGY_ROUTER_PROXY_ADDRESS and STRATEGY_ROUTER_LIB_ADDRESS env variables MUST be defined');
    }

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
