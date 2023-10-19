const hre = require("hardhat");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { impersonate, dirtyFix } = require("../../test/shared/forkHelper");
const { setupTokens } = require("../../test/shared/commonSetup");

const { parseUnits } = require("ethers/lib/utils");
const {
  deploy,
  deployProxy,
  deployProxyIdleStrategy,
  parseUniform,
  convertFromUsdToTokenAmount,
  applySlippageInBps,
} = require("../../test/utils");

// deploy thena hay strategy script on mainnet

describe("Test deploy thena hay strategy script", function () {
  let owner, adminModerator;
  // tokens
  let usdc, usdt, busd, hay;
  // helper functions to parse amounts of tokens
  let parseUsdc, parseBusd, parseUsdt, parseHay;
  // core contracts
  let admin, router, batch, exchange, oracle, receiptContract;
  // exchange plugins
  let wombatPlugin, biSwapPlugin, thenaAlgebraPlugin;
  // new strategies contracts
  let thenaHay, biswapHayUsdt;
  // idle strategies contracts
  let idleStrategies;
  // strategies tokens addresses
  let bswAddress;

  before(async function () {
    // ~~~~~~~~~~~ HELPERS ~~~~~~~~~~~

    [owner] = await ethers.getSigners();

    // ~~~~~~~~~~~ GET TOKENS ADDRESSES ON MAINNET ~~~~~~~~~~~
    busd = await ethers.getContractAt("ERC20", hre.networkVariables.busd);
    usdc = await ethers.getContractAt("ERC20", hre.networkVariables.usdc);
    usdt = await ethers.getContractAt("ERC20", hre.networkVariables.usdt);
    hay = await ethers.getContractAt("ERC20", hre.networkVariables.hay);
    const usdcDecimals = await usdc.decimals();
    const usdtDecimals = await usdt.decimals();
    const busdDecimals = await busd.decimals();
    const hayDecimals = await hay.decimals();
    parseUsdc = (amount) => parseUnits(amount, usdcDecimals);
    parseUsdt = (amount) => parseUnits(amount, usdtDecimals);
    parseBusd = (amount) => parseUnits(amount, busdDecimals);
    parseHay = (amount) => parseUnits(amount, hayDecimals);

    // ~~~~~~~~~~~~~~~ SETTINGS ~~~~~~~~~~~~~~~~\

    const ADMIN = "0xA6981177F8232D363a740ed98CbBC753424F3B94";
    const STRATEGY_ROUTER = "0xc903f9Ad53675cD5f6440B32915abfa955B8CbF4";
    const BATCH = "0xCEE26C4C6f155408cb1c966AaFcd8966Ec60E80b";
    const SHARES_TOKEN = "0xf42b35d37eC8bfC26173CD66765dd5B84CCB03E3";
    const RECEIPT_CONTRACT = "0xa9AA2EdF9e11E72e1100eBBb4A7FE647C12B55Ab";
    // const EXCHANGE = "0xE6d68cdA34a38e40DEfbEDA69688036E5250681d"; // will deploy new one
    const ORACLE = "0x8482807e1cae22e6EF248c0B2B6A02B8d581f537";
    const PANCAKE_V3_PLUGIN = "0x6025712051Bb2067686C291d3266DD92b824dDd3";
    const PANCAKE_V2_PLUGIN = "0x1974e981359a17e7508Af4B55D90fb61ECF880eF";

    // Set core contracts addresses
    router = await ethers.getContractAt("StrategyRouter", STRATEGY_ROUTER);
    batch = await ethers.getContractAt("Batch", BATCH);
    oracle = await ethers.getContractAt("ChainlinkOracle", ORACLE);
    receiptContract = await ethers.getContractAt("ReceiptNFT", RECEIPT_CONTRACT);
    admin = await ethers.getContractAt("RouterAdmin", ADMIN);

    adminModerator = await impersonate("0xcAD3e8A8A2D3959a90674AdA99feADE204826202");

    bswAddress = hre.networkVariables.bsw;
    const stgAddress = hre.networkVariables.stg;
    const dodoAddress = hre.networkVariables.dodo;
    const theAddress = hre.networkVariables.the;

    // ~~~~~~~~~~~ DEPLOY THENA HAY STRATEGY ~~~~~~~~~~~
    console.log(" ");
    console.log("Deploying Thena Hay Strategy...");

    let StrategyFactory = await ethers.getContractFactory("ThenaHay");
    const priceManipulationPercentThresholdInBps = 300; // 3%
    thenaHay = await upgrades.deployProxy(
      StrategyFactory,
      [
        owner.address,
        parseHay((1_000_000).toString()), // TODO change to real value on production deploy
        500, // 5%
        [
          STRATEGY_ROUTER,
          BATCH,
        ]
      ],
      {
        kind: "uups",
        constructorArgs: [STRATEGY_ROUTER, ORACLE, priceManipulationPercentThresholdInBps],
        unsafeAllow: ['delegatecall'],
        initializer: 'initialize(address, uint256, uint16, address[])',
      }
    );
    console.log("Deployed Thena Hay Strategy address:", thenaHay.address);

    console.log("Transfering ownership of Thena Hay Strategy to Strategy Router...")
    await thenaHay.transferOwnership(STRATEGY_ROUTER);

    // ~~~~~~~~~~~ DEPLOY BISWAP HAY STRATEGY ~~~~~~~~~~~
    console.log(" ");
    console.log("Deploying Biswap Hay Strategy...");

    StrategyFactory = await ethers.getContractFactory("BiswapHayUsdt");
    biswapHayUsdt = await upgrades.deployProxy(
      StrategyFactory,
      [
        owner.address,
        parseHay((1_000_000).toString()), // TODO change to real value on production deploy
        500, // 5%
        [
          STRATEGY_ROUTER,
          BATCH,
        ]
      ],
      {
        kind: "uups",
        constructorArgs: [STRATEGY_ROUTER, ORACLE, priceManipulationPercentThresholdInBps],
        unsafeAllow: ['delegatecall'],
        initializer: 'initialize(address, uint256, uint16, address[])',
      }
    );
    console.log("Deployed Biswap Hay Strategy address:", biswapHayUsdt.address);

    console.log("Transfering ownership of Biswap Hay Strategy to Strategy Router...")
    await biswapHayUsdt.transferOwnership(STRATEGY_ROUTER);

    // ~~~~~~~~~~~ DEPLOY Exchange ~~~~~~~~~~~

    console.log(" ");
    console.log("Deploing new Exchange contract and update it on strategy router...");

    exchange = await deployProxy("Exchange");
    console.log("Exchange", exchange.address);

    // setup Batch and Router addresses to update exchange address
    console.log("Updating exchange address on Batch...");
    await batch.connect(adminModerator).setAddresses(
      exchange.address,
      oracle.address,
      router.address,
      RECEIPT_CONTRACT
    );

    console.log("Updating exchange address on Strategy Router...");
    await admin.connect(adminModerator).setAddresses(
      exchange.address,
      oracle.address,
      SHARES_TOKEN,
      batch.address,
      RECEIPT_CONTRACT
    );

    // ~~~~~~~~~~~ ADDITIONAL SETUP ~~~~~~~~~~~

    console.log(" ");
    console.log("Setting up Price feeds for HAY and BSW tokens...");

    await oracle.connect(adminModerator).setPriceFeeds(
      [hay.address, bswAddress],
      [hre.networkVariables.HayUsdPriceFeed, hre.networkVariables.BswUsdPriceFeed]
    );

    console.log(" ");
    console.log("Deploing new Idle Strategies for supported tokens...");
    const busdIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, busd);
    const usdcIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, usdc);
    const usdtIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, usdt);

    const newIdleStrategies = {
      [busd.address]: {
        address: busdIdleStrategy.address,
        symbol: "BUSD",
      },
      [usdc.address]: {
        address: usdcIdleStrategy.address,
        symbol: "USDC",
      },
      [usdt.address]: {
        address: usdtIdleStrategy.address,
        symbol: "USDT",
      },
    };

    const idleStrategiesData = await router.getIdleStrategies();

    await Promise.all(idleStrategiesData.map(async (idleStrategyData, strategyIndex) => {
      const { strategyAddress: oldStrategyAddress, depositToken } = idleStrategyData;

      await admin.connect(adminModerator).setIdleStrategy(strategyIndex, newIdleStrategies[depositToken].address);

      console.log(`Idle Strategy for ${newIdleStrategies[depositToken].symbol} updated from ${oldStrategyAddress} to ${newIdleStrategies[depositToken].address}`);
    }));

    console.log(" ");
    console.log("Deploing new Hay Idle Strategy and adding HAY as supported token...");

    hayIdleStrategy = await deployProxyIdleStrategy(owner, batch, router, admin.address, hay);
    console.log("Deployed Hay Idle Strategy: ", hayIdleStrategy.address);
    await admin.connect(adminModerator).setSupportedToken(hay.address, true, hayIdleStrategy.address);

    idleStrategies = {
      ...newIdleStrategies,
      [hay.address]: {
        address: hayIdleStrategy.address,
        symbol: "HAY",
      },
    };

    console.log(" ");
    console.log("Adding Thena Hay Strategy to Strategy Router...");
    await admin.connect(adminModerator).addStrategy(thenaHay.address, 10000); // TODO change strategy weight to real value on production deploy

    console.log(" ");
    console.log("Adding Biswap Hay Strategy to Strategy Router...");
    await admin.connect(adminModerator).addStrategy(biswapHayUsdt.address, 10000); // TODO change strategy weight to real value on production deploy

    // wombat plugin params
    console.log(" ");
    console.log("Deploing Wombat Plugin and setting up its params...");
    wombatPlugin = await deploy(
      "WombatPlugin",
      hre.networkVariables.wombatRouter
    );
    console.log("Wombat Plugin: ", wombatPlugin.address);

    console.log("Setting up USDC as the mediator token for HAY/BUSD pair...");
    await wombatPlugin.setMediatorTokenForPair(
      usdc.address,
      [hay.address, busd.address]
    );

    console.log("Setting up Hay Pool as the pool for HAY/USDC pair...");
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatHayPool,
      [hay.address, usdc.address]
    );

    console.log("Setting up Main Pool as the pool for USDC/BUSD pair...");
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatMainPool,
      [usdc.address, busd.address]
    );

    console.log("Setting up Main Pool as the pool for HAY/USDT pair...");
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatHayPool,
      [hay.address, usdt.address]
    );

    console.log("Setting up Main Pool as the pool for BUSD/USDT pair...");
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatMainPool,
      [busd.address, usdt.address]
    );

    console.log("Setting up Main Pool as the pool for USDC/USDT pair...");
    await wombatPlugin.setPoolForPair(
      hre.networkVariables.wombatMainPool,
      [usdc.address, usdt.address]
    );

    // biswap plugin params
    console.log(" ");
    console.log("Deploing Biswap Plugin and setting up its params...");
    biSwapPlugin = await deploy(
      "UniswapPlugin",
      hre.networkVariables.biswapRouter
    );
    console.log("BiSwapPlugin Plugin: ", biSwapPlugin.address);

    console.log("Setting up USDT as the mediator token for BSW/HAY pair...");
    await biSwapPlugin.setMediatorTokenForPair(
      usdt.address,
      [bswAddress, hay.address]
    );

    // thena algebra plugin params
    console.log(" ");
    console.log("Deploing Thena Algebra Plugin and setting up its params...");
    thenaAlgebraPlugin = await deploy(
      "AlgebraPlugin",
      hre.networkVariables.thenaAlgebraRouter,
      hre.networkVariables.thenaAlgebraFactory
    );
    console.log("ThenaAlgebra Plugin: ", thenaAlgebraPlugin.address);

    console.log("Setting up USDT as the mediator token for THE/HAY and THE/USDC pair...");
    await thenaAlgebraPlugin.setMediatorTokenForPair(
      usdt.address,
      [theAddress, hay.address]
    );
    await thenaAlgebraPlugin.setMediatorTokenForPair(
      usdt.address,
      [theAddress, usdc.address]
    );

    // setup Exchange params
    console.log(" ");
    console.log("Setting up MaxStablecoinSlippageInBps Exchange routes...");
    await exchange.setMaxStablecoinSlippageInBps(50); // 0.5%

    await exchange.setRoute(
      [
        // stable coins
        busd.address,
        busd.address,
        usdc.address,

        // hay pairs
        hay.address,
        hay.address,
        hay.address,

        // bsw pairs
        bswAddress,
        bswAddress,
        bswAddress,
        bswAddress,

        // stg pairs
        stgAddress,
        stgAddress,

        // dodo pairs
        dodoAddress,
        dodoAddress,

        // thena pairs
        theAddress,
        theAddress,
        theAddress,

      ],
      [
        // stable coins
        usdt.address,
        usdc.address,
        usdt.address,

        // hay pairs
        usdc.address,
        usdt.address,
        busd.address,

        // bsw pairs
        busd.address,
        usdt.address,
        usdc.address,
        hay.address,

        // stg pairs
        usdt.address,
        busd.address,

        // dodo pairs
        usdt.address,
        busd.address,

        // the pairs
        usdt.address,
        usdc.address,
        hay.address,

      ],
      [
        // stable coins
        PANCAKE_V3_PLUGIN,
        PANCAKE_V3_PLUGIN,
        PANCAKE_V3_PLUGIN,

        // hay pairs
        wombatPlugin.address,
        wombatPlugin.address,
        wombatPlugin.address,

        // bsw pairs
        PANCAKE_V2_PLUGIN,
        PANCAKE_V2_PLUGIN,
        PANCAKE_V2_PLUGIN,
        biSwapPlugin.address,

        // stg pairs
        PANCAKE_V2_PLUGIN,
        PANCAKE_V2_PLUGIN,

        // dodo pairs
        PANCAKE_V2_PLUGIN,
        PANCAKE_V2_PLUGIN,

        // the pairs
        thenaAlgebraPlugin.address,
        thenaAlgebraPlugin.address,
        thenaAlgebraPlugin.address,

        ]
    );

    console.log("Congratulation!!! You are successfully deployed and set up Thena Hay and Biswap Hay Strategies!")

    // mint tokens to test
    console.log(" ");
    console.log("Minting tokens to test...");
    await setupTokens();

  });

  describe("Variables checking", async function () {
    it("router and batch should have new exchange address", async function () {
      const routerExchange = await provider.getStorageAt(router.address, 106);
      const batchExchange = await batch.exchange();
      expect(dirtyFix(routerExchange).toLowerCase()).to.be.equal(exchange.address.toLowerCase());
      expect(batchExchange).to.be.equal(exchange.address);
    });

    it("router should has new idle strategies", async function () {
      const idleStrategiesData = await router.getIdleStrategies();

      // expect that we have 4 idle strategies with BUSD, USDC, USDT and HAY tokens
      expect(idleStrategiesData.length).to.be.equal(4);

      // expect that we have updated idle strategies addresses
      idleStrategiesData.forEach((idleStrategyData, strategyIndex) => {
        const { strategyAddress, depositToken } = idleStrategyData;
        expect(idleStrategies[depositToken].address).to.be.equal(strategyAddress);
      });
    });

    it("oracle should have new price feeds", async function () {
      expect(await oracle.isTokenSupported(hay.address)).to.be.equal(true);
      expect(await oracle.isTokenSupported(bswAddress)).to.be.equal(true);
    });

  });

  describe("Rebalance strategies", async function () {
    it("should successfuly rebalance strategies", async function () {
      const [initialTVL] = await router.getStrategiesValue();

      await expect(admin.connect(adminModerator).rebalanceStrategies()).not.to.be.reverted;

      const [afterRebalanceTVL] = await router.getStrategiesValue();
      expect(afterRebalanceTVL).to.be.gt(initialTVL);

    });
  });

  describe("Deposit to batch and allocation to strategies", async function () {
    it("should successfuly allocate to strategies with 10K of HAY tokens", async function () {
      const [initialTVL] = await router.getStrategiesValue();

      const amountDeposit = (10_000).toString();
      const amountDepositUniform = parseUniform(amountDeposit);
      const amountDepositHay = parseHay(amountDeposit)
      await hay.approve(router.address, amountDepositHay);

      await router.depositToBatch(hay.address, amountDepositHay, "");

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const [afterAllocateTVL] = await router.getStrategiesValue();
      expect(afterAllocateTVL).to.be.closeTo(
        initialTVL.add(amountDepositUniform),
        amountDepositUniform.mul(50).div(10000) // 0.5% slippage
      );
    });

    it("should successfuly allocate to strategies with 100K of BUSD tokens", async function () {
      const [initialTVL] = await router.getStrategiesValue();

      const amountDeposit = (100_000).toString();
      const amountDepositUniform = parseUniform(amountDeposit);
      const amountDepositBusd = parseBusd(amountDeposit)
      await busd.approve(router.address, amountDepositBusd);

      await router.depositToBatch(busd.address, amountDepositBusd, "");

      await expect(router.allocateToStrategies()).not.to.be.reverted;

      const [afterAllocateTVL] = await router.getStrategiesValue();
      expect(afterAllocateTVL).to.be.closeTo(
        initialTVL.add(amountDepositUniform),
        amountDepositUniform.mul(50).div(10000) // 0.5% slippage
      );
    });

  });

  describe("Withdraw from strategies", async function () {
    it("should successfuly withdraw from strategies", async function () {
      const [initialTVL] = await router.getStrategiesValue();

      const receipts = await receiptContract.getTokensOfOwner(owner.address);
      console.log( "receipts", receipts);
      const shares = await router.calculateSharesFromReceipts(receipts);
      const sharesValueUsd = await router.calculateSharesUsdValue(shares);

      const expectedWithdrawAmount = applySlippageInBps(
        await convertFromUsdToTokenAmount(
          oracle,
          usdc,
          sharesValueUsd
        ),
        50 // 0.5% slippage
      );

      expect(
        await router.withdrawFromStrategies(
        receipts,
        usdc.address,
        shares,
        expectedWithdrawAmount,
        false
      )).not.to.be.reverted;

      const [afterWithdrawTVL] = await router.getStrategiesValue();
      expect(afterWithdrawTVL).to.be.closeTo(
        initialTVL.sub(sharesValueUsd),
        sharesValueUsd.mul(50).div(10000) // 0.5% slippage
      );
    });
  });

});
