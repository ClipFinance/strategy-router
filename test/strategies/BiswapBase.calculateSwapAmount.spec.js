const { expect } = require("chai");
const { ethers } = require("hardhat");
const { utils } = require("ethers");
const {
  setupCore,
  setupFakeTwoTokensByOrder,
  setupTokensLiquidityOnPancake,
  setupTokensLiquidityOnBiswap,
  deployBiswapStrategy,
  getPairTokenOnBiswap,
  addBiswapPoolToRewardProgram,
} = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { provider, create2Deploy } = require("../utils");

describe("Test BiswapBase calculateSwapAmount", function () {
  let owner, nonReceiptOwner;
  // mainnet contracts
  let biswapFarm, biswapPoolId;
  // mock tokens with different decimals
  let tokenA, tokenB, bsw, lpToken;
  // Mock lp token
  let mockLpToken;
  // create2 deploy data
  let create2Deployer, ProxyBytecode;
  // core contracts
  let router, oracle, exchange, batch, receiptContract, sharesToken;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({
      router,
      exchange,
      oracle,
      batch,
      receiptContract,
      sharesToken,
      create2Deployer,
      ProxyBytecode,
    } = await setupCore());

    await router.setAddresses(
      exchange.address,
      oracle.address,
      sharesToken.address,
      batch.address,
      receiptContract.address
    );

    const { token0, token1 } = await setupFakeTwoTokensByOrder(create2Deployer);
    tokenA = token0;
    tokenB = token1;

    const bswInfo = await getTokenContract(hre.networkVariables.bsw);
    bsw = bswInfo.token;

    await mintForkedToken(
      bsw.address,
      owner.address,
      utils.parseEther("10000000000")
    );

    ({ contract: mockLpToken } = await create2Deploy({
      ContractName: "MockLPToken",
      constructorArgs: [tokenA.address, tokenB.address],
      create2Deployer,
    }));

    biswapFarm = await getContract(
      "IBiswapFarm",
      hre.networkVariables.biswapFarm
    );

    await setupTokensLiquidityOnPancake(tokenA, bsw, 1_000_000, 5_000_000);
    await setupTokensLiquidityOnPancake(tokenB, bsw, 1_000_000, 5_000_000);
    await setupTokensLiquidityOnPancake(tokenA, tokenB, 1_000_000, 1_000_000);

    const { contract: pancakePlugin } = await create2Deploy({
      ContractName: "UniswapPlugin",
      constructorArgs: [hre.networkVariables.uniswapRouter],
      create2Deployer,
    });
    const pancake = pancakePlugin.address;
    await exchange.setRoute(
      [tokenA.address, tokenB.address, tokenA.address],
      [bsw.address, bsw.address, tokenB.address],
      [pancake, pancake, pancake, pancake, pancake, pancake]
    );

    await setupTokensLiquidityOnBiswap(tokenA, tokenB, 1_000_000, 1_000_000);

    lpToken = await getPairTokenOnBiswap(tokenA, tokenB);
    biswapPoolId = await addBiswapPoolToRewardProgram(lpToken.address);

    const tokenAPrice = tokenA.parse("1");
    const tokenBPrice = tokenB.parse("1");
    await oracle.setPrice(tokenA.address, tokenAPrice);
    await oracle.setPrice(tokenB.address, tokenBPrice);
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

  describe("#calculateSwapAmount", function () {
    let tokenAmount;
    let mockBiswapStrategyAB;
    let mockBiswapStrategyBA;
    const DEX_FEE = utils.parseEther("0.003");

    beforeEach(async () => {
      tokenAmount = tokenA.parse("2000");

      mockBiswapStrategyAB = await deployBiswapStrategy({
        router: router.address,
        poolId: biswapPoolId,
        tokenA,
        tokenB,
        lpToken: mockLpToken.address,
        oracle: oracle.address,
        priceManipulationPercentThresholdInBps: 2000,
        upgrader: owner.address,
        depositors: [owner.address],
        create2Deployer,
        ProxyBytecode,
        saltAddition: "StrategyAB",
      });

      mockBiswapStrategyBA = await deployBiswapStrategy({
        router: router.address,
        poolId: biswapPoolId,
        tokenA: tokenB,
        tokenB: tokenA,
        lpToken: mockLpToken.address,
        oracle: oracle.address,
        priceManipulationPercentThresholdInBps: 2000,
        upgrader: owner.address,
        depositors: [owner.address],
        create2Deployer,
        ProxyBytecode,
        saltAddition: "StrategyBA",
      });
    });

    it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 1, OraclePriceYinX: 1, TotalAmountInX: 2000)", async function () {
      await mockLpToken.setReserves(
        utils.parseEther("1000000"),
        utils.parseEther("1000000")
      );
      await oracle.setPriceAndDecimals(
        tokenA.address,
        utils.parseUnits("1", 8),
        8
      );
      await oracle.setPriceAndDecimals(
        tokenB.address,
        utils.parseUnits("1", 8),
        8
      );

      const { amountA: amountX } =
        await mockBiswapStrategyAB.calculateSwapAmountPublic(
          tokenAmount,
          DEX_FEE
        );

      expect(amountX).to.be.equal("998497746619929894843");
    });

    describe("AMM and Oracle price match", function () {
      it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 1, OraclePriceYinX: 1, TotalAmountInY: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1", 8),
          8
        );

        const { amountA: amountY } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountY).to.be.equal("998497746619929894843");
      });

      it("test scenario(X: 1200000, Y: 1000000, OraclePriceXinY: 1.2, OraclePriceYinX: 0.83, TotalAmountInX: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1200000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1.2", 8),
          8
        );

        const { amountA: amountX } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("998497746619929894643");
      });

      it("test scenario(X: 1200000, Y: 1000000, OraclePriceXinY: 1.2, OraclePriceYinX: 0.83, TotalAmountInY: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1200000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1.2", 8),
          8
        );

        const { amountA: amountY } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountY).to.be.equal("998497746619929894843");
      });

      it("test scenario(X: 1000000, Y: 1200000, OraclePriceXinY: 0.83, OraclePriceYinX: 1.2, TotalAmountInX: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1200000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1.2", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1", 8),
          8
        );

        const { amountA: amountX } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("998497746619929894843");
      });

      it("test scenario(X: 1000000, Y: 1200000, OraclePriceXinY: 0.83, OraclePriceYinX: 1.2, TotalAmountInY: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1200000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1.2", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1", 8),
          8
        );

        const { amountA: amountY } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountY).to.be.equal("998497746619929894643");
      });
    });

    describe("AMM and Oracle price differ", function () {
      it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 1.1, OraclePriceYinX: 0.9, TotalAmountInX: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1.1", 8),
          8
        );

        const { amountA: amountX } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("950882212684787791586");
      });

      it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 1.1, OraclePriceYinX: 0.9, TotalAmountInY: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1.1", 8),
          8
        );

        const { amountA: amountY } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountY).to.be.equal("1046120093480230838938");
      });

      it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 0.9, OraclePriceYinX: 1.1, TotalAmountInX: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("0.9", 8),
          8
        );

        const { amountA: amountX } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("1051133368476541908227");
      });

      it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 0.9, OraclePriceYinX: 1.1, TotalAmountInY: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("0.9", 8),
          8
        );

        const { amountA: amountY } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountY).to.be.equal("945870447477995045592");
      });
    });

    describe("Test with 0% DEX FEE", function () {
      const DEX_FEE = 0;

      it("test scenario(X: 1000000, Y: 1000000, OraclePriceXinY: 1, OraclePriceYinX: 1, TotalAmountInY: 2000)", async function () {
        await mockLpToken.setReserves(
          utils.parseEther("1000000"),
          utils.parseEther("1000000")
        );
        await oracle.setPriceAndDecimals(
          tokenA.address,
          utils.parseUnits("1", 8),
          8
        );
        await oracle.setPriceAndDecimals(
          tokenB.address,
          utils.parseUnits("1", 8),
          8
        );

        const { amountA: amountY } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountY).to.be.equal("1000000000000000000000");
      });
    });
  });
});
