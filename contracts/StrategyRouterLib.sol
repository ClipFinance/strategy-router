//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./idle-strategies/DefaultIdleStrategy.sol";
import "./interfaces/IIdleStrategy.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import {ReceiptNFT} from "./ReceiptNFT.sol";
import {Exchange} from "./exchange/Exchange.sol";
import {SharesToken} from "./SharesToken.sol";
import "./Batch.sol";
import "./StrategyRouter.sol";

 import "hardhat/console.sol";

library StrategyRouterLib {
    using SafeERC20 for IERC20;

    error CycleNotClosed();

    uint8 private constant UNIFORM_DECIMALS = 18;
    uint256 private constant PRECISION = 1e18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 private constant ALLOCATION_THRESHOLD = 1e17;

    struct StrategyData {
        address strategyAddress;
        address tokenAddress;
        uint256 tokenIndexInSupportedTokens;
        uint256 weight;
        uint256 toDeposit;
    }

    struct TokenData {
        uint256 currentBalance;
        uint256 currentBalanceUniform;
        bool isBalanceInsufficient;
    }

    function getStrategiesValue(
        Batch batch,
        StrategyRouter.StrategyInfo[] storage strategies,
        StrategyRouter.IdleStrategyInfo[] storage idleStrategies
    )
        public
        view
        returns (
            uint256 totalBalance,
            uint256 totalStrategyBalance,
            uint256 totalIdleStrategyBalance,
            uint256[] memory balances,
            uint256[] memory idleBalances
        )
    {
        (
            StrategyRouter.TokenPrice[] memory supportedTokenPrices
        ) = batch.getSupportedTokensWithPriceInUsd();

        uint256[] memory strategyIndexToSupportedTokenIndex = batch.getStrategyIndexToSupportedTokenIndexMap();

        (
            totalBalance, 
            totalStrategyBalance,
            totalIdleStrategyBalance,
            balances, 
            idleBalances
        ) = getStrategiesValueWithoutOracleCalls(
            strategies,
            idleStrategies,
            supportedTokenPrices,
            strategyIndexToSupportedTokenIndex
        );
    }

    function getStrategiesValueWithoutOracleCalls(
        StrategyRouter.StrategyInfo[] storage strategies,
        StrategyRouter.IdleStrategyInfo[] storage idleStrategies,
        StrategyRouter.TokenPrice[] memory supportedTokenPrices, 
        uint256[] memory strategyIndexToSupportedTokenIndex
    )
        public
        view
        returns (
            uint256 totalBalance, 
            uint256 totalStrategyBalance, 
            uint256 totalIdleStrategyBalance, 
            uint256[] memory balances, 
            uint256[] memory idleBalances
        )
    {
        uint256 strategiesLength = strategyIndexToSupportedTokenIndex.length;
        balances = new uint256[](strategiesLength);
        for (uint256 i; i < strategiesLength; i++) {
            uint256 balanceInUsd = IStrategy(strategies[i].strategyAddress).totalTokens();

            StrategyRouter.TokenPrice memory tokenPrice = supportedTokenPrices[
                strategyIndexToSupportedTokenIndex[i]
            ];
            balanceInUsd = ((balanceInUsd * tokenPrice.price) / 10**tokenPrice.priceDecimals);
            balanceInUsd = toUniform(balanceInUsd, tokenPrice.token);
            balances[i] = balanceInUsd;
            totalBalance += balanceInUsd;
            totalStrategyBalance += balanceInUsd;
        }

        uint256 idleStrategiesLength = supportedTokenPrices.length;
        idleBalances = new uint256[](idleStrategiesLength);
        for (uint256 i; i < idleStrategiesLength; i++) {
            uint256 balanceInUsd = IIdleStrategy(idleStrategies[i].strategyAddress).totalTokens();

            StrategyRouter.TokenPrice memory tokenPrice = supportedTokenPrices[i];
            balanceInUsd = ((balanceInUsd * tokenPrice.price) / 10**tokenPrice.priceDecimals);
            balanceInUsd = toUniform(balanceInUsd, tokenPrice.token);
            idleBalances[i] = balanceInUsd;
            totalBalance += balanceInUsd;
            totalIdleStrategyBalance += balanceInUsd;
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
        if (amount == 0) {
            return amount;
        }

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
            IERC20(from).safeTransfer(address(exchange), amount);
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

    // TODO When idle added to rebalanced should be a special case for removed token
    function rebalanceStrategies(
        Exchange exchange,
        StrategyRouter.StrategyInfo[] storage strategies,
        uint256 remainingToAllocateStrategiesWeightSum,
        address[] memory supportedTokens
    )
        public
        returns (uint256[] memory balances)
    {
        // track balance to allocate between strategies
        uint256 totalUnallocatedBalanceUniform;
        StrategyData[] memory strategyDatas = new StrategyData[](strategies.length);

        uint256[] memory underflowedStrategyWeights = new uint256[](strategyDatas.length);
        uint256 remainingToAllocateUnderflowStrategiesWeightSum;

        TokenData[] memory currentTokenDatas = new TokenData[](supportedTokens.length);
        balances = new uint256[](strategyDatas.length);

        // prepare state for allocation
        // 1. calculate total token balance of strategies and router
        // 2. derive strategy desired balances from total token balance
        // 3. withdraw overflows on strategies with excess
        // 4. use underflows to calculate new relative weights of strategies with deficit
        //    that will be used to allocate unallocated balance
        {
            uint256 totalBalanceUniform;

            // sum token balances of strategies to total balance
            // collect data about strategies
            for (uint256 i; i < strategyDatas.length; i++) {
                balances[i] = IStrategy(strategies[i].strategyAddress).totalTokens();
                strategyDatas[i] = StrategyData({
                    strategyAddress: strategies[i].strategyAddress,
                    tokenAddress: strategies[i].depositToken,
                    tokenIndexInSupportedTokens: 0,
                    weight: strategies[i].weight,
                    toDeposit: 0
                });
                totalBalanceUniform += toUniform(balances[i], strategyDatas[i].tokenAddress);

                for (uint256 j; j < supportedTokens.length; j++) {
                    if (strategyDatas[i].tokenAddress == supportedTokens[j]) {
                        strategyDatas[i].tokenIndexInSupportedTokens = j;
                        break;
                    }
                }
            }

            // sum token balances of router to total balance
            // sum token balances of router to total unallocated balance
            // collect router token data
            for (uint256 i; i < supportedTokens.length; i++) {
                uint256 currentTokenBalance = IERC20(supportedTokens[i]).balanceOf(address(this));
                currentTokenDatas[i].currentBalance = currentTokenBalance;
                uint256 currentTokenBalanceUniform = toUniform(
                    currentTokenBalance,
                    supportedTokens[i]
                );
                currentTokenDatas[i].currentBalanceUniform = currentTokenBalanceUniform;
                totalBalanceUniform += currentTokenBalanceUniform;
                totalUnallocatedBalanceUniform += currentTokenBalanceUniform;
            }

            // derive desired strategy balances
            // sum withdrawn overflows to total unallocated balance
            for (uint256 i; i < strategyDatas.length; i++) {
                uint256 desiredBalance = (totalBalanceUniform * strategyDatas[i].weight)
                    / remainingToAllocateStrategiesWeightSum;
                desiredBalance = fromUniform(desiredBalance, strategyDatas[i].tokenAddress);
                // if current balance is greater than desired – withdraw excessive tokens
                // add them up to total unallocated balance
                if (desiredBalance < balances[i]) {
                    uint256 balanceToWithdraw = balances[i] - desiredBalance;
                    if (toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress) >= ALLOCATION_THRESHOLD) {
                        // withdraw is called only once
                        // we already know that strategy has overflow and its exact amount
                        // we do not care where withdrawn tokens will be allocated
                        uint256 withdrawnBalance = IStrategy(strategyDatas[i].strategyAddress)
                            .withdraw(balanceToWithdraw);
                        // could happen if we withdrew more tokens than expected
                        if (withdrawnBalance > balances[i]) {
                            balances[i] = 0;
                        } else {
                            balances[i] -= withdrawnBalance;
                        }
                        currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance += withdrawnBalance;
                        withdrawnBalance = toUniform(
                            withdrawnBalance,
                            strategyDatas[i].tokenAddress
                        );
                        currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform += withdrawnBalance;
                        totalUnallocatedBalanceUniform += withdrawnBalance;
                    }
                // otherwise use deficit of tokens as weight of a underflow strategy
                // used to allocate unallocated balance
                } else {
                    uint256 balanceToAddUniform = toUniform(
                        desiredBalance - balances[i],
                        strategyDatas[i].tokenAddress
                    );
                    if (balanceToAddUniform >= ALLOCATION_THRESHOLD) {
                        remainingToAllocateUnderflowStrategiesWeightSum += balanceToAddUniform;
                        underflowedStrategyWeights[i] = balanceToAddUniform;
                    }
                }
            }

            // clean up: if token balance of Router is below THRESHOLD remove it from consideration
            // as these tokens are not accessible for strategy allocation
            for (uint256 i; i < supportedTokens.length; i++) {
                uint256 currentTokenBalanceUniform = currentTokenDatas[i].currentBalanceUniform;
                if (currentTokenBalanceUniform < ALLOCATION_THRESHOLD) {
                    currentTokenDatas[i].isBalanceInsufficient = true;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;
                }
            }
        }

        // all tokens to be allocation to strategies with underflows at Router at the moment
        // NO SWAP allocation
        // First try to allocate desired balance to any strategy if there is balance in deposit token of this strategy
        // available at Router
        // that aims to avoid swaps
        for (uint256 i; i < strategyDatas.length; i++) {
            if (underflowedStrategyWeights[i] == 0) {
                continue;
            }

            // NOT: desired balance is calculated used new derived weights
            // only underflow strategies has that weights
            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / remainingToAllocateUnderflowStrategiesWeightSum;

            if (desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                remainingToAllocateUnderflowStrategiesWeightSum -= underflowedStrategyWeights[i];
                underflowedStrategyWeights[i] = 0;
                continue;
            }

            if (currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].isBalanceInsufficient) {
                continue;
            }

            address strategyTokenAddress = strategyDatas[i].tokenAddress;

            uint256 currentTokenBalance = currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance;
            uint256 currentTokenBalanceUniform = currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens]
                .currentBalanceUniform;

            // allocation logic
            if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                remainingToAllocateUnderflowStrategiesWeightSum -= underflowedStrategyWeights[i];
                underflowedStrategyWeights[i] = 0;

                // manipulation to avoid leftovers
                // if the token balance of Router will be lesser that THRESHOLD after allocation
                // then send leftover with the desired balance
                if (currentTokenBalanceUniform - desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                    IERC20(strategyTokenAddress)
                        .safeTransfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                    // memoise how much was deposited to strategy
                    // optimisation to call deposit method only once per strategy
                    strategyDatas[i].toDeposit = currentTokenBalance;

                    balances[i] += currentTokenBalance;
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance = 0;
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform = 0;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].isBalanceInsufficient = true;
                } else {
                    // !!!IMPORTANT: we convert desiredStrategyBalance from uniform value and then back to uniform
                    // and ONLY then subtract it from totalUnallocatedBalance
                    // the reason is that initial is virtual and could mismatch to the amount of token really allocated
                    // Example: here can be desiredStrategyBalanceUniform = 333333333333333333 (10**18 decimals)
                    // while real token allocated value desiredStrategyBalance = 33333333 (10**8 real token precision)
                    // therefore should subtract 333333330000000000 from total unallocated token balance
                    desiredAllocationUniform = fromUniform(desiredAllocationUniform, strategyTokenAddress);
                    IERC20(strategyTokenAddress).safeTransfer(
                        strategyDatas[i].strategyAddress,
                        desiredAllocationUniform
                    );
                    // memoise how much was deposited to strategy
                    // optimisation to call deposit method only once per strategy
                    strategyDatas[i].toDeposit = desiredAllocationUniform;

                    balances[i] += desiredAllocationUniform;
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance
                        = currentTokenBalance - desiredAllocationUniform;
                    desiredAllocationUniform = toUniform(
                        desiredAllocationUniform,
                        strategyTokenAddress
                    );
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform
                        = currentTokenBalanceUniform - desiredAllocationUniform;
                    totalUnallocatedBalanceUniform -= desiredAllocationUniform;
                }
            } else {
                // reduce strategy weight in the current rebalance iteration proportionally to the degree
                // at which the strategy's desired balance was saturated
                // For example: if a strategy's weight is 10,000 and the total weight is 100,000
                // and the strategy's desired balance was saturated by 80%
                // we reduce the strategy weight by 80%
                // strategy weight = 10,000 - 80% * 10,000 = 2,000
                // total strategy weight = 100,000 - 80% * 10,000 = 92,000
                uint256 saturatedWeightPoints = underflowedStrategyWeights[i] * currentTokenBalanceUniform
                    / desiredAllocationUniform;
                underflowedStrategyWeights[i] -= saturatedWeightPoints;
                remainingToAllocateUnderflowStrategiesWeightSum -= saturatedWeightPoints;
                totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                IERC20(strategyTokenAddress).safeTransfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                // memoise how much was deposited to strategy
                // optimisation to call deposit method only once per strategy
                strategyDatas[i].toDeposit = currentTokenBalance;

                balances[i] += currentTokenBalance;
                currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance = 0;
                currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform = 0;
                currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].isBalanceInsufficient = true;
            }
        }

        // SWAPFUL allocation
        // if not enough tokens in a strategy deposit token available
        // then try to saturate desired balance swapping other tokens
        for (uint256 i; i < strategyDatas.length; i++) {
            if (underflowedStrategyWeights[i] == 0) {
                if (strategyDatas[i].toDeposit > 0) {
                    // if the strategy was completely saturated at the previous step
                    // call deposit
                    IStrategy(strategyDatas[i].strategyAddress).deposit(strategyDatas[i].toDeposit);
                }
                continue;
            }

            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / remainingToAllocateUnderflowStrategiesWeightSum;
            // reduce weight, we are sure we will fulfill desired balance on this step
            remainingToAllocateUnderflowStrategiesWeightSum -= underflowedStrategyWeights[i];
            underflowedStrategyWeights[i] = 0;

            if (desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                continue;
            }

            for (uint256 j; j < supportedTokens.length; j++) {
                // skip deposit token as it was handled on the previous iteration
                if (strategyDatas[i].tokenIndexInSupportedTokens == j) {
                    continue;
                }

                if (currentTokenDatas[j].isBalanceInsufficient) {
                    continue;
                }

                uint256 currentTokenBalanceUniform = currentTokenDatas[j].currentBalanceUniform;

                if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                    // manipulation to avoid leftovers
                    // if the token balance of Router will be lesser that THRESHOLD after allocation
                    // then send leftover with the desired balance
                    if (currentTokenBalanceUniform - desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                        desiredAllocationUniform = 0;
                        totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                        IERC20(supportedTokens[j]).safeTransfer(
                            address(exchange),
                            currentTokenDatas[j].currentBalance
                        );
                        uint256 received = exchange.swap(
                            currentTokenDatas[j].currentBalance,
                            supportedTokens[j],
                            strategyDatas[i].tokenAddress,
                            strategyDatas[i].strategyAddress
                        );
                        // memoise how much was deposited to strategy
                        // optimisation to call deposit method only once per strategy
                        strategyDatas[i].toDeposit = received;

                        balances[i] += received;
                        currentTokenDatas[j].currentBalance = 0;
                        currentTokenDatas[j].currentBalanceUniform = 0;
                        currentTokenDatas[j].isBalanceInsufficient = true;
                    } else {
                        // !!!IMPORTANT: we convert desiredStrategyBalance from uniform value and then back to uniform
                        // and ONLY then subtract it from totalUnallocatedBalance
                        // the reason is that initial is virtual and could mismatch to the amount of token really allocated
                        // Example: here can be desiredStrategyBalanceUniform = 333333333333333333 (10**18 decimals)
                        // while real token allocated value desiredStrategyBalance = 33333333 (10**8 real token precision)
                        // therefore should subtract 333333330000000000 from total unallocated token balance
                        desiredAllocationUniform = fromUniform(desiredAllocationUniform, supportedTokens[j]);
                        totalUnallocatedBalanceUniform -= toUniform(desiredAllocationUniform, supportedTokens[j]);

                        IERC20(supportedTokens[j]).safeTransfer(
                            address(exchange),
                            desiredAllocationUniform
                        );
                        uint256 received = exchange.swap(
                            desiredAllocationUniform,
                            supportedTokens[j],
                            strategyDatas[i].tokenAddress,
                            strategyDatas[i].strategyAddress
                        );
                        // memoise how much was deposited to strategy
                        // optimisation to call deposit method only once per strategy
                        strategyDatas[i].toDeposit = received;

                        balances[i] += received;
                        currentTokenDatas[j].currentBalance -= desiredAllocationUniform;
                        currentTokenDatas[j].currentBalanceUniform -= desiredAllocationUniform;
                        desiredAllocationUniform = 0;
                    }
                } else {
                    desiredAllocationUniform -= currentTokenBalanceUniform;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                    IERC20(supportedTokens[j]).safeTransfer(
                        address(exchange),
                        currentTokenDatas[j].currentBalance
                    );
                    uint256 received = exchange.swap(
                        currentTokenDatas[j].currentBalance,
                        supportedTokens[j],
                        strategyDatas[i].tokenAddress,
                        strategyDatas[i].strategyAddress
                    );
                    // memoise how much was deposited to strategy
                    // optimisation to call deposit method only once per strategy
                    strategyDatas[i].toDeposit = received;

                    balances[i] += received;
                    currentTokenDatas[j].currentBalance = 0;
                    currentTokenDatas[j].currentBalanceUniform = 0;
                    currentTokenDatas[j].isBalanceInsufficient = true;
                }
                // optimisation, no need to continue
                if (desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                    break;
                }
            }

            // deposit amount of tokens was transfered to the strategy
            // NOTE: in some edge cases 0 could be deposited
            IStrategy(strategyDatas[i].strategyAddress).deposit(strategyDatas[i].toDeposit);
        }
    }

    function setIdleStrategy(
        StrategyRouter.IdleStrategyInfo[] storage idleStrategies,
        address[] memory supportedTokens,
        uint256 i,
        address idleStrategy
    ) public {
        if (i >= supportedTokens.length) {
            revert StrategyRouter.InvalidIndexForIdleStrategy();
        }

        address tokenAddress = supportedTokens[i];
        if (idleStrategy == address(0) || IIdleStrategy(idleStrategy).depositToken() != tokenAddress) {
            revert StrategyRouter.InvalidIdleStrategy();
        }

        if (i < idleStrategies.length) {
            if (idleStrategies[i].strategyAddress != address(0)) {
                IIdleStrategy currentIdleStrategy = IIdleStrategy(idleStrategies[i].strategyAddress);
                if (currentIdleStrategy.totalTokens() != 0) {
                    uint256 withdrawnAmount = currentIdleStrategy.withdrawAll();
                    IERC20(tokenAddress).safeTransfer(idleStrategy, withdrawnAmount);
                    IIdleStrategy(idleStrategy).deposit(withdrawnAmount);
                }

                Ownable(address(currentIdleStrategy))
                    .transferOwnership(Ownable(address(this)).owner());
            }

            idleStrategies[i] = StrategyRouter.IdleStrategyInfo({
                strategyAddress: idleStrategy,
                depositToken: tokenAddress
            });
        } else {
            // ensure idle strategy pushed at index i
            // though in practice the loop will never be iterated
            for (uint256 j = idleStrategies.length; j < i; j++) {
                idleStrategies.push(
                    StrategyRouter.IdleStrategyInfo({
                        strategyAddress: address(0),
                        depositToken: address(0)
                    })
                );
            }
            idleStrategies.push(
                StrategyRouter.IdleStrategyInfo({
                    strategyAddress: idleStrategy,
                    depositToken: tokenAddress
                })
            );
        }
    }

    function _removeIdleStrategy(
        StrategyRouter.IdleStrategyInfo[] storage idleStrategies,
        Batch batch,
        Exchange exchange,
        StrategyRouter.StrategyInfo[] storage strategies,
        uint256 allStrategiesWeightSum,
        address tokenAddress
    ) public {
        StrategyRouter.IdleStrategyInfo memory idleStrategyToRemove;
        for (uint256 i; i < idleStrategies.length; i++) {
            if (tokenAddress == idleStrategies[i].depositToken) {
                idleStrategyToRemove = idleStrategies[i];
                idleStrategies[i] = idleStrategies[idleStrategies.length - 1];
                idleStrategies.pop();
                // !!!IMPORTANT: idle strategy removal pattern follows supported token removal pattern
                // so the shifted indexes must match
                // but better to double check
                // TODO add tests for idleStrategyLength = 0 after removal
                if (
                    idleStrategies.length != 0
                    && i != idleStrategies.length
                    && idleStrategies[i].depositToken != batch.getSupportedTokens()[i]
                ) {
                    revert StrategyRouter.IdleStrategySupportedTokenMismatch();
                }
                break;
            }
        }

        if (IIdleStrategy(idleStrategyToRemove.strategyAddress).withdrawAll() != 0) {
            address[] memory supportedTokens = batch.getSupportedTokens();
            address[] memory supportedTokensWithRemovedToken = new address[](supportedTokens.length + 1);
            supportedTokensWithRemovedToken[0] = idleStrategyToRemove.depositToken;
            for (uint256 i; i < supportedTokens.length; i++) {
                supportedTokensWithRemovedToken[i + 1] = supportedTokens[i];
            }
            rebalanceStrategies(
                exchange,
                strategies,
                allStrategiesWeightSum,
                supportedTokensWithRemovedToken
            );
        }

        // TODO test
        Ownable(address(idleStrategyToRemove.strategyAddress)).transferOwnership(msg.sender);
    }
}
