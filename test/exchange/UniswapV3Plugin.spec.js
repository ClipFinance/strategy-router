const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  setupFakeTokens,
  setupFakeToken,
  deployTokensPoolAndProvideLiquidityOnPancakeV3,
} = require("../shared/commonSetup");
const { parseEther, solidityPack } = require("ethers/lib/utils");
const {
  getCreate2DeployerAndProxyBytecode,
  provider,
  create2Deploy,
} = require("../utils");

describe("UniswapV3Plugin", function () {
  let owner, nonOwner, uniswapPlugin, uniswapRouter;

  // mock tokens with different decimals
  let usdc, usdt, busd, weth;
  // helper functions to parse amounts of mock tokens
  let parseUsdc, parseBusd, parseUsdt, parseWeth;
  // mock pools
  let usdcBusdPool, busdUsdtPool, usdcUsdtPool;
  // revert to test-ready state
  let snapshotId;
  // revert to fresh fork state
  let initialSnapshot;

  // test data
  let tokenA, tokenB, mediatorToken;
  let pairAB, pairBA, pairAM, pairMB;

  before(async function () {
    initialSnapshot = await provider.send("evm_snapshot");
    [owner, nonOwner] = await ethers.getSigners();

    // prepare contracts and tokens
    uniswapRouter = await ethers.getContractAt(
      "ISwapRouter",
      hre.networkVariables.uniswapV3Router
    );

    // deploy mock tokens
    ({ usdc, usdt, busd, parseUsdc, parseBusd, parseUsdt } =
      await setupFakeTokens(false));
    weth = await setupFakeToken();

    // setup fake token liquidity
    let amount = (1_000_000).toString();
    usdcBusdPool = await deployTokensPoolAndProvideLiquidityOnPancakeV3(
      usdc,
      busd,
      100,
      amount
    );
    busdUsdtPool = await deployTokensPoolAndProvideLiquidityOnPancakeV3(
      busd,
      usdt,
      100,
      amount
    );
    usdcUsdtPool = await deployTokensPoolAndProvideLiquidityOnPancakeV3(
      usdc,
      usdt,
      100,
      amount
    );

    // set test data
    tokenA = busd.address;
    tokenB = usdt.address;
    pairAB = [tokenA, tokenB];
    pairBA = [tokenB, tokenA];

    mediatorToken = usdc.address;
    pairAM = [tokenA, mediatorToken];
    pairMB = [mediatorToken, tokenB];

    const { create2Deployer } = await getCreate2DeployerAndProxyBytecode();
    // deploy the UniswapPlugin contract
    ({ contract: uniswapPlugin } = await create2Deploy({
      ContractName: "UniswapV3Plugin",
      constructorArgs: [uniswapRouter.address],
      create2Deployer,
    }));
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

  describe("#setSingleHopPairData and #getPairData", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    beforeEach(async () => {
      _snapshot = await provider.send("evm_snapshot");
    });

    afterEach(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert when the pair data is not yet set", async function () {
      await expect(
        uniswapPlugin.getPairData(tokenA, tokenB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should correctly set fee tier for pair", async function () {
      // set fee tier as 0.01%
      await uniswapPlugin.setSingleHopPairData(100, pairAB);

      // get pair data
      const {
        feeTier,
        feePercent,
        mediatorToken: pairMediatorToken,
        pathAB,
        pathBA,
      } = await uniswapPlugin.getPairData(tokenA, tokenB);

      expect(feeTier).to.be.equal(100);
      expect(feePercent).to.be.equal(parseEther("0.0001")); // 0.01% in wei when 100% = 1e18
      expect(pairMediatorToken).to.be.equal(ethers.constants.AddressZero);
      expect(pathAB).to.be.equal(
        solidityPack(["address", "uint24", "address"], [tokenA, 100, tokenB])
      );
      expect(pathBA).to.be.equal(
        solidityPack(["address", "uint24", "address"], [tokenB, 100, tokenA])
      );
    });

    it("should set pair data to initial states and revert when try to get pair data", async function () {
      // set fee tier as 0.01%
      await uniswapPlugin.setSingleHopPairData(100, pairAB);

      // set fee tier as 0 (initial state)
      await uniswapPlugin.setSingleHopPairData(0, pairAB);

      // expect that revert when try to get pair data
      await expect(
        uniswapPlugin.getPairData(tokenA, tokenB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should rewrite pair data to initial states even multi-hop data was added", async function () {
      // set multi-hop pair data for pairAB
      await uniswapPlugin.setSingleHopPairData(100, pairAM);
      await uniswapPlugin.setSingleHopPairData(100, pairMB);
      await uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB);

      // set fee tier as 0 (initial state)
      await uniswapPlugin.setSingleHopPairData(0, pairAB);

      // expect that revert when try to get pair data
      await expect(
        uniswapPlugin.getPairData(tokenA, tokenB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });
  });

  describe("#setMultiHopPairData and #getPairData", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    beforeEach(async () => {
      _snapshot = await provider.send("evm_snapshot");
    });

    afterEach(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });

    it("should revert with identical mediator token", async function () {
      await expect(
        uniswapPlugin.setMultiHopPairData(tokenA, pairAB)
      ).to.be.revertedWithCustomError(
        uniswapPlugin,
        "CanNotSetIdenticalMediatorToken"
      );

      await expect(
        uniswapPlugin.setMultiHopPairData(tokenB, pairAB)
      ).to.be.revertedWithCustomError(
        uniswapPlugin,
        "CanNotSetIdenticalMediatorToken"
      );
    });

    it("should revert when try to set mediator token if pairAM and pairMB are not set", async function () {
      await expect(
        uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should revert when try to set mediator token if pairMB is not set", async function () {
      // set pairAM
      await uniswapPlugin.setSingleHopPairData(100, pairAM);

      await expect(
        uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should revert when try to set mediator token if pairAM is not set", async function () {
      // set pairMB
      await uniswapPlugin.setSingleHopPairData(100, pairMB);

      await expect(
        uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should correctly set mediator token for pairAB", async function () {
      // set single-hop pairAM and pairMB pairs
      await uniswapPlugin.setSingleHopPairData(100, pairAM);
      await uniswapPlugin.setSingleHopPairData(100, pairMB);

      // set mediator token for pairAB
      await uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB);

      // get pair data
      const {
        feeTier,
        feePercent,
        mediatorToken: pairMediatorToken,
        pathAB,
        pathBA,
      } = await uniswapPlugin.getPairData(...pairAB);

      // expected fee percent is 0.19999% = 100% - (100% - 0.1%) * (100% - 0.1%) / 100%
      const expectedFeePercent = parseEther("0.00019999");

      expect(feeTier).to.be.equal(0); // fee tier can be set to 0 with mediator token
      expect(feePercent).to.be.equal(expectedFeePercent);
      expect(pairMediatorToken).to.be.equal(mediatorToken);
      expect(pathAB).to.be.equal(
        solidityPack(
          ["address", "uint24", "address", "uint24", "address"],
          [tokenA, 100, mediatorToken, 100, tokenB]
        )
      );

      expect(pathBA).to.be.equal(
        solidityPack(
          ["address", "uint24", "address", "uint24", "address"],
          [tokenB, 100, mediatorToken, 100, tokenA]
        )
      );
    });

    it("should correctly get data by provided ordered for pairAB and pairBA if set only pairAB", async function () {
      // set single-hop pairAM and pairMB pairs
      await uniswapPlugin.setSingleHopPairData(100, pairAM);
      await uniswapPlugin.setSingleHopPairData(100, pairMB);

      // set pairAB
      await uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB);

      // get pairAB data
      const [feeTierAB, feePercentAB, pairMediatorTokenAB, pathAB1, pathBA1] =
        await uniswapPlugin.getPairData(...pairAB);

      // get pairBA data
      const [feeTierBA, feePercentBA, pairMediatorTokenBA, pathBA2, pathAB2] =
        await uniswapPlugin.getPairData(...pairBA);

      // expect that pairAB and pairBA data are the same
      expect(feeTierAB).to.be.equal(feeTierBA);
      expect(feePercentAB).to.be.equal(feePercentBA);
      expect(pairMediatorTokenAB).to.be.equal(pairMediatorTokenBA);

      // expect that returned the correct pair paths depending on provided order of token pair
      expect(pathAB1).to.be.equal(pathAB2);
      expect(pathBA1).to.be.equal(pathBA2);
    });

    it("should not change pairAB path if set mediator token for pairAB and then change data of pairAM", async function () {
      // set single-hop pairAM and pairMB pairs
      await uniswapPlugin.setSingleHopPairData(100, pairAM);
      await uniswapPlugin.setSingleHopPairData(100, pairMB);

      // set mediator token for pairAB
      await uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB);

      // get pair data before changing pairAM
      const {
        feeTier: feeTierBefore,
        feePercent: feePercentBefore,
        mediatorToken: pairMediatorToken,
        pathAB: pathABBefore,
        pathBA: pathBABefore,
      } = await uniswapPlugin.getPairData(...pairAB);

      // unset pairAM
      await uniswapPlugin.setSingleHopPairData(0, pairAM);

      // get pair data after changing pairAM
      const {
        feeTier: feeTierAfter,
        feePercent: feePercentAfter,
        mediatorToken: pairMediatorTokenAfter,
        pathAB: pathABAfter,
        pathBA: pathBAAfter,
      } = await uniswapPlugin.getPairData(...pairAB);

      // expect that pairAB data is not changed after unset pairAM
      expect(feeTierBefore).to.be.equal(feeTierAfter);
      expect(feePercentBefore).to.be.equal(feePercentAfter);
      expect(pairMediatorToken).to.be.equal(pairMediatorTokenAfter);
      expect(pathABBefore).to.be.equal(pathABAfter);
      expect(pathBABefore).to.be.equal(pathBAAfter);

      // expect revert when try to set mediator token for pairAB after unset pairAM
      await expect(
        uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should revert when pairAM has own mediator token", async function () {
      // set pairAM as multi-hop pair with wETH mediator token
      const pairAW = [tokenA, weth.address];
      const pairWM = [weth.address, mediatorToken];

      await uniswapPlugin.setSingleHopPairData(500, pairAW);
      await uniswapPlugin.setSingleHopPairData(500, pairWM);
      await uniswapPlugin.setMultiHopPairData(weth.address, pairAM);

      // set pairMB
      await uniswapPlugin.setSingleHopPairData(100, pairMB);

      // expect revert when try to set mediator token for pairAB
      await expect(
        uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB)
      ).to.be.revertedWithCustomError(
        uniswapPlugin,
        "MediatorPairHasItsOwnMediatorToken"
      );
    });

    it("should revert when pairMB has own mediator token", async function () {
      // set pairAM
      await uniswapPlugin.setSingleHopPairData(100, pairAM);

      // set pairBM as multi-hop pair with wETH mediator token
      const pairMW = [mediatorToken, weth.address];
      const pairWB = [weth.address, tokenB];

      await uniswapPlugin.setSingleHopPairData(500, pairMW);
      await uniswapPlugin.setSingleHopPairData(500, pairWB);
      await uniswapPlugin.setMultiHopPairData(weth.address, pairMB);

      // expect revert when try to set mediator token for pairAB
      await expect(
        uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB)
      ).to.be.revertedWithCustomError(
        uniswapPlugin,
        "MediatorPairHasItsOwnMediatorToken"
      );
    });

    it("should rewrite pair data to initial states even single-hop data was added", async function () {
      // set single-hop pair data for pairAB
      await uniswapPlugin.setSingleHopPairData(100, pairAB);

      // set mediator token as zero address (initial state) for pairAB
      await uniswapPlugin.setMultiHopPairData(
        ethers.constants.AddressZero,
        pairAB
      );

      // expect that revert when try to get pair data
      await expect(
        uniswapPlugin.getPairData(tokenA, tokenB)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });
  });

  describe("#swap", function () {
    // snapshot to revert state changes that are made in this scope
    let _snapshot;

    beforeEach(async () => {
      _snapshot = await provider.send("evm_snapshot");

      // set fee tier as 0.01% for each tested pair without mediator token
      await uniswapPlugin.setSingleHopPairData(100, [
        usdc.address,
        busd.address,
      ]);
      await uniswapPlugin.setSingleHopPairData(100, [
        busd.address,
        usdt.address,
      ]);
      await uniswapPlugin.setSingleHopPairData(100, [
        usdc.address,
        usdt.address,
      ]);
    });

    afterEach(async () => {
      await provider.send("evm_revert", [_snapshot]);
    });
    it("should return 0 if amountIn is 0", async function () {
      expect(
        await uniswapPlugin.callStatic.swap(
          0,
          usdc.address,
          busd.address,
          nonOwner.address,
          0
        )
      ).to.be.equal(0);
    });

    it("should swap correct received amount closely to predicted amount out without mediator token", async function () {
      const usdcAmoutIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // send tokens to the plugin
      await usdc.transfer(uniswapPlugin.address, usdcAmoutIn);

      const initialBusdBalance = await busd.balanceOf(nonOwner.address);

      // swap tokens
      await uniswapPlugin.swap(
        usdcAmoutIn,
        usdc.address,
        busd.address,
        nonOwner.address,
        0
      );

      const finalBusdBalance = await busd.balanceOf(nonOwner.address);

      // calculate slippage delta as 0.0101% of busdAmountOut where 1_000_000 is 100%
      const slippageDelta = busdAmountOut.mul(101).div(1_000_000);

      // expect that we received closely amount to slipppage delta
      expect(finalBusdBalance.sub(initialBusdBalance)).to.be.closeTo(
        busdAmountOut,
        slippageDelta
      );
    });

    it("should swap correctly with mediator token", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setSingleHopPairData(100, [
        busd.address,
        usdt.address,
      ]);
      await uniswapPlugin.setSingleHopPairData(100, [
        usdc.address,
        usdt.address,
      ]);
      await uniswapPlugin.setMultiHopPairData(usdt.address, [
        busd.address,
        usdc.address,
      ]);

      // send tokens to the plugin
      await usdc.transfer(uniswapPlugin.address, usdcAmountIn);

      const initialBusdBalance = await busd.balanceOf(nonOwner.address);

      // swap tokens
      await uniswapPlugin.swap(
        usdcAmountIn,
        usdc.address,
        busd.address,
        nonOwner.address,
        0
      );

      const finalBusdBalance = await busd.balanceOf(nonOwner.address);

      // calculate double hop slippage delta as 0.0201% of busdAmountOut where 1_000_000 is 100%
      const slippageDelta = busdAmountOut.mul(201).div(1_000_000);

      // expect that we received closely amount to slipppage delta
      expect(finalBusdBalance.sub(initialBusdBalance)).to.be.closeTo(
        busdAmountOut,
        slippageDelta
      );
    });

    it("should not revert when received amount is above minAmountOut", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setSingleHopPairData(100, [
        busd.address,
        usdt.address,
      ]);
      await uniswapPlugin.setSingleHopPairData(100, [
        usdc.address,
        usdt.address,
      ]);
      await uniswapPlugin.setMultiHopPairData(usdt.address, [
        busd.address,
        usdc.address,
      ]);

      // send tokens to the plugin
      await usdc.transfer(uniswapPlugin.address, usdcAmountIn);

      const initialBusdBalance = await busd.balanceOf(nonOwner.address);

      const newMaxSlippage = 10000;
      let minAmountOut = busdAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // swap tokens
      await uniswapPlugin.swap(
        usdcAmountIn,
        usdc.address,
        busd.address,
        nonOwner.address,
        minAmountOut
      );

      const finalBusdBalance = await busd.balanceOf(nonOwner.address);

      // calculate double hop slippage delta as 0.0201% of busdAmountOut where 1_000_000 is 100%
      const slippageDelta = busdAmountOut.mul(201).div(1_000_000);

      // expect that we received closely amount to slipppage delta
      expect(finalBusdBalance.sub(initialBusdBalance)).to.be.closeTo(
        busdAmountOut,
        slippageDelta
      );
    });

    it("should revert when received amount is below minAmountOut", async function () {
      const usdcAmountIn = parseUsdc("10");
      const busdAmountOut = parseBusd("10");

      // Set USDT as mediator token for BUSD-USDC pair
      await uniswapPlugin.setSingleHopPairData(100, [
        busd.address,
        usdt.address,
      ]);
      await uniswapPlugin.setSingleHopPairData(100, [
        usdc.address,
        usdt.address,
      ]);
      await uniswapPlugin.setMultiHopPairData(usdt.address, [
        busd.address,
        usdc.address,
      ]);

      // send tokens to the plugin
      await usdc.transfer(uniswapPlugin.address, usdcAmountIn);

      const newMaxSlippage = 0;
      let minAmountOut = busdAmountOut.mul(10000 - newMaxSlippage).div(10000);
      // swap tokens
      await expect(
        uniswapPlugin.swap(
          usdcAmountIn,
          usdc.address,
          busd.address,
          nonOwner.address,
          minAmountOut
        )
      ).to.be.revertedWith("Too little received");
    });
  });

  // The #getExchangeProtocolFee method uses only for the Biswap strategy and a fee should be calculated with 1e18 precision
  // We should expect that it will revert as a #getPathAndFeeTiersForPair method because it includes this method
  describe("#getExchangeProtocolFee", function () {
    it("should revert when pair fee tier is not set", async function () {
      await expect(
        uniswapPlugin.getExchangeProtocolFee(usdc.address, busd.address)
      ).to.be.revertedWithCustomError(uniswapPlugin, "PairDataNotSet");
    });

    it("should return correct fee when pair fee tier is set", async function () {
      await uniswapPlugin.setSingleHopPairData(100, [
        usdc.address,
        busd.address,
      ]);

      // expected fee in 0.01% is 0.0001 * 1e18
      const expectedProtocolFee = parseEther("0.0001");
      expect(
        await uniswapPlugin.getExchangeProtocolFee(usdc.address, busd.address)
      ).to.be.equal(expectedProtocolFee);
    });

    it("should return correct fee when pair fee tier and mediator token are set", async function () {
      // 10_000 =  1%
      await uniswapPlugin.setSingleHopPairData(10_000, pairAM);
      // 3_000 = 0.3%
      await uniswapPlugin.setSingleHopPairData(3_000, pairMB);

      // set mediator token for pairAB
      await uniswapPlugin.setMultiHopPairData(mediatorToken, pairAB);

      // expected fee is 1.297% = 100% - ((100% - 1%) * (100% - 0.3%) / 100%)
      const expectedFeePercent = parseEther("0.01297"); // 1.297% when 1e18 = 100%

      expect(await uniswapPlugin.getExchangeProtocolFee(...pairAB)).to.be.equal(
        expectedFeePercent
      );
    });
  });

  describe("getRoutePrice", function () {
    // get real addresses of tokens
    const usdcAddress = hre.networkVariables.usdc;
    const usdtAddress = hre.networkVariables.usdt;
    const wbnbAddress = hre.networkVariables.wbnb;

    before(async function () {
      // set fee tier as 0.01% for each tested pair without mediator token
      await uniswapPlugin.setSingleHopPairData(100, [usdcAddress, usdtAddress]);
      await uniswapPlugin.setSingleHopPairData(500, [wbnbAddress, usdtAddress]);

      // Set USDT as mediator token for WETH-USDC pair
      await uniswapPlugin.setMultiHopPairData(usdtAddress, [
        wbnbAddress,
        usdcAddress,
      ]);
    });

    it("should get non-zero price for WETH-USDT and vice versa routes", async function () {
      const priceAB = await uniswapPlugin.getRoutePrice(
        wbnbAddress,
        usdtAddress
      );
      const priceBA = await uniswapPlugin.getRoutePrice(
        usdtAddress,
        wbnbAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);
      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get non-zero price for USDC-USDT and vice versa routes", async function () {
      const priceAB = await uniswapPlugin.getRoutePrice(
        usdcAddress,
        usdtAddress
      );
      const priceBA = await uniswapPlugin.getRoutePrice(
        usdtAddress,
        usdcAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);
      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });

    it("should get price for WETH-USDC and vice versa routes with mediator token", async function () {
      const priceAB = await uniswapPlugin.getRoutePrice(
        wbnbAddress,
        usdcAddress
      );
      const priceBA = await uniswapPlugin.getRoutePrice(
        usdcAddress,
        wbnbAddress
      );

      console.log("priceAB", priceAB);
      console.log("priceBA", priceBA);

      expect(priceAB).to.be.not.equal(0);
      expect(priceBA).to.be.not.equal(0);
    });
  });
});
