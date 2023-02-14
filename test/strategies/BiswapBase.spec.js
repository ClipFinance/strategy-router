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
  addBiswapPool,
} = require("../shared/commonSetup");
const {
  getTokenContract,
  mintForkedToken,
  getContract,
} = require("../shared/forkHelper");
const { provider, deploy } = require("../utils");

describe("Test BiswapBase", function () {
  let owner, nonReceiptOwner;
  // mainnet contracts
  let biswapFarm, biswapPoolId;
  // mock tokens with different decimals
  let tokenA, tokenB, bsw, lpToken;
  // Mock lp token
  let mockLpToken;
  // core contracts
  let router, oracle, mockExchange, batch, receiptContract, sharesToken;
  // biswap strategy
  let biswapStrategy;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  before(async function () {
    [owner, nonReceiptOwner] = await ethers.getSigners();
    initialSnapshot = await provider.send("evm_snapshot");

    // deploy core contracts
    ({ router, oracle, batch, receiptContract, sharesToken } =
      await setupCore());

    mockExchange = await deploy("MockExchange");

    await router.setAddresses(
      mockExchange.address,
      oracle.address,
      sharesToken.address,
      batch.address,
      receiptContract.address
    );

    const { token0, token1 } = await setupFakeTwoTokensByOrder();
    tokenA = token0;
    tokenB = token1;

    const bswInfo = await getTokenContract(hre.networkVariables.bsw);
    bsw = bswInfo.token;

    await mintForkedToken(
      bsw.address,
      owner.address,
      utils.parseEther("10000000000")
    );

    mockLpToken = await deploy("MockLPToken", tokenA.address, tokenB.address);

    biswapFarm = await getContract(
      "IBiswapFarm",
      hre.networkVariables.biswapFarm
    );

    await setupTokensLiquidityOnPancake(tokenA, bsw, 1_000_000, 5_000_000);
    await setupTokensLiquidityOnPancake(tokenB, bsw, 1_000_000, 5_000_000);
    await setupTokensLiquidityOnBiswap(tokenA, tokenB, 1_000_000, 1_000_000);
    await tokenA.transfer(mockExchange.address, utils.parseEther("10000"));
    await tokenB.transfer(mockExchange.address, utils.parseEther("10000"));

    lpToken = await getPairTokenOnBiswap(tokenA, tokenB);
    biswapPoolId = await addBiswapPool(lpToken.address);

    biswapStrategy = await deployBiswapStrategy({
      router: router.address,
      poolId: biswapPoolId,
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      lpToken: lpToken.address,
      oracle: oracle.address,
      upgrader: owner.address,
    });

    const tokenAPrice = utils.parseUnits("1", 8);
    const tokenBPrice = utils.parseUnits("1", 8);
    await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 8);
    await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 8);
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

  describe("constructor & initialize", function () {
    it("check initial values", async function () {
      expect(await biswapStrategy.tokenA()).to.be.eq(tokenA.address);
      expect(await biswapStrategy.tokenB()).to.be.eq(tokenB.address);
      expect(await biswapStrategy.lpToken()).to.be.eq(lpToken.address);
      expect(await biswapStrategy.strategyRouter()).to.be.eq(router.address);
      expect(await biswapStrategy.oracle()).to.be.eq(oracle.address);
      expect(await biswapStrategy.poolId()).to.be.eq(biswapPoolId);
      expect(await biswapStrategy.depositToken()).to.be.eq(tokenA.address);
    });
  });

  describe("#getOraclePrice", function () {
    it("get oracle price with same decimals", async function () {
      const tokenAPrice = utils.parseUnits("2", 8);
      const tokenBPrice = utils.parseUnits("1", 8);
      await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 8);
      await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 8);

      expect(
        await biswapStrategy.getOraclePrice(tokenA.address, tokenB.address)
      ).to.be.eq(utils.parseEther("0.5"));
    });

    it("get oracle price with different same decimals(A decimals < B decimals)", async function () {
      const tokenAPrice = utils.parseUnits("2", 8);
      const tokenBPrice = utils.parseUnits("1", 10);
      await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 8);
      await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 10);

      expect(
        await biswapStrategy.getOraclePrice(tokenA.address, tokenB.address)
      ).to.be.eq(utils.parseEther("0.5"));
    });

    it("get oracle price with different same decimals(A decimals > B decimals)", async function () {
      const tokenAPrice = utils.parseUnits("2", 18);
      const tokenBPrice = utils.parseUnits("1", 10);
      await oracle.setPriceAndDecimals(tokenA.address, tokenAPrice, 18);
      await oracle.setPriceAndDecimals(tokenB.address, tokenBPrice, 10);

      expect(
        await biswapStrategy.getOraclePrice(tokenA.address, tokenB.address)
      ).to.be.eq(utils.parseEther("0.5"));
    });
  });

  describe("#deposit", function () {
    let tokenAInitialBalance;

    beforeEach(async () => {
      tokenAInitialBalance = utils.parseEther("1000000");

      await tokenA.transfer(biswapStrategy.address, tokenAInitialBalance);
    });

    it("it reverts if msg.sender is not owner", async function () {
      await expect(
        biswapStrategy.connect(nonReceiptOwner).deposit(10)
      ).to.revertedWithCustomError(
        biswapStrategy,
        "Ownable__CallerIsNotTheOwner"
      );
    });

    it("deposit", async function () {
      const amount = utils.parseEther("100");
      await mockExchange.setAmountReceived(amount.div(2));
      await biswapStrategy.deposit(amount);

      const farmInfo = await biswapFarm.userInfo(
        biswapPoolId,
        biswapStrategy.address
      );
      expect(farmInfo.amount).not.eq("0");
      expect(await tokenA.balanceOf(biswapStrategy.address))
        .lt(tokenAInitialBalance)
        .gte(tokenAInitialBalance.sub(amount));
    });
  });

  describe("#calculateSwapAmount", function () {
    let tokenAmount;
    let mockBiswapStrategyAB;
    let mockBiswapStrategyBA;
    const DEX_FEE = utils.parseEther("0.003");

    beforeEach(async () => {
      tokenAmount = utils.parseEther("2000");

      mockBiswapStrategyAB = await deployBiswapStrategy({
        router: router.address,
        poolId: biswapPoolId,
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        lpToken: mockLpToken.address,
        oracle: oracle.address,
        upgrader: owner.address,
      });

      mockBiswapStrategyBA = await deployBiswapStrategy({
        router: router.address,
        poolId: biswapPoolId,
        tokenA: tokenB.address,
        tokenB: tokenA.address,
        lpToken: mockLpToken.address,
        oracle: oracle.address,
        upgrader: owner.address,
      });
    });

    it("it reverts if oracle price too bigger than biswap price(oracle: $2, ammPrice: $1)", async function () {
      await mockLpToken.setReserves(
        utils.parseEther("10000"),
        utils.parseEther("10000")
      );
      await oracle.setPriceAndDecimals(
        tokenA.address,
        utils.parseUnits("2", 8),
        8
      );
      await oracle.setPriceAndDecimals(
        tokenB.address,
        utils.parseUnits("1", 8),
        8
      );

      await expect(
        mockBiswapStrategyAB.calculateSwapAmountPublic(tokenAmount, DEX_FEE)
      ).to.revertedWithCustomError(mockBiswapStrategyAB, "PriceManipulation");
    });

    it("it reverts if oracle price too lower than biswap price(oracle: $1, ammPrice: $2)", async function () {
      await mockLpToken.setReserves(
        utils.parseEther("10000"),
        utils.parseEther("20000")
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

      await expect(
        mockBiswapStrategyAB.calculateSwapAmountPublic(tokenAmount, DEX_FEE)
      ).to.revertedWithCustomError(mockBiswapStrategyAB, "PriceManipulation");
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

      const { amountA: amountX, amountB: amountY } =
        await mockBiswapStrategyAB.calculateSwapAmountPublic(
          tokenAmount,
          DEX_FEE
        );

      expect(amountX).to.be.equal("998497746619929894843");
      expect(amountY).to.be.equal("998497746619929894841");
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

        const { amountA: amountY, amountB: amountX } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("998497746619929894841");
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

        const { amountA: amountX, amountB: amountY } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("998497746619929894643");
        expect(amountY).to.be.equal("832081455516608245534");
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

        const { amountA: amountY, amountB: amountX } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("1198197295943915873809");
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

        const { amountA: amountX, amountB: amountY } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("998497746619929894843");
        expect(amountY).to.be.equal("1198197295943915873809");
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

        const { amountA: amountY, amountB: amountX } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("832081455516608245534");
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

        const { amountA: amountX, amountB: amountY } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("950882212684787791586");
        expect(amountY).to.be.equal("950882212684787791584");
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

        const { amountA: amountY, amountB: amountX } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("1046120093480230838936");
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

        const { amountA: amountX, amountB: amountY } =
          await mockBiswapStrategyAB.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("1051133368476541908227");
        expect(amountY).to.be.equal("1051133368476541908225");
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

        const { amountA: amountY, amountB: amountX } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("945870447477995045590");
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

        const { amountA: amountY, amountB: amountX } =
          await mockBiswapStrategyBA.calculateSwapAmountPublic(
            tokenAmount,
            DEX_FEE
          );

        expect(amountX).to.be.equal("1000000000000000000000");
        expect(amountY).to.be.equal("1000000000000000000000");
      });
    });
  });
});
