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

 import "hardhat/console.sol";

library StrategyRouterLib {
    error CycleNotClosed();

    uint8 private constant UNIFORM_DECIMALS = 18;
    uint256 private constant PRECISION = 1e18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 private constant REBALANCE_SWAP_THRESHOLD = 1e17;

    struct StrategyData {
        address strategyAddress;
        address tokenAddress;
        uint256 balance;
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

        uint256 totalBalanceUniform;
        uint256 totalUnallocatedBalanceUniform;
        balances = new uint256(strategies.length);

        StrategyData[] strategyDatas = new StrategyData[](strategies.length);
        for (uint256 i; i < strategies.length; i++) {
            //        for (uint256 i; i < len; i++) {
            strategyDatas[i] = StrategyData({
                strategyAddress: strategies[i].strategyAddress,
                tokenAddress: strategies[i].depositToken,
                weight: strategies[i].weight,
                balance: IStrategy(strategies[i].strategyAddress).totalTokens()
            });
            balances[i] = strategyDatas[i].balance;
            totalBalanceUniform += toUniform(strategyDatas[i].balance, strategyDatas[i].tokenAddress);
        }

        for (uint256 i; i < supportedTokens.length; i++) {
            uint256 tokenBalanceUniform = toUniform(
                IERC20(supportedTokens[i]).balanceOf(address(this)),
                supportedTokens[i]
            );
            totalBalanceUniform += tokenBalanceUniform;
            totalUnallocatedBalanceUniform += tokenBalanceUniform;
        }

        bool[] excludedStrategies = new bool[](strategies.length);
        uint256[] underflowedStrategyWeights = new uint256[](strategies.length);
        uint256 totalUnderflowStrategyWeights;
        for (uint256 i; i < strategies.length; i++) {
            uint256 desiredBalance = (totalBalanceUniform * strategyDatas[i].weight) / totalStrategyWeight;
            desiredBalance = fromUniform(desiredBalance, strategyDatas[i].tokenAddress);
            if (desiredBalance < strategyDatas[i].balance) {
                excludedStrategies[i] = true;
                uint256 balanceToWithdraw = strategyDatas[i].balance - desiredBalance;
                if (toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress) >= REBALANCE_SWAP_THRESHOLD) {
                    // test underflow on withdrawal case
                    // mark test skipped for current impl
                    // when idle will be deployed such remnant will disappear
                    uint256 withdrawnBalance = IStrategy(strategyDatas[i].strategyAddress)
                        .withdraw(balanceToWithdraw);
                    balances[i] -= withdrawnBalance;
                    totalUnallocatedBalanceUniform += toUniform(
                        withdrawnBalance,
                        strategyDatas[i].tokenAddress
                    );
                }
            } else {
                uint256 balanceToAddUniform = toUniform(
                    desiredBalance - strategyDatas[i].balance,
                    strategyDatas[i].tokenAddress
                );
                totalUnderflowStrategyWeights += balanceToAddUniform;
                underflowedStrategyWeights[i] = balanceToAddUniform;
            }
        }

        uint256[] supportedTokensIndexes = new uint256[](strategies.length);
        for (uint256 i; i < strategies.length; i++) {
            if (excludedStrategies[i]) {
                continue;
            }

            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / totalUnderflowStrategyWeights;

            if (desiredAllocationUniform < REBALANCE_SWAP_THRESHOLD) {
                excludedStrategies[i] = true;
                totalUnderflowStrategyWeights -= underflowedStrategyWeights[i];
                underflowedStrategyWeights[i] = 0;
                continue;
            }

            for (uint256 j; j < supportedTokens.length; j++) {
                if (strategyDatas[i].tokenAddress == supportedTokens[j]) {
                    supportedTokensIndexes[i] = j;
                    break;
                }
            }

            uint256 currentTokenBalance = IERC20(strategyDatas[i].tokenAddress).balanceOf(address(this));
            uint256 currentTokenBalanceUniform = toUniform(currentTokenBalance, strategyDatas[i].tokenAddress);
            if (currentTokenBalanceUniform < REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                excludedStrategies[i] = true;
                if (currentTokenBalanceUniform < desiredAllocationUniform + REBALANCE_SWAP_THRESHOLD) {
                    IERC20(strategyDatas[i].tokenAddress)
                        .transfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                    balances[i] += currentTokenBalance;
                    totalUnderflowStrategyWeights -= underflowedStrategyWeights[i];
                    underflowedStrategyWeights[i] = 0;
                    totalUnallocatedBalanceUniform -= currentTokenBalance;
                } else {
                    desiredAllocationUniform = fromUniform(desiredAllocationUniform, strategyDatas[i].tokenAddress);
                    IERC20(strategyDatas[i].tokenAddress).transfer(
                        strategyDatas[i].strategyAddress,
                        desiredAllocationUniform
                    );
                    balances[i] += desiredAllocationUniform;
                    totalUnderflowStrategyWeights -= underflowedStrategyWeights[i];
                    underflowedStrategyWeights[i] = 0;
                    totalUnallocatedBalanceUniform -= toUniform(
                        desiredAllocationUniform,
                        strategyDatas[i].tokenAddress
                    );
                }
            } else {
                uint256 saturatedWeightPoints = underflowedStrategyWeights[i] * currentTokenBalance
                    / fromUniform(desiredAllocationUniform, strategyDatas[i].tokenAddress);
                underflowedStrategyWeights[i] -= saturatedWeightPoints;
                totalUnderflowStrategyWeights -= saturatedWeightPoints;
                totalUnallocatedBalanceUniform -= currentTokenBalance;

                IERC20(strategyDatas[i].tokenAddress).transfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                balances[i] += currentTokenBalance;
            }
        }

        for (uint256 i; i < strategies.length; i++) {
            if (excludedStrategies[i]) {
                continue;
            }

            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / totalUnderflowStrategyWeights;
            totalUnderflowStrategyWeights -= underflowedStrategyWeights[i];
            underflowedStrategyWeights[i] = 0;

            if (desiredAllocationUniform < REBALANCE_SWAP_THRESHOLD) {
                continue;
            }

            for (uint256 j; j < supportedTokens.length; j++) {
                if (supportedTokensIndexes[i] == j) {
                    continue;
                }

                uint256 currentTokenBalance = IERC20(supportedTokens[j]).balanceOf(address(this));
                uint256 currentTokenBalanceUniform = toUniform(currentTokenBalance, supportedTokens[j]);
                if (currentTokenBalanceUniform < REBALANCE_SWAP_THRESHOLD) {
                    continue;
                }

                uint256 received;
                if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                    if (currentTokenBalanceUniform < desiredAllocationUniform + REBALANCE_SWAP_THRESHOLD) {
                        totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;
                        IERC20(supportedTokens[j]).transfer(exchange, currentTokenBalance);
                        received = Exchange(exchange).swap(
                            currentTokenBalance,
                            supportedTokens[j],
                            strategyDatas[i].tokenAddress
                        );
                    } else {
                        uint256 desiredAllocation = fromUniform(desiredAllocationUniform, supportedTokens[j]);
                        totalUnallocatedBalanceUniform -= toUniform(desiredAllocation, supportedTokens[j]);
                        IERC20(supportedTokens[j]).transfer(
                            exchange,
                            desiredAllocation
                        );
                        received = Exchange(exchange).swap(
                            desiredAllocation,
                            supportedTokens[j],
                            strategyDatas[i].tokenAddress
                        );
                    }
                } else {
                    desiredAllocationUniform -= currentTokenBalanceUniform;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;
                    IERC20(supportedTokens[j]).transfer(exchange, currentTokenBalance);
                    received = Exchange(exchange).swap(
                        currentTokenBalance,
                        supportedTokens[j],
                        strategyDatas[i].tokenAddress
                    );
                }
                IERC20(supportedTokens[j]).transfer(strategyDatas[i].strategyAddress, received);
                balances[i] += received;
                if (desiredAllocationUniform < REBALANCE_SWAP_THRESHOLD) {
                    break;
                }
            }
        }
    }
}
