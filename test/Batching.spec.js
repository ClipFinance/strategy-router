const { expect } = require("chai");
const { ethers } = require("hardhat");
const { provider, deploy} = require("./utils");
const {
    setupFakeTokens,
    setupTokensLiquidityOnPancake,
    setupTestParams,
    deployFakeStrategy,
    setupRouterParams,
    setupFakePrices,
    setupPancakePlugin
} = require("./shared/commonSetup");

describe("Test Batching", function () {

    let owner, user1;

    // mock tokens with different decimals
    let usdc, usdt;

    // helper functions to parse amounts of mock tokens
    let parseUsdc, parseUsdt;

    // core contracts
    let router, oracle, exchange, batching, receiptContract;

    // revert to test-ready state
    let snapshotId;
    // revert to fresh fork state
    let initialSnapshot;

    before(async function () {

        [owner, user1] = await ethers.getSigners();
        initialSnapshot = await provider.send("evm_snapshot");

        // deploy core contracts
        // ({ router, oracle, exchange, batching, receiptContract, sharesToken } = await setupCore());

        // Deploy Oracle
        oracle = await deploy("FakeOracle");
        // Deploy Exchange
        exchange = await deploy("Exchange");
        // Deploy StrategyRouterLib
        let routerLib = await deploy("StrategyRouterLib");
        // Deploy StrategyRouter
        let StrategyRouter = await ethers.getContractFactory("StrategyRouter", {
            libraries: {
                StrategyRouterLib: routerLib.address
            }
        });
        router = await StrategyRouter.deploy(exchange.address, oracle.address);
        await router.deployed();
        // Retrieve contracts that are deployed from StrategyRouter constructor
        batching = await ethers.getContractAt("Batching", await router.batching());
        receiptContract = await ethers.getContractAt("ReceiptNFT", await router.receiptContract());

        // deploy mock tokens where usdc has 18 decimals and usdt 6 decimals
        ({ usdc, usdt, busd, parseUsdc, parseUsdt } = await setupFakeTokens());

        // setup fake token token liquidity
        let amount = (1_000_000).toString();
        await setupTokensLiquidityOnPancake(usdc, busd, amount);
        await setupTokensLiquidityOnPancake(busd, usdt, amount);
        await setupTokensLiquidityOnPancake(usdc, usdt, amount);

        await setupRouterParams(router, oracle, exchange);
        await setupFakePrices(oracle, usdc, usdt, busd);
        await setupPancakePlugin(exchange, usdc, usdt, busd);

        // setup infinite allowance
        await usdc.approve(router.address, parseUsdc("1000000"));
        await usdt.approve(router.address, parseUsdt("1000000"));

        // setup supported tokens
        await router.setSupportedToken(usdc.address, true);
        await router.setSupportedToken(usdt.address, true);

        // add fake strategies
        await deployFakeStrategy({ router, token: usdc });
        await deployFakeStrategy({ router, token: usdt });
    });

    beforeEach(async function () {
        snapshotId = await provider.send("evm_snapshot");
    });

    afterEach(async function () {
        await provider.send("evm_revert", [snapshotId]);
    });

    after(async () => {
        await provider.send("evm_revert", [initialSnapshot]);
    });

    // TODO deposit()
    //   happy path: when funds are deposited batch, receiptNFT is minted and correct values assigned (non-zero/non-default)
    //   corner cases below:
    //     not supported token is deposited, transaction reverted
    //     user deposits deppeged token that numerically match minimum amount, transaction should revert
    //     deposited token has different decimal places (3, 6, 12, 21), expected receipt to have correctly normalized amount value

    //  TODO getBatchingTotalUsdValue()
    //    happy paths: 1 supported token, 3 supported tokens
    //    corner cases below:
    //      within 3 tokens we have 1 token depegged with $0.5 per token, second token with different decimal amount (10^12)
    //       and third is normal

     // TODO withdraw()
    //    happy paths:
    //    corner cases below:
    //      deposit 1000 USDT with decimals 10^6
    //      another deposit 1000 USDC with decimals 10^18
    //      after that withdraw 1000 USDT and 500 USDC we expect first deposit to be burned and partially second deposit burned
    it("Should withdraw correct amount from receipts with different tokens and decimal points", async function() {
        // deposit 1000 USDT with decimals 10^6
        await router.connect(user1).depositToBatch(router.address, parseUsdt("1000"));
        // another deposit 1000 USDC with decimals 10^18
        await router.connect(user1).depositToBatch(router.address, parseUsdc("1500"));
        // check that user1 has 2 receipts
        // we check receipt 1 has amount in 10^6 decimals
        // we check receipt 2 has amount in 10^18 decimals
        // we withdraw from batching, in withdrawal call we provide:
        //  arg 1: receipt ids [1, 2]
        //  arg 2: usdt address
        //  arg 3: amounts [1000*10^6, 500*10^18]
        // we check that
        //  receipt 1 was burned and receipt 2 amount was deducted by the correct amount 500*10^18
        //  batching balance was decreased by $1500
        //  user balance was increased by 1000 usdt and 500 usdc
        // after that withdraw 1500 USDC we expect first deposit to be burned and partially second deposit burned

    });

    //  TODO rebalance()
    //    happy paths:
    //    corner cases below:

    // TODO setSupportedToken()
    //   happy paths: add token, tokken added, is listed in supported tokens
    //    corner cases below:
    //     pass same token multiple times, test function is idempotent
    //     pass address that is not a token
    //   suspended until clarification: happy paths delete token: test
    //     corner cases below:
    //       token is still in already in strategy
});