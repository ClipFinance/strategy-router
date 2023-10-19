//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IIdleStrategy.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {TokenPrice, StrategyInfo, IdleStrategyInfo, ReceiptData, Cycle} from "./lib/Structs.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IIdleStrategy.sol";
import "./interfaces/IExchange.sol";
import "./interfaces/IReceiptNFT.sol";
import "./interfaces/ISharesToken.sol";
import "./interfaces/IBatch.sol";

import {ISphereXEngine} from "@spherex-xyz/contracts/src/ISphereXEngine.sol";

library StrategyRouterLib {
    using SafeERC20 for IERC20;

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

    bytes32 private constant SPHEREX_ADMIN_STORAGE_SLOT = bytes32(uint256(keccak256("eip1967.spherex.spherex")) - 1);
    bytes32 private constant SPHEREX_OPERATOR_STORAGE_SLOT = bytes32(uint256(keccak256("eip1967.spherex.operator")) - 1);
    bytes32 private constant SPHEREX_ENGINE_STORAGE_SLOT =
        bytes32(uint256(keccak256("eip1967.spherex.spherex_engine")) - 1);

    struct ModifierLocals {
        bytes32[] storageSlots;
        bytes32[] valuesBefore;
        uint256 gas;
    }

    function _sphereXEngine() private view returns (ISphereXEngine) {
        return ISphereXEngine(_getAddress(SPHEREX_ENGINE_STORAGE_SLOT));
    }

    function _getAddress(bytes32 slot) private view returns (address addr) {
        // solhint-disable-next-line no-inline-assembly
        // slither-disable-next-line assembly
        assembly {
            addr := sload(slot)
        }
    }

    modifier returnsIfNotActivated() {
        if (address(_sphereXEngine()) == address(0)) {
            return;
        }

        _;
    }

    // ============ Hooks ============

    /**
     * @dev internal function for engine communication. We use it to reduce contract size.
     *  Should be called before the code of a function.
     * @param num function identifier
     * @param isExternalCall set to true if this was called externally
     *  or a 'public' function from another address
     */
    function _sphereXValidatePre(int256 num, bool isExternalCall)
        private
        returnsIfNotActivated
        returns (ModifierLocals memory locals)
    {
        ISphereXEngine sphereXEngine = _sphereXEngine();
        if (isExternalCall) {
            locals.storageSlots = sphereXEngine.sphereXValidatePre(num, msg.sender, msg.data);
        } else {
            locals.storageSlots = sphereXEngine.sphereXValidateInternalPre(num);
        }
        locals.valuesBefore = _readStorage(locals.storageSlots);
        locals.gas = gasleft();
        return locals;
    }

    /**
     * @dev internal function for engine communication. We use it to reduce contract size.
     *  Should be called after the code of a function.
     * @param num function identifier
     * @param isExternalCall set to true if this was called externally
     *  or a 'public' function from another address
     */
    function _sphereXValidatePost(int256 num, bool isExternalCall, ModifierLocals memory locals)
        private
        returnsIfNotActivated
    {
        uint256 gas = locals.gas - gasleft();

        ISphereXEngine sphereXEngine = _sphereXEngine();

        bytes32[] memory valuesAfter;
        valuesAfter = _readStorage(locals.storageSlots);

        if (isExternalCall) {
            sphereXEngine.sphereXValidatePost(num, gas, locals.valuesBefore, valuesAfter);
        } else {
            sphereXEngine.sphereXValidateInternalPost(num, gas, locals.valuesBefore, valuesAfter);
        }
    }

    /**
     * @dev internal function for engine communication. We use it to reduce contract size.
     *  Should be called before the code of a function.
     * @param num function identifier
     * @return locals ModifierLocals
     */
    function _sphereXValidateInternalPre(int256 num)
        internal
        returnsIfNotActivated
        returns (ModifierLocals memory locals)
    {
        locals.storageSlots = _sphereXEngine().sphereXValidateInternalPre(num);
        locals.valuesBefore = _readStorage(locals.storageSlots);
        locals.gas = gasleft();
        return locals;
    }

    /**
     * @dev internal function for engine communication. We use it to reduce contract size.
     *  Should be called after the code of a function.
     * @param num function identifier
     * @param locals ModifierLocals
     */
    function _sphereXValidateInternalPost(int256 num, ModifierLocals memory locals) internal returnsIfNotActivated {
        bytes32[] memory valuesAfter;
        valuesAfter = _readStorage(locals.storageSlots);
        _sphereXEngine().sphereXValidateInternalPost(num, locals.gas - gasleft(), locals.valuesBefore, valuesAfter);
    }

    /**
     *  @dev Modifier to be incorporated in all internal protected non-view functions
     */
    modifier sphereXGuardInternal(int256 num) {
        ModifierLocals memory locals = _sphereXValidateInternalPre(num);
        _;
        _sphereXValidateInternalPost(-num, locals);
    }

    /**
     *  @dev Modifier to be incorporated in all external protected non-view functions
     */
    modifier sphereXGuardExternal(int256 num) {
        ModifierLocals memory locals = _sphereXValidatePre(num, true);
        _;
        _sphereXValidatePost(-num, true, locals);
    }

    /**
     *  @dev Modifier to be incorporated in all public protected non-view functions
     */
    modifier sphereXGuardPublic(int256 num, bytes4 selector) {
        ModifierLocals memory locals = _sphereXValidatePre(num, msg.sig == selector);
        _;
        _sphereXValidatePost(-num, msg.sig == selector, locals);
    }

    // ============ Internal Storage logic ============

    /**
     * Internal function that reads values from given storage slots and returns them
     * @param storageSlots list of storage slots to read
     * @return list of values read from the various storage slots
     */
    function _readStorage(bytes32[] memory storageSlots) internal view returns (bytes32[] memory) {
        uint256 arrayLength = storageSlots.length;
        bytes32[] memory values = new bytes32[](arrayLength);
        // create the return array data

        for (uint256 i = 0; i < arrayLength; i++) {
            bytes32 slot = storageSlots[i];
            bytes32 temp_value;
            // solhint-disable-next-line no-inline-assembly
            // slither-disable-next-line assembly
            assembly {
                temp_value := sload(slot)
            }

            values[i] = temp_value;
        }
        return values;
    }

    // ============ Wrapper Functions ============

    function getStrategiesValue(
        IBatch batch,
        StrategyInfo[] storage strategies,
        IdleStrategyInfo[] storage idleStrategies
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
        TokenPrice[] memory supportedTokenPrices = batch.getSupportedTokensWithPriceInUsd();

        (totalBalance, totalStrategyBalance, totalIdleStrategyBalance, balances, idleBalances) =
            getStrategiesValueWithoutOracleCalls(strategies, idleStrategies, supportedTokenPrices);
    }

    function getStrategiesValueWithoutOracleCalls(
        StrategyInfo[] storage strategies,
        IdleStrategyInfo[] storage idleStrategies,
        TokenPrice[] memory supportedTokenPrices
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
        uint256 strategiesLength = strategies.length;
        balances = new uint256[](strategiesLength);
        for (uint256 i; i < strategiesLength; i++) {
            uint256 balanceInUsd = IStrategy(strategies[i].strategyAddress).totalTokens();

            TokenPrice memory tokenPrice = supportedTokenPrices[strategies[i].depositTokenInSupportedTokensIndex];

            balanceInUsd = ((balanceInUsd * tokenPrice.price) / 10 ** tokenPrice.priceDecimals);
            balanceInUsd = toUniform(balanceInUsd, tokenPrice.token);
            balances[i] = balanceInUsd;
            totalBalance += balanceInUsd;
            totalStrategyBalance += balanceInUsd;
        }

        uint256 idleStrategiesLength = supportedTokenPrices.length;
        idleBalances = new uint256[](idleStrategiesLength);
        for (uint256 i; i < idleStrategiesLength; i++) {
            uint256 balanceInUsd = IIdleStrategy(idleStrategies[i].strategyAddress).totalTokens();

            TokenPrice memory tokenPrice = supportedTokenPrices[i];
            balanceInUsd = ((balanceInUsd * tokenPrice.price) / 10 ** tokenPrice.priceDecimals);
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
        IReceiptNFT receiptContract,
        mapping(uint256 => Cycle) storage cycles
    ) public view returns (uint256 shares) {
        ReceiptData memory receipt = receiptContract.getReceipt(receiptId);
        if (receipt.cycleId == currentCycleId) revert CycleNotClosed();

        uint256 depositCycleTokenPriceUsd = cycles[receipt.cycleId].prices[receipt.token];

        uint256 depositedUsdValueOfReceipt = (receipt.tokenAmountUniform * depositCycleTokenPriceUsd) / PRECISION;
        assert(depositedUsdValueOfReceipt > 0);
        // adjust according to what was actually deposited into strategies
        // example: ($1000 * $4995) / $5000 = $999
        uint256 allocatedUsdValueOfReceipt = (
            depositedUsdValueOfReceipt * cycles[receipt.cycleId].receivedByStrategiesInUsd
        ) / cycles[receipt.cycleId].totalDepositedInUsd;
        return (allocatedUsdValueOfReceipt * PRECISION) / cycles[receipt.cycleId].pricePerShare;
    }

    /// @dev Change decimal places of number from `oldDecimals` to `newDecimals`.
    function changeDecimals(uint256 amount, uint8 oldDecimals, uint8 newDecimals) internal pure returns (uint256) {
        if (amount == 0) {
            return amount;
        }

        if (oldDecimals < newDecimals) {
            return amount * (10 ** (newDecimals - oldDecimals));
        } else if (oldDecimals > newDecimals) {
            return amount / (10 ** (oldDecimals - newDecimals));
        }
        return amount;
    }

    /// @dev Swap tokens if they are different (i.e. not the same token)
    function trySwap(IExchange exchange, uint256 amount, address from, address to) internal returns (uint256 result) {
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
        IReceiptNFT _receiptContract,
        ISharesToken _sharesToken,
        mapping(uint256 => Cycle) storage cycles
    ) public sphereXGuardPublic(1001, 0xf1bd189e) {
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
        IReceiptNFT _receiptContract,
        mapping(uint256 => Cycle) storage cycles
    ) public sphereXGuardPublic(1002, 0xd19ee22f) returns (uint256 shares) {
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (_receiptContract.ownerOf(receiptId) != msg.sender) revert NotReceiptOwner();
            shares += calculateSharesFromReceipt(receiptId, _currentCycleId, _receiptContract, cycles);
            _receiptContract.burn(receiptId);
        }
    }

    function rebalanceStrategies(
        IExchange exchange,
        StrategyInfo[] storage strategies,
        uint256 remainingToAllocateStrategiesWeightSum,
        TokenPrice[] memory supportedTokensWithPrices
    ) public sphereXGuardPublic(1003, 0x00f30ed3) returns (uint256[] memory balances) {
        // track balance to allocate between strategies
        uint256 totalUnallocatedBalanceUniform;
        StrategyData[] memory strategyDatas = new StrategyData[](strategies.length);

        uint256[] memory underflowedStrategyWeights = new uint256[](strategyDatas.length);
        uint256 remainingToAllocateUnderflowStrategiesWeightSum;

        TokenData[] memory currentTokenDatas = new TokenData[](supportedTokensWithPrices.length);
        balances = new uint256[](strategyDatas.length);

        // prepare state for allocation
        // 1. calculate total token balance of strategies and router
        // 2. derive strategy desired balances from total token balance
        // 3. withdraw overflows on strategies with excess
        // 4. use underflow to calculate new relative weights of strategies with deficit
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

                for (uint256 j; j < supportedTokensWithPrices.length; j++) {
                    if (strategyDatas[i].tokenAddress == supportedTokensWithPrices[j].token) {
                        strategyDatas[i].tokenIndexInSupportedTokens = j;
                        break;
                    }
                }
            }
            // sum token balances of router to total balance
            // sum token balances of router to total unallocated balance
            // collect router token data
            for (uint256 i; i < supportedTokensWithPrices.length; i++) {
                uint256 currentTokenBalance = IERC20(supportedTokensWithPrices[i].token).balanceOf(address(this));
                currentTokenDatas[i].currentBalance = currentTokenBalance;
                uint256 currentTokenBalanceUniform = toUniform(currentTokenBalance, supportedTokensWithPrices[i].token);
                currentTokenDatas[i].currentBalanceUniform = currentTokenBalanceUniform;
                totalBalanceUniform += currentTokenBalanceUniform;
                totalUnallocatedBalanceUniform += currentTokenBalanceUniform;
            }

            // derive desired strategy balances
            // sum withdrawn overflows to total unallocated balance
            for (uint256 i; i < strategyDatas.length; i++) {
                uint256 desiredBalance =
                    (totalBalanceUniform * strategyDatas[i].weight) / remainingToAllocateStrategiesWeightSum;
                desiredBalance = fromUniform(desiredBalance, strategyDatas[i].tokenAddress);
                // if current balance is greater than desired – withdraw excessive tokens
                // add them up to total unallocated balance
                if (desiredBalance < balances[i]) {
                    uint256 balanceToWithdraw = balances[i] - desiredBalance;
                    if (toUniform(balanceToWithdraw, strategyDatas[i].tokenAddress) >= ALLOCATION_THRESHOLD) {
                        // withdraw is called only once
                        // we already know that strategy has overflow and its exact amount
                        // we do not care where withdrawn tokens will be allocated
                        uint256 withdrawnBalance =
                            IStrategy(strategyDatas[i].strategyAddress).withdraw(balanceToWithdraw);
                        // could happen if we withdrew more tokens than expected
                        if (withdrawnBalance > balances[i]) {
                            balances[i] = 0;
                        } else {
                            balances[i] -= withdrawnBalance;
                        }
                        currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance +=
                            withdrawnBalance;
                        withdrawnBalance = toUniform(withdrawnBalance, strategyDatas[i].tokenAddress);
                        currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform +=
                            withdrawnBalance;
                        totalUnallocatedBalanceUniform += withdrawnBalance;
                    }
                }
                // otherwise use deficit of tokens as weight of a underflow strategy
                // used to allocate unallocated balance
                else {
                    uint256 balanceToAddUniform = toUniform(desiredBalance - balances[i], strategyDatas[i].tokenAddress);
                    if (balanceToAddUniform >= ALLOCATION_THRESHOLD) {
                        remainingToAllocateUnderflowStrategiesWeightSum += balanceToAddUniform;
                        underflowedStrategyWeights[i] = balanceToAddUniform;
                    }
                }
            }

            // clean up: if token balance of Router is below THRESHOLD remove it from consideration
            // as these tokens are not accessible for strategy allocation
            for (uint256 i; i < supportedTokensWithPrices.length; i++) {
                uint256 currentTokenBalanceUniform = currentTokenDatas[i].currentBalanceUniform;
                if (currentTokenBalanceUniform < ALLOCATION_THRESHOLD) {
                    currentTokenDatas[i].isBalanceInsufficient = true;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;
                }
            }
        }

        // all tokens to be allocation to strategies with underflow at Router at the moment
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
            uint256 desiredAllocationUniform = (totalUnallocatedBalanceUniform * underflowedStrategyWeights[i])
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
            uint256 currentTokenBalanceUniform =
                currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform;

            // allocation logic
            if (currentTokenBalanceUniform >= desiredAllocationUniform) {
                remainingToAllocateUnderflowStrategiesWeightSum -= underflowedStrategyWeights[i];
                underflowedStrategyWeights[i] = 0;

                // manipulation to avoid leftovers
                // if the token balance of Router will be lesser that THRESHOLD after allocation
                // then send leftover with the desired balance
                if (currentTokenBalanceUniform - desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                    IERC20(strategyTokenAddress).safeTransfer(strategyDatas[i].strategyAddress, currentTokenBalance);
                    // memoise how much was deposited to strategy
                    // optimisation to call deposit method only once per strategy
                    strategyDatas[i].toDeposit = currentTokenBalance;

                    balances[i] += currentTokenBalance;
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance = 0;
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform = 0;
                    totalUnallocatedBalanceUniform -= currentTokenBalanceUniform;

                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].isBalanceInsufficient = true;
                } else {
                    desiredAllocationUniform = fromUniform(desiredAllocationUniform, strategyTokenAddress);
                    IERC20(strategyTokenAddress).safeTransfer(
                        strategyDatas[i].strategyAddress, desiredAllocationUniform
                    );
                    // memoise how much was deposited to strategy
                    // optimisation to call deposit method only once per strategy
                    strategyDatas[i].toDeposit = desiredAllocationUniform;

                    balances[i] += desiredAllocationUniform;
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalance =
                        currentTokenBalance - desiredAllocationUniform;
                    desiredAllocationUniform = toUniform(desiredAllocationUniform, strategyTokenAddress);
                    currentTokenDatas[strategyDatas[i].tokenIndexInSupportedTokens].currentBalanceUniform =
                        currentTokenBalanceUniform - desiredAllocationUniform;
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
                uint256 saturatedWeightPoints =
                    (underflowedStrategyWeights[i] * currentTokenBalanceUniform) / desiredAllocationUniform;
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

            uint256 desiredAllocationUniform = (totalUnallocatedBalanceUniform * underflowedStrategyWeights[i])
                / remainingToAllocateUnderflowStrategiesWeightSum;
            // reduce weight, we are sure we will fulfill desired balance on this step
            remainingToAllocateUnderflowStrategiesWeightSum -= underflowedStrategyWeights[i];
            underflowedStrategyWeights[i] = 0;

            if (desiredAllocationUniform < ALLOCATION_THRESHOLD) {
                continue;
            }

            for (uint256 j; j < supportedTokensWithPrices.length; j++) {
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

                        IERC20(supportedTokensWithPrices[j].token).safeTransfer(
                            address(exchange), currentTokenDatas[j].currentBalance
                        );
                        uint256 received = exchange.stablecoinSwap(
                            currentTokenDatas[j].currentBalance,
                            supportedTokensWithPrices[j].token,
                            strategyDatas[i].tokenAddress,
                            strategyDatas[i].strategyAddress,
                            supportedTokensWithPrices[j],
                            supportedTokensWithPrices[strategyDatas[i].tokenIndexInSupportedTokens]
                        );
                        // memoise how much was deposited to strategy
                        // optimisation to call deposit method only once per strategy
                        strategyDatas[i].toDeposit = received;

                        balances[i] += received;
                        currentTokenDatas[j].currentBalance = 0;
                        currentTokenDatas[j].currentBalanceUniform = 0;
                        currentTokenDatas[j].isBalanceInsufficient = true;
                    } else {
                        desiredAllocationUniform =
                            fromUniform(desiredAllocationUniform, supportedTokensWithPrices[j].token);
                        totalUnallocatedBalanceUniform -=
                            toUniform(desiredAllocationUniform, supportedTokensWithPrices[j].token);

                        IERC20(supportedTokensWithPrices[j].token).safeTransfer(
                            address(exchange), desiredAllocationUniform
                        );
                        uint256 received = exchange.swap(
                            desiredAllocationUniform,
                            supportedTokensWithPrices[j].token,
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

                    IERC20(supportedTokensWithPrices[j].token).safeTransfer(
                        address(exchange), currentTokenDatas[j].currentBalance
                    );
                    uint256 received = exchange.swap(
                        currentTokenDatas[j].currentBalance,
                        supportedTokensWithPrices[j].token,
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

            // deposit amount of tokens was transferred to the strategy
            IStrategy(strategyDatas[i].strategyAddress).deposit(strategyDatas[i].toDeposit);
        }
    }

    function setIdleStrategy(
        IdleStrategyInfo[] storage idleStrategies,
        address[] memory supportedTokens,
        uint256 i,
        address idleStrategy,
        address moderator
    ) public sphereXGuardPublic(1004, 0x956c3b38) {
        if (i >= supportedTokens.length) {
            revert InvalidIndexForIdleStrategy();
        }

        address tokenAddress = supportedTokens[i];
        if (idleStrategy == address(0) || IIdleStrategy(idleStrategy).depositToken() != tokenAddress) {
            revert InvalidIdleStrategy();
        }
        // Replace one idle strategy with the other one. Withdraw funds from previous one and add to new one.
        if (i < idleStrategies.length) {
            if (idleStrategies[i].strategyAddress != address(0)) {
                IIdleStrategy currentIdleStrategy = IIdleStrategy(idleStrategies[i].strategyAddress);
                if (currentIdleStrategy.totalTokens() != 0) {
                    uint256 withdrawnAmount = currentIdleStrategy.withdrawAll();
                    IERC20(tokenAddress).safeTransfer(idleStrategy, withdrawnAmount);
                    IIdleStrategy(idleStrategy).deposit(withdrawnAmount);
                }

                Ownable(address(currentIdleStrategy)).transferOwnership(moderator);
            }

            idleStrategies[i] = IdleStrategyInfo({strategyAddress: idleStrategy, depositToken: tokenAddress});
        } else {
            // ensure idle strategy pushed at index i
            // though in practice the loop will never be iterated
            for (uint256 j = idleStrategies.length; j < i; j++) {
                idleStrategies.push(IdleStrategyInfo({strategyAddress: address(0), depositToken: address(0)}));
            }
            idleStrategies.push(IdleStrategyInfo({strategyAddress: idleStrategy, depositToken: tokenAddress}));
        }
    }

    function _removeIdleStrategy(
        IdleStrategyInfo[] storage idleStrategies,
        IBatch batch,
        IExchange exchange,
        StrategyInfo[] storage strategies,
        uint256 allStrategiesWeightSum,
        address tokenAddress,
        TokenPrice[] memory supportedTokensWithPricesWithRemovedToken,
        address moderator
    ) public sphereXGuardPublic(1005, 0x817c61e7) {
        IdleStrategyInfo memory idleStrategyToRemove;
        for (uint256 i; i < idleStrategies.length; i++) {
            if (tokenAddress == idleStrategies[i].depositToken) {
                idleStrategyToRemove = idleStrategies[i];
                idleStrategies[i] = idleStrategies[idleStrategies.length - 1];
                idleStrategies.pop();
                if (
                    idleStrategies.length != 0 && i != idleStrategies.length
                        && idleStrategies[i].depositToken != batch.getSupportedTokens()[i]
                ) {
                    revert IdleStrategySupportedTokenMismatch();
                }
                break;
            }
        }

        if (IIdleStrategy(idleStrategyToRemove.strategyAddress).withdrawAll() != 0) {
            rebalanceStrategies(exchange, strategies, allStrategiesWeightSum, supportedTokensWithPricesWithRemovedToken);
        }
        Ownable(address(idleStrategyToRemove.strategyAddress)).transferOwnership(moderator);
    }

    /* ERRORS */

    error CycleNotClosed();
    error NotReceiptOwner();
    error IdleStrategySupportedTokenMismatch();
    error InvalidIdleStrategy();
    error InvalidIndexForIdleStrategy();
}
