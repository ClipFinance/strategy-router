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

    /// @dev Returns strategy weight as percent of total weight.
    function getStrategyPercentWeight(uint256 _strategyId, StrategyRouter.StrategyInfo[] storage strategies)
        internal
        view
        returns (uint256 strategyPercentAllocation)
    {
        uint256 totalStrategyWeight;
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            totalStrategyWeight += strategies[i].weight;
        }
        strategyPercentAllocation = (strategies[_strategyId].weight * PRECISION) / totalStrategyWeight;

        return strategyPercentAllocation;
    }

//    function rebalanceStrategies(Exchange exchange, StrategyRouter.StrategyInfo[] storage strategies)
//        public
//        returns (uint256[] memory balances)
//    {
//        uint256 totalBalance;
//
//        uint256 len = strategies.length;
//        if (len < 2) revert StrategyRouter.NothingToRebalance();
//        uint256[] memory _strategiesBalances = new uint256[](len);
//        address[] memory _strategiesTokens = new address[](len);
//        address[] memory _strategies = new address[](len);
//        for (uint256 i; i < len; i++) {
//            _strategiesTokens[i] = strategies[i].depositToken;
//            _strategies[i] = strategies[i].strategyAddress;
//            _strategiesBalances[i] = IStrategy(_strategies[i]).totalTokens();
//            totalBalance += toUniform(_strategiesBalances[i], _strategiesTokens[i]);
//        }
//
//        uint256[] memory toAdd = new uint256[](len);
//        uint256[] memory toSell = new uint256[](len);
//        for (uint256 i; i < len; i++) {
//            uint256 desiredBalance = (totalBalance * getStrategyPercentWeight(i, strategies)) / PRECISION;
//            desiredBalance = fromUniform(desiredBalance, _strategiesTokens[i]);
//            unchecked {
//                if (desiredBalance > _strategiesBalances[i]) {
//                    toAdd[i] = desiredBalance - _strategiesBalances[i];
//                } else if (desiredBalance < _strategiesBalances[i]) {
//                    toSell[i] = _strategiesBalances[i] - desiredBalance;
//                }
//            }
//        }
//
//        _rebalanceStrategies(len, exchange, toSell, toAdd, _strategiesTokens, _strategies);
//
//        for (uint256 i; i < len; i++) {
//            _strategiesBalances[i] = IStrategy(_strategies[i]).totalTokens();
//            totalBalance += toUniform(_strategiesBalances[i], _strategiesTokens[i]);
//        }
//
//        return _strategiesBalances;
//    }

