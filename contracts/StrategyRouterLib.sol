//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import {ReceiptNFT} from "./ReceiptNFT.sol";
import {Exchange} from "./exchange/Exchange.sol";
import {SharesToken} from "./SharesToken.sol";
import "./Batch.sol";
import "./StrategyRouter.sol";

// import "hardhat/console.sol";

library StrategyRouterLib {
    error CycleNotClosed();

    uint8 private constant UNIFORM_DECIMALS = 18;
    uint256 private constant PRECISION = 1e18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 private constant REBALANCE_SWAP_THRESHOLD = 1e17;

    struct StrategyData {
        address strategyAddress;
        address tokenAddress;
        uint256 tokenIndexInSupportedTokens;
        uint256 weight;
        bool saturated;
        uint256 toDeposit;
    }

    struct SupportedTokenData {
        address tokenAddress;
        uint256 balance;
    }

    function getStrategiesValue(IUsdOracle oracle, StrategyRouter.StrategyInfo[] storage strategies)
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        balances = new uint256[](strategies.length);
        for (uint256 i; i < balances.length; i++) {
            address token = strategies[i].depositToken;

            uint256 balanceInDepositToken = IStrategy(strategies[i].strategyAddress).totalTokens();

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(token);
            balanceInDepositToken = ((balanceInDepositToken * price) / 10**priceDecimals);
            balanceInDepositToken = toUniform(balanceInDepositToken, token);
            balances[i] = balanceInDepositToken;
            totalBalance += balanceInDepositToken;
        }
    }

    // returns amount of shares locked by receipt.
    function calculateSharesFromReceipt(
        uint256 receiptId,
        uint256 currentCycleId,
        ReceiptNFT receiptContract,
        mapping(uint256 => StrategyRouter.Cycle) storage cycles
    ) public view returns (uint256 shares) {
        ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(receiptId);
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        uint256 depositCycleTokenPriceUsd = cycles[receipt.cycleId].prices[receipt.token];

        uint256 depositedUsdValueOfReceipt = (receipt.tokenAmountUniform * depositCycleTokenPriceUsd) / PRECISION;
        assert(depositedUsdValueOfReceipt > 0);
        // adjust according to what was actually deposited into strategies
        // example: ($1000 * $4995) / $5000 = $999
        uint256 allocatedUsdValueOfReceipt = (depositedUsdValueOfReceipt *
            cycles[receipt.cycleId].receivedByStrategiesInUsd) / cycles[receipt.cycleId].totalDepositedInUsd;
        return (allocatedUsdValueOfReceipt * PRECISION) / cycles[receipt.cycleId].pricePerShare;
    }

    /// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
    function changeDecimals(
        uint256 amount,
        uint8 oldDecimals,
        uint8 newDecimals
    ) internal pure returns (uint256) {
        if (oldDecimals < newDecimals) {
            return amount * (10**(newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10**(oldDecimals - newDecimals));
        }
        return amount;
    }

    /// @dev Swap tokens if they are different (i.e. not the same token)
    function trySwap(
        Exchange exchange,
        uint256 amount,
        address from,
        address to
    ) internal returns (uint256 result) {
        if (from != to) {
            IERC20(from).transfer(address(exchange), amount);
            result = exchange.swap(amount, from, to, address(this));
            return result;
        }
        return amount;
    }

    /// @dev Change decimal places to `UNIFORM_DECIMALS`.
    function toUniform(uint256 amount, address token) internal view returns (uint256) {
        return changeDecimals(amount, ERC20(token).decimals(), UNIFORM_DECIMALS);
    }

    /// @dev Convert decimal places from `UNIFORM_DECIMALS` to token decimals.
    function fromUniform(uint256 amount, address token) internal view returns (uint256) {
        return changeDecimals(amount, UNIFORM_DECIMALS, ERC20(token).decimals());
    }

    /// @notice receiptIds should be passed here already ordered by their owners in order not to do extra transfers
    /// @notice Example: [alice, bob, alice, bob] will do 4 transfers. [alice, alice, bob, bob] will do 2 transfers
    function redeemReceiptsToSharesByModerators(
        uint256[] calldata receiptIds,
        uint256 _currentCycleId,
        ReceiptNFT _receiptContract,
        SharesToken _sharesToken,
        mapping(uint256 => StrategyRouter.Cycle) storage cycles
    ) public {
        if (receiptIds.length == 0) revert();
        uint256 sameOwnerShares;
        // address sameOwnerAddress;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            uint256 shares = calculateSharesFromReceipt(receiptId, _currentCycleId, _receiptContract, cycles);
            address receiptOwner = _receiptContract.ownerOf(receiptId);
            if (i + 1 < receiptIds.length) {
                uint256 nextReceiptId = receiptIds[i + 1];
                address nextReceiptOwner = _receiptContract.ownerOf(nextReceiptId);
                if (nextReceiptOwner == receiptOwner) {
                    sameOwnerShares += shares;
                    // sameOwnerAddress = nextReceiptOwner;
                } else {
                    // this is the last receipt in a row of the same owner
                    sameOwnerShares += shares;
                    _sharesToken.transfer(receiptOwner, sameOwnerShares);
                    sameOwnerShares = 0;
                    // sameOwnerAddress = address(0);
                }
            } else {
                // this is the last receipt in the list, if previous owner is different then
                // sameOwnerShares is 0, otherwise it contain amount unlocked for that owner
                sameOwnerShares += shares;
                _sharesToken.transfer(receiptOwner, sameOwnerShares);
            }
            _receiptContract.burn(receiptId);
        }
    }

    /// burn receipts and return amount of shares noted in them.
    function burnReceipts(
        uint256[] calldata receiptIds,
        uint256 _currentCycleId,
        ReceiptNFT _receiptContract,
        mapping(uint256 => StrategyRouter.Cycle) storage cycles
    ) public returns (uint256 shares) {
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (_receiptContract.ownerOf(receiptId) != msg.sender) revert StrategyRouter.NotReceiptOwner();
            shares += calculateSharesFromReceipt(receiptId, _currentCycleId, _receiptContract, cycles);
            _receiptContract.burn(receiptId);
        }
    }

    function rebalanceStrategies(
        Exchange exchange,
        StrategyRouter.StrategyInfo[] storage strategies,
        uint256 totalStrategyWeight,
        address[] memory supportedTokens
    )
        public
        returns (uint256[] memory balances)
    {
        if (strategies.length < 2) revert StrategyRouter.NothingToRebalance();

        uint256 totalUnallocatedBalanceUniform;
        StrategyData[] memory strategyDatas = new StrategyData[](strategies.length);

        uint256[] memory underflowedStrategyWeights = new uint256[](strategies.length);
        uint256[] memory currentTokenBalances = new uint256[](supportedTokens.length);
        uint256 totalUnderflowStrategyWeight;
        balances = new uint256[](strategies.length);
        {
            uint256 totalBalanceUniform;

            for (uint256 i; i < strategies.length; i++) {
                balances[i] = IStrategy(strategies[i].strategyAddress).totalTokens();
                strategyDatas[i] = StrategyData({
                    strategyAddress: strategies[i].strategyAddress,
                    tokenAddress: strategies[i].depositToken,
                    tokenIndexInSupportedTokens: 0,
                    weight: strategies[i].weight,
                    saturated: false,
                    toDeposit: 0
                });
                totalBalanceUniform += toUniform(balances[i], strategyDatas[i].tokenAddress);
            }

            for (uint256 i; i < supportedTokens.length; i++) {
                uint256 currentTokenBalance = IERC20(supportedTokens[i]).balanceOf(address(this));
                currentTokenBalances[i] = currentTokenBalance;
                uint256 tokenBalanceUniform = toUniform(
                    currentTokenBalance,
                    supportedTokens[i]
                );
                totalBalanceUniform += tokenBalanceUniform;
                totalUnallocatedBalanceUniform += tokenBalanceUniform;
            }

            //        bool[] memory excludedStrategies = new bool[](strategies.length);
            for (uint256 i; i < strategies.length; i++) {
                uint256 desiredBalance = (totalBalanceUniform * strategyDatas[i].weight) / totalStrategyWeight;
                desiredBalance = fromUniform(desiredBalance, strategyDatas[i].tokenAddress);
//                console.log('====Initial setup===');
//                console.log('desiredBalance', i, desiredBalance);
//                console.log('strategyDatas[i].balance', i, strategyDatas[i].balance);
                for (uint256 j; j < supportedTokens.length; j++) {
                    if (strategyDatas[i].tokenAddress == supportedTokens[j]) {
                        strategyDatas[i].tokenIndexInSupportedTokens = j;
                        break;
                    }
                }
                if (desiredBalance < balances[i]) {
                    strategyDatas[i].saturated = true;
                    uint256 balanceToWithdraw = balances[i] - desiredBalance;
//                    console.log('balanceToWithdraw', i, balanceToWithdraw);
//                    console.log('toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress)', i, toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress));
                    if (toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress) >= REBALANCE_SWAP_THRESHOLD) {
                        // test underflow on withdrawal case
                        // mark test skipped for current impl
                        // when idle will be deployed such remnant will disappear
                        uint256 withdrawnBalance = IStrategy(strategyDatas[i].strategyAddress)
                            .withdraw(balanceToWithdraw);
                        balances[i] -= withdrawnBalance;
                        currentTokenBalances[strategyDatas[i].tokenIndexInSupportedTokens] += withdrawnBalance;
//                        console.log('balances[i]', i, balances[i]);
//                        console.log('withdrawnBalance', i, withdrawnBalance);
                        totalUnallocatedBalanceUniform += toUniform(
                            withdrawnBalance,
                            strategyDatas[i].tokenAddress
                        );
                    }
                } else {
                    uint256 balanceToAddUniform = toUniform(
                        desiredBalance - balances[i],
                        strategyDatas[i].tokenAddress
                    );
                    if (balanceToAddUniform >= REBALANCE_SWAP_THRESHOLD) {
                        totalUnderflowStrategyWeight += balanceToAddUniform;
                        underflowedStrategyWeights[i] = balanceToAddUniform;
//                        console.log('underflowedStrategyWeights[i]', i, underflowedStrategyWeights[i]);
//                        console.log('totalUnderflowStrategyWeight', i, totalUnderflowStrategyWeight);
                    } else {
                        strategyDatas[i].saturated = true;
                    }
                }
//                console.log('=======');
            }
        }

