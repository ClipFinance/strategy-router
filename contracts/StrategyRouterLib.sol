//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IIdleStrategy.sol";
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
    uint256 private constant ALLOCATION_THRESHOLD = 1e17;

    struct StrategyData {
        address strategyAddress;
        address tokenAddress;
        uint256 tokenIndexInSupportedTokens;
        uint256 weight;
        bool saturated;
        uint256 toDeposit;
    }

    struct TokenData {
        uint256 currentBalance;
        uint256 currentBalanceUniform;
        bool isBalanceInsufficient;
    }

    function getStrategiesValue(
        IUsdOracle oracle,
        StrategyRouter.StrategyInfo[] storage strategies,
        StrategyRouter.IdleStrategyInfo[] storage idleStrategies
    )
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances, uint256[] memory idleBalances)
    {
        uint256 strategiesLength = strategies.length;
        balances = new uint256[](strategiesLength);
        for (uint256 i; i < strategiesLength; i++) {
            address token = strategies[i].depositToken;

            uint256 balanceInDepositToken = IStrategy(strategies[i].strategyAddress).totalTokens();

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(token);
            balanceInDepositToken = ((balanceInDepositToken * price) / 10**priceDecimals);
            balanceInDepositToken = toUniform(balanceInDepositToken, token);
            balances[i] = balanceInDepositToken;
            totalBalance += balanceInDepositToken;
        }

        uint256 idleStrategiesLength = idleStrategies.length;
        idleBalances = new uint256[](idleStrategies.length);
        for (uint256 i; i < idleStrategiesLength; i++) {
            address token = idleStrategies[i].depositToken;

            uint256 balanceInDepositToken = IIdleStrategy(idleStrategies[i].strategyAddress).totalTokens();

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(token);
            balanceInDepositToken = ((balanceInDepositToken * price) / 10**priceDecimals);
            balanceInDepositToken = toUniform(balanceInDepositToken, token);
            idleBalances[i] = balanceInDepositToken;
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
                    saturated: false,
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
                    strategyDatas[i].saturated = true;
                    uint256 balanceToWithdraw = balances[i] - desiredBalance;
                    if (toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress) >= ALLOCATION_THRESHOLD) {
                        // withdraw is called only once
                        // we already know that strategy has overflow and its exact amount
                        // we do not care where withdrawn tokens will be allocated
                        uint256 withdrawnBalance = IStrategy(strategyDatas[i].strategyAddress)
                            .withdraw(balanceToWithdraw);
                        balances[i] -= withdrawnBalance;
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
                    } else {
                        strategyDatas[i].saturated = true;
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
            if (strategyDatas[i].saturated) {
                continue;
            }

            // NOT: desired balance is calculated used new derived weights
            // only underflow strategies has that weights
            uint256 desiredAllocationUniform = totalUnallocatedBalanceUniform * underflowedStrategyWeights[i]
                / remainingToAllocateUnderflowStrategiesWeightSum;

            if (desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                strategyDatas[i].saturated = true;
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
                strategyDatas[i].saturated = true;
                remainingToAllocateUnderflowStrategiesWeightSum -= underflowedStrategyWeights[i];
                underflowedStrategyWeights[i] = 0;

                // manipulation to avoid leftovers
                // if the token balance of Router will be lesser that THRESHOLD after allocation
                // then send leftover with the desired balance
                if (currentTokenBalanceUniform - desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                    IERC20(strategyTokenAddress)
                        .transfer(strategyDatas[i].strategyAddress, currentTokenBalance);
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
                    IERC20(strategyTokenAddress).transfer(
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

                IERC20(strategyTokenAddress).transfer(strategyDatas[i].strategyAddress, currentTokenBalance);
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
            if (strategyDatas[i].saturated) {
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

                        IERC20(supportedTokens[j]).transfer(
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

                    IERC20(supportedTokens[j]).transfer(
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
}