//    function _rebalanceStrategies(
//        uint256 len,
//        Exchange exchange,
//        uint256[] memory toSell,
//        uint256[] memory toAdd,
//        address[] memory _strategiesTokens,
//        address[] memory _strategies
//    ) internal {
//        for (uint256 i; i < len; i++) {
//            for (uint256 j; j < len; j++) {
//                if (toSell[i] == 0) break;
//                if (toAdd[j] > 0) {
//                    address sellToken = _strategiesTokens[i];
//                    address buyToken = _strategiesTokens[j];
//                    uint256 sellUniform = toUniform(toSell[i], sellToken);
//                    uint256 addUniform = toUniform(toAdd[j], buyToken);
//                    // curSell should have sellToken decimals
//                    uint256 curSell = sellUniform > addUniform
//                        ? changeDecimals(addUniform, UNIFORM_DECIMALS, ERC20(sellToken).decimals())
//                        : toSell[i];
//
//                    if (sellUniform < REBALANCE_SWAP_THRESHOLD) {
//                        toSell[i] = 0;
//                        toAdd[j] -= changeDecimals(curSell, ERC20(sellToken).decimals(), ERC20(buyToken).decimals());
//                        break;
//                    }
//
//                    uint256 received = IStrategy(_strategies[i]).withdraw(curSell);
//                    received = trySwap(exchange, received, sellToken, buyToken);
//                    ERC20(buyToken).transfer(_strategies[j], received);
//                    IStrategy(_strategies[j]).deposit(received);
//
//                    toSell[i] -= curSell;
//                    toAdd[j] -= changeDecimals(curSell, ERC20(sellToken).decimals(), ERC20(buyToken).decimals());
//                }
//            }
//        }
//    }

    function rebalanceStrategies(
        Exchange exchange,
        StrategyRouter.StrategyInfo[] storage strategies,
        address[] memory supportedTokens
    )
    public
    returns (uint256[] memory balances)
    {
        uint256 totalBalance;

//        uint256 len = strategies.length;
        if (strategies.length < 2) revert StrategyRouter.NothingToRebalance();
        StrategyData[] memory strategyDatas = new StrategyData[](strategies.length);
//        uint256[] memory _strategiesBalances = new uint256[](strategies.length);
//        address[] memory _strategiesTokens = new address[](strategies.length);
//        address[] memory _strategies = new address[](strategies.length);
        for (uint256 i; i < strategies.length; i++) {
//        for (uint256 i; i < len; i++) {
            strategyDatas[i] = StrategyData({
                strategyAddress: strategies[i].strategyAddress,
                tokenAddress: strategies[i].depositToken,
                balance: IStrategy(strategies[i].strategyAddress).totalTokens()
            });
            totalBalance += toUniform(strategyDatas[i].balance, strategyDatas[i].tokenAddress);
        }

//        uint256 supportedTokensLen = supportedTokens.length;
//        uint256[] memory supportedTokenBalances = new uint256[](supportedTokens.length);
        SupportedTokenData[] memory supportedTokenDatas = new SupportedTokenData[](supportedTokens.length);
        for (uint256 i; i < supportedTokens.length; i++) {
//        for (uint256 i; i < supportedTokensLen; i++) {
//            supportedTokenBalances[i] = IERC20(supportedTokens[i]).balanceOf(address(this));
            supportedTokenDatas[i] = SupportedTokenData({
                tokenAddress: supportedTokens[i],
                balance: IERC20(supportedTokens[i]).balanceOf(address(this))
            });
//            uint256 supportedTokenBalance = IERC20(supportedTokens[i]).balanceOf(address(this));
            totalBalance += toUniform(supportedTokenDatas[i].balance, supportedTokens[i]);
        }

        uint256[] memory underflows = new uint256[](strategies.length);
        uint256[] memory overflows = new uint256[](strategies.length);
        console.log('totalBalance', totalBalance);
        for (uint256 i; i < strategies.length; i++) {
            uint256 desiredBalance = (totalBalance * getStrategyPercentWeight(i, strategies)) / PRECISION;
            desiredBalance = fromUniform(desiredBalance, strategyDatas[i].tokenAddress);
            unchecked {
                if (desiredBalance > strategyDatas[i].balance) {
                    underflows[i] = desiredBalance - strategyDatas[i].balance;
                } else if (desiredBalance < strategyDatas[i].balance) {
                    overflows[i] = strategyDatas[i].balance - desiredBalance;
                }
            }
            console.log('overflows', i, overflows[i]);
            console.log('underflows', i, underflows[i]);
            console.log('strategyDatas[i].balance', i, strategyDatas[i].balance);
        }

        _rebalanceStrategies(
            strategies.length,
            exchange,
            overflows,
            underflows,
            strategyDatas,
            supportedTokens.length,
            supportedTokenDatas
//            supportedTokenBalances
        );

        uint256[] memory _strategiesBalances = new uint256[](strategies.length);
        for (uint256 i; i < strategies.length; i++) {
            _strategiesBalances[i] = IStrategy(strategyDatas[i].strategyAddress).totalTokens();
            totalBalance += toUniform(_strategiesBalances[i], strategyDatas[i].tokenAddress);
        }

        return _strategiesBalances;
    }

    function _rebalanceStrategies(
        uint256 len,
        Exchange exchange,
        uint256[] memory overflows,
        uint256[] memory underflows,
        StrategyData[] memory strategyDatas,
        uint256 supportedTokensLen,
        SupportedTokenData[] memory supportedTokenDatas
//        uint256[] memory supportedTokenBalances
    ) internal {
        for (uint256 i; i < len; i++) {
            if (overflows[i] > 0) {
                uint256 overflowUniform = toUniform(overflows[i], strategyDatas[i].tokenAddress);
                if (overflowUniform < REBALANCE_SWAP_THRESHOLD) {
                    continue;
                }
                IStrategy(strategyDatas[i].strategyAddress).withdraw(overflows[i]);
//                console.log('balance', i, IStrategy(strategyDatas[i].tokenAddress).)
            }
        }

//        uint256[] memory supportedTokenBalances = new uint256[](supportedTokensLen);
        for (uint256 i; i < supportedTokensLen; i++) {
            //        for (uint256 i; i < supportedTokensLen; i++) {
//            supportedTokenBalances[i] = IERC20(supportedTokens[i]).balanceOf(address(this));
            supportedTokenDatas[i].balance = IERC20(supportedTokenDatas[i].tokenAddress).balanceOf(address(this));
//            totalBalance += toUniform(supportedTokenBalances[i], supportedTokens[i]);
        }

        for (uint256 i; i < len; i++) {
            if (underflows[i] > 0) {
                uint256 desiredDeposit = underflows[i];
                address underflowToken = strategyDatas[i].tokenAddress;
                uint256 underflowTokenBalance = IERC20(underflowToken).balanceOf(address(this));
                uint256 underflowUniform = toUniform(underflows[i], strategyDatas[i].tokenAddress);
                if (underflowTokenBalance < underflows[i]) {
                    for (uint256 j; j < supportedTokensLen; j++) {
                        if (underflowToken == supportedTokenDatas[j].tokenAddress) {
                            continue;
                        }
                        uint256 tokenBalanceUniform = toUniform(
                            supportedTokenDatas[j].balance,
                            supportedTokenDatas[j].tokenAddress
                        );
                        if (tokenBalanceUniform < REBALANCE_SWAP_THRESHOLD) {
                            continue;
                        }
                        uint256 received = tokenBalanceUniform > underflowUniform
                            ? fromUniform(underflowUniform, supportedTokenDatas[j].tokenAddress)
                            : supportedTokenDatas[j].balance;

                        console.log('underflowUniform', underflowUniform);
                        console.log('tokenBalanceUniform', tokenBalanceUniform);
                        console.log('supportedTokenDatas[j].balance', j, supportedTokenDatas[j].balance);
                        console.log('received', received);
                        console.log('true balance', IERC20(supportedTokenDatas[j].tokenAddress).balanceOf(address(this)));
                        supportedTokenDatas[j].balance -= received;
                        received = trySwap(exchange, received, supportedTokenDatas[j].tokenAddress, underflowToken);
                        underflows[i] -= received;
                        underflowTokenBalance += received;

                        if (underflowUniform < REBALANCE_SWAP_THRESHOLD) {
                            break;
                        }
                    }
                }

                if (desiredDeposit > underflowTokenBalance) {
                    desiredDeposit = underflowTokenBalance;
                }

                IERC20(underflowToken).transfer(strategyDatas[i].strategyAddress, desiredDeposit);
                IStrategy(strategyDatas[i].strategyAddress).deposit(desiredDeposit);
            }
        }

        // @dev temporal solution until idle strategies arrive, then leftovers will be deposited there
        for (uint256 j; j < supportedTokensLen; j++) {
            uint256 tokenBalance = IERC20(supportedTokenDatas[j].tokenAddress).balanceOf(address(this));
            if (tokenBalance > 0) {
                for (uint256 i; i < len; i++) {
                    if (supportedTokenDatas[j].tokenAddress == strategyDatas[i].tokenAddress) {
                        tokenBalance = 0;
                        IERC20(supportedTokenDatas[j].tokenAddress)
                            .transfer(strategyDatas[i].strategyAddress, tokenBalance);
                        IStrategy(strategyDatas[i].strategyAddress).deposit(tokenBalance);
                        break;
                    }
                }
                if (tokenBalance > 0) {
                    tokenBalance = trySwap(
                        exchange,
                        tokenBalance,
                        strategyDatas[0].tokenAddress,
                        supportedTokenDatas[j].tokenAddress
                    );
                    IERC20(strategyDatas[0].tokenAddress).transfer(strategyDatas[0].strategyAddress, tokenBalance);
                    IStrategy(strategyDatas[0].strategyAddress).deposit(tokenBalance);
                }
            }
        }
    }
}