//        uint256[] memory supportedTokensIndexes = new uint256[](strategies.length);
        for (uint256 i; i < strategies.length; i++) {
            if (strategyDatas[i].saturated) {
                continue;
            }

            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / totalUnderflowStrategyWeight;
//            console.log('=====Native rebalance=====');
//            console.log('desiredAllocationUniform', i, desiredAllocationUniform);

            if (desiredAllocationUniform < REBALANCE_SWAP_THRESHOLD) {
                strategyDatas[i].saturated = true;
                totalUnderflowStrategyWeight -= underflowedStrategyWeights[i];
                underflowedStrategyWeights[i] = 0;
                continue;
            }

            address strategyTokenAddress = strategyDatas[i].tokenAddress;
            uint256 currentTokenBalance = currentTokenBalances[strategyDatas[i].tokenIndexInSupportedTokens];
            uint256 currentTokenBalanceUniform = toUniform(
                currentTokenBalance,
                strategyTokenAddress
            );

//            console.log('currentTokenBalance', i, currentTokenBalance);
//            console.log('currentTokenBalanceUniform', i, currentTokenBalanceUniform);

            if (currentTokenBalanceUniform < REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                strategyDatas[i].saturated = true;
                if (currentTokenBalanceUniform < desiredAllocationUniform + REBALANCE_SWAP_THRESHOLD) {
                    IERC20(strategyTokenAddress)
                        .transfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                    strategyDatas[i].toDeposit += currentTokenBalance;
                    balances[i] += currentTokenBalance;
                    currentTokenBalances[strategyDatas[i].tokenIndexInSupportedTokens] -= currentTokenBalance;
                    totalUnderflowStrategyWeight -= underflowedStrategyWeights[i];
                    underflowedStrategyWeights[i] = 0;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;
//                    console.log('currentTokenBalance', currentTokenBalance);
//                    console.log('balances[i]', i, balances[i]);
//                    console.log('underflowedStrategyWeights[i]', i, underflowedStrategyWeights[i]);
//                    console.log('totalUnallocatedBalanceUniform', totalUnallocatedBalanceUniform);
                } else {
                    desiredAllocationUniform = fromUniform(desiredAllocationUniform, strategyTokenAddress);
                    IERC20(strategyTokenAddress).transfer(
                        strategyDatas[i].strategyAddress,
                        desiredAllocationUniform
                    );
                    strategyDatas[i].toDeposit += desiredAllocationUniform;
                    balances[i] += desiredAllocationUniform;
                    currentTokenBalances[strategyDatas[i].tokenIndexInSupportedTokens] -= desiredAllocationUniform;
                    totalUnderflowStrategyWeight -= underflowedStrategyWeights[i];
                    underflowedStrategyWeights[i] = 0;
                    totalUnallocatedBalanceUniform -= toUniform(
                        desiredAllocationUniform,
                        strategyTokenAddress
                    );
                }
            } else {
                uint256 saturatedWeightPoints = underflowedStrategyWeights[i] * currentTokenBalanceUniform
                    / desiredAllocationUniform;
                underflowedStrategyWeights[i] -= saturatedWeightPoints;
                totalUnderflowStrategyWeight -= saturatedWeightPoints;
                totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                IERC20(strategyTokenAddress).transfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                strategyDatas[i].toDeposit += currentTokenBalance;
                balances[i] += currentTokenBalance;
                currentTokenBalances[strategyDatas[i].tokenIndexInSupportedTokens] -= currentTokenBalance;
            }
        }

        for (uint256 i; i < strategies.length; i++) {
            if (strategyDatas[i].saturated) {
                if (strategyDatas[i].toDeposit > 0) {
                    IStrategy(strategyDatas[i].strategyAddress).deposit(strategyDatas[i].toDeposit);
                }
                continue;
            }
//            console.log('never here');

            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / totalUnderflowStrategyWeight;
            totalUnderflowStrategyWeight -= underflowedStrategyWeights[i];
            underflowedStrategyWeights[i] = 0;

            if (desiredAllocationUniform < REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            for (uint256 j; j < supportedTokens.length; j++) {
                if (strategyDatas[i].tokenIndexInSupportedTokens == j) {
                    IStrategy(strategyDatas[i].strategyAddress).deposit(strategyDatas[i].toDeposit);
                    continue;
                }

//                uint256 currentTokenBalance = IERC20(supportedTokens[j]).balanceOf(address(this));
                uint256 currentTokenBalanceUniform = toUniform(
                    currentTokenBalances[j],
                    supportedTokens[j]
                );
                if (currentTokenBalanceUniform < REBALANCE_SWAP_THRESHOLD) {
                    continue;
                }

                if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                    if (currentTokenBalanceUniform < desiredAllocationUniform + REBALANCE_SWAP_THRESHOLD) {
                        desiredAllocationUniform = 0;
                        totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                        IERC20(supportedTokens[j]).transfer(
                            address(exchange),
                            currentTokenBalances[j]
                        );
                        uint256 received = exchange.swap(
                            currentTokenBalances[j],
                            supportedTokens[j],
                            strategyDatas[i].tokenAddress,
                            strategyDatas[i].strategyAddress
                        );
                        // TODO Move to a single deposit call per strategy
                        strategyDatas[i].toDeposit = received;
//                        IStrategy(strategyDatas[i].strategyAddress).deposit(received);

                        balances[i] += received;
                        currentTokenBalances[j] = 0;
                    } else {
                        desiredAllocationUniform = fromUniform(desiredAllocationUniform, supportedTokens[j]);
                        totalUnallocatedBalanceUniform -= toUniform(desiredAllocationUniform, supportedTokens[j]);

                        IERC20(supportedTokens[j]).transfer(
                            address(exchange),
                            desiredAllocationUniform
                        );
                        uint256 received = exchange.swap(
                            desiredAllocationUniform,
                            supportedTokens[j],
                            strategyDatas[i].tokenAddress,
                            strategyDatas[i].strategyAddress
                        );
                        strategyDatas[i].toDeposit = received;
                        // TODO Move to a single deposit call per strategy
//                        IStrategy(strategyDatas[i].strategyAddress).deposit(received);

                        balances[i] += received;
                        currentTokenBalances[j] -= desiredAllocationUniform;
                        desiredAllocationUniform = 0;
                    }
                } else {
                    desiredAllocationUniform -= currentTokenBalanceUniform;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                    IERC20(supportedTokens[j]).transfer(
                        address(exchange),
                        currentTokenBalances[j]
                    );
                    uint256 received = exchange.swap(
                        currentTokenBalances[j],
                        supportedTokens[j],
                        strategyDatas[i].tokenAddress,
                        strategyDatas[i].strategyAddress
                    );
                    strategyDatas[i].toDeposit = received;
                    // TODO Move to a single deposit call per strategy
//                    IStrategy(strategyDatas[i].strategyAddress).deposit(received);

                    balances[i] += received;
                    currentTokenBalances[j] = 0;
                }
//                IERC20(supportedTokens[j]).transfer(strategyDatas[i].strategyAddress, received);
                if (desiredAllocationUniform < REBALANCE_SWAP_THRESHOLD) {
                    break;
                }
            }

            IStrategy(strategyDatas[i].strategyAddress).deposit(strategyDatas[i].toDeposit);
        }

//        console.log('=====FINAL BALANCES=====');
//        for (uint i; i < balances.length; i++) {
//            console.log(
//                'IERC20(strategyDatas[i].tokenAddress).balanceOf(strategyDatas[i].strategyAddress)',
//                i,
//                IERC20(strategyDatas[i].tokenAddress).balanceOf(strategyDatas[i].strategyAddress)
//            );
//            console.log('balances[i]', i, balances[i]);
//        }
    }
}
