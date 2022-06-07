//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import "./ReceiptNFT.sol";
import "./Exchange.sol";
import "./SharesToken.sol";
import "./Batching.sol";
import "./StrategyRouterLib.sol";

// import "hardhat/console.sol";

contract StrategyRouter is Ownable {
    /* EVENTS */

    /// @notice Fires when user deposits in batching.
    /// @param token Supported token that user want to deposit.
    /// @param amount Amount of `token` transferred from user.
    event Deposit(address indexed user, address token, uint256 amount);
    /// @notice Fires when batching is deposited into strategies.
    /// @param closedCycleId Index of the cycle that is closed.
    /// @param amount Sum of different tokens deposited into strategies.
    event DepositToStrategies(uint256 indexed closedCycleId, uint256 amount);
    /// @notice Fires when user withdraw from batching.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromBatching(
        address indexed user,
        address token,
        uint256 amount
    );
    /// @notice Fires when user withdraw from strategies.
    /// @param token Supported token that user requested to receive after withdraw.
    /// @param amount Amount of `token` received by user.
    event WithdrawFromStrategies(
        address indexed user,
        address token,
        uint256 amount
    );
    /// @notice Fires when user converts his receipt into shares token.
    /// @param receiptId Index of the receipt to burn.
    /// @param shares Amount of shares received by user.
    event UnlockShares(address indexed user, uint256 receiptId, uint256 shares);

    /* ERRORS */

    error UnsupportedToken();
    error NotReceiptOwner();
    error CycleNotClosed();
    error CycleClosed();
    error InsufficientShares();
    error DuplicateStrategy();
    error CycleNotClosableYet();
    error AmountNotSpecified();
    error CantCrossWithdrawFromStrategiesNow();
    error CantRemoveLastStrategy();
    error NothingToRebalance();
    // error InitialSharesAreUnwithdrawable();

    struct StrategyInfo {
        address strategyAddress;
        address depositToken;
        uint256 weight;
    }

    struct Cycle {
        uint256 startAt;
        uint256 pricePerShare;
        // usd value transferred into strategies
        uint256 totalDeposited;
        // actual usd value received by strategies
        uint256 receivedByStrategies;
        // cross withdrawn amount from batching by strategy receipt
        uint256 strategiesDebtInShares;
        mapping(address => uint256) prices;
        address[] tokens;
    }

    uint8 private constant UNIFORM_DECIMALS = 18;
    // used in rebalance function, UNIFORM_DECIMALS, so 1e17 == 0.1
    uint256 private constant REBALANCE_SWAP_THRESHOLD = 1e17;
    uint256 private constant INITIAL_SHARES = 1e12;
    address private constant DEAD_ADDRESS =
        0x000000000000000000000000000000000000dEaD;

    uint256 public cycleDuration = 1 days;
    uint256 public minUsdPerCycle;
    uint256 public minDeposit;
    uint256 public feePercent;
    uint256 public currentCycleId;

    ReceiptNFT public receiptContract;
    Exchange public exchange;
    IUsdOracle public oracle;
    SharesToken public sharesToken;
    Batching public batching;
    address public feeAddress;

    StrategyInfo[] public strategies;
    mapping(uint256 => Cycle) public cycles;

    constructor(address _exchange, address _oracle) {
        sharesToken = new SharesToken();
        batching = new Batching(address(this));
        receiptContract = new ReceiptNFT(address(this), address(batching));
        batching.setExchange(_exchange);
        batching.setOracle(_oracle);
        batching.setReceiptNFT(address(receiptContract));
        cycles[0].startAt = block.timestamp;
    }

    // Universal Functions

    /// @notice Deposit money collected in the batching into strategies.
    /// @notice Can be called when `cycleDuration` seconds has been passed or
    ///         batch usd value has reached `minUsdPerCycle`.
    /// @dev Only callable by user wallets.
    function depositToStrategies() external {
        uint256 _currentCycleId = currentCycleId;
        (uint256 totalValue, ) = getBatchingValue();
        uint256 strategiesDebtInShares = cycles[_currentCycleId].strategiesDebtInShares;
        uint256 strategiesDebtValue;
        if (strategiesDebtInShares > 0)
            strategiesDebtValue = sharesToUsd(strategiesDebtInShares);

        if (
            cycles[_currentCycleId].startAt + cycleDuration > block.timestamp &&
            totalValue + strategiesDebtValue < minUsdPerCycle
        ) revert CycleNotClosableYet();

        // save current supported tokens and their prices
        {
            address[] memory tokens = getSupportedTokens();
            for (uint256 i = 0; i < tokens.length; i++) {
                if (ERC20(tokens[i]).balanceOf(address(batching)) > 0) {
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getTokenUsdPrice(tokens[i]);
                    cycles[_currentCycleId].prices[
                        tokens[i]
                    ] = StrategyRouterLib.changeDecimals(
                        price,
                        priceDecimals,
                        UNIFORM_DECIMALS
                    );
                    // cycles[_currentCycleId].prices[tokens[i]] = changeDecimals(
                    //     price,
                    //     priceDecimals,
                    //     UNIFORM_DECIMALS
                    // );
                }
            }
        }

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            // trigger compound on strategy
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // get total strategies value after compound
        (uint256 balanceAfterCompound, ) = getStrategiesValue();
        // rebalance tokens in batching and get new balances
        uint256[] memory depositAmounts = batching.rebalance();

        // uint256 totalValueDeposited;
        for (uint256 i; i < len; i++) {
            address strategyDepositToken = strategies[i].depositToken;

            if (depositAmounts[i] > 0) {
                // calculate total usd deposited in strategies
                (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(
                    strategyDepositToken
                );

                // transfer tokens from batching into strategies
                batching.transfer(
                    strategyDepositToken,
                    strategies[i].strategyAddress,
                    depositAmounts[i]
                );

                IStrategy(strategies[i].strategyAddress).deposit(
                    depositAmounts[i]
                );
            }
        }

        // get total strategies balance after deposit
        (uint256 balanceAfterDeposit, ) = getStrategiesValue();
        uint256 receivedByStrategies = balanceAfterDeposit - balanceAfterCompound;

        uint256 totalShares = sharesToken.totalSupply();
        if (totalShares == 0) {
            sharesToken.mint(DEAD_ADDRESS, INITIAL_SHARES);
            cycles[_currentCycleId].pricePerShare =
                balanceAfterDeposit /
                sharesToken.totalSupply();
        } else {
            cycles[_currentCycleId].pricePerShare =
                balanceAfterCompound /
                totalShares;

            uint256 newShares = receivedByStrategies /
                cycles[_currentCycleId].pricePerShare;
            sharesToken.mint(address(this), newShares);
        }

        cycles[_currentCycleId].receivedByStrategies =
            receivedByStrategies +
            strategiesDebtValue;
        cycles[_currentCycleId].totalDeposited = totalValue + strategiesDebtValue;

        emit DepositToStrategies(_currentCycleId, receivedByStrategies);
        // start new cycle
        currentCycleId++;
        cycles[_currentCycleId + 1].startAt = block.timestamp;
    }

    /// @notice Compound all strategies.
    /// @dev Only callable by user wallets.
    function compoundAll() external {
        if (sharesToken.totalSupply() == 0) revert();

        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }
    }

    /// @dev Returns list of supported tokens.
    function getSupportedTokens() public view returns (address[] memory) {
        return batching.getSupportedTokens();
    }

    /// @dev Returns strategy weight as percent of total weight.
    function getStrategyPercentWeight(uint256 _strategyId)
        public
        view
        returns (uint256 strategyPercentAllocation)
    {
        uint256 totalStrategyWeight;
        uint256 len = strategies.length;
        for (uint256 i; i < len; i++) {
            totalStrategyWeight += strategies[i].weight;
        }
        strategyPercentAllocation =
            (strategies[_strategyId].weight * 1e18) /
            totalStrategyWeight;

        return strategyPercentAllocation;
    }

    /// @notice Returns count of strategies.
    function getStrategiesCount() public view returns (uint256 count) {
        return strategies.length;
    }

    /// @notice Returns array of strategies.
    function getStrategies() public view returns (StrategyInfo[] memory) {
        return strategies;
    }

    /// @notice Returns deposit token of the strategy.
    function getStrategyDepositToken(uint256 i) public view returns (address) {
        return strategies[i].depositToken;
    }

    /// @notice Returns usd value of the token balances and their sum in the strategies.
    /// @notice All returned amounts have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total batching usd value.
    /// @return balances Array of usd value of token balances in the batching.
    function getStrategiesValue()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        (totalBalance, balances) = StrategyRouterLib.getStrategiesValue(
            oracle,
            strategies
        );
    }

    /// @notice Returns usd values of the tokens balances and their sum in the batching.
    /// @notice All returned amounts have `UNIFORM_DECIMALS` decimals.
    /// @return totalBalance Total batching usd value.
    /// @return balances Array of usd value of token balances in the batching.
    function getBatchingValue()
        public
        view
        returns (uint256 totalBalance, uint256[] memory balances)
    {
        return batching.getBatchingValue();
    }

    /// @notice Returns amount of shares locked by multiple receipts.
    /// @notice Cycle noted in receipts should be closed.
    function receiptsToShares(uint256[] calldata receiptIds)
        public
        view
        returns (uint256 shares)
    {
        ReceiptNFT _receiptContract = receiptContract;
        uint256 _currentCycleId = currentCycleId;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            shares += StrategyRouterLib.receiptToShares(
                _receiptContract,
                cycles,
                _currentCycleId,
                receiptId
            );
        }
    }

    /// @notice Returns usd value of shares.
    /// @dev Returned amount has `UNIFORM_DECIMALS` decimals.
    function sharesToUsd(uint256 shares)
        public
        view
        returns (uint256 amount)
    {
        (uint256 strategiesBalance, ) = getStrategiesValue();
        uint256 currentPricePerShare = strategiesBalance /
            sharesToken.totalSupply();
        amount = shares * currentPricePerShare;
    }

    /// @notice Returns shares equivalent of the usd vulue.
    /// @dev Returned amount has `UNIFORM_DECIMALS` decimals.
    function usdToShares(uint256 amount)
        public
        view
        returns (uint256 shares)
    {
        (uint256 strategiesBalance, ) = getStrategiesValue();
        uint256 currentPricePerShare = strategiesBalance /
            sharesToken.totalSupply();
        shares = amount / currentPricePerShare;
    }

    /// @notice Returns whether this token is supported.
    /// @param tokenAddress Address to lookup.
    function supportsToken(address tokenAddress)
        public
        view
        returns (bool isSupported)
    {
        return batching.supportsToken(tokenAddress);
    }

    // User Functions

    /// @notice Convert receipts into share tokens. Withdraw functions doing it internally.
    /// @notice Cycle noted in receipt should be closed.
    function unlockShares(uint256[] calldata receiptIds)
        public
                returns (uint256 shares)
    {
        shares = _unlockShares(receiptIds);
        sharesToken.transfer(msg.sender, shares);
    }

    /// @notice Withdraw tokens from strategies while receipts are in strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice If not enough shares unlocked from receipt, more will be taken from user.
    /// @notice Receipts are burned.
    /// @param receiptIds ReceiptNFTs ids.
    /// @param withdrawToken Supported token that user wish to receive.
    /// @param shares Amount of shares to withdraw.
    /// @dev Only callable by user wallets.
    function withdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 shares
    ) external {
        if (shares == 0) revert AmountNotSpecified();
        if (supportsToken(withdrawToken) == false)
            revert UnsupportedToken();

        uint256 unlockedShares = _unlockShares(receiptIds);

        if (unlockedShares > shares) {
            // leftover shares -> send to user
            sharesToken.transfer(msg.sender, unlockedShares - shares);
        } else if (unlockedShares < shares) {
            // lack of shares -> get from user
            sharesToken.routerTransferFrom(
                msg.sender,
                address(this),
                shares - unlockedShares
            );
        }

        // shares into usd using current PPS
        uint256 valueToWithdraw = sharesToUsd(shares);
        sharesToken.burn(address(this), shares);
        _withdrawFromStrategies(valueToWithdraw, withdrawToken);
    }

    /// @notice Withdraw tokens from strategies while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @notice Only allowed to withdraw less or equal to strategiesDebtInShares.
    /// @param receiptIds ReceiptNFT ids.
    /// @param withdrawToken Supported token that user wish to receive.
    /// @param amounts Amounts to withdraw from each passed receipt.
    /// @dev Only callable by user wallets.
    function crossWithdrawFromStrategies(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256[] calldata amounts
    ) public {
        if (supportsToken(withdrawToken) == false)
            revert UnsupportedToken();

        uint256 _currentCycleId = currentCycleId;
        uint256 toWithdraw;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != msg.sender)
                revert NotReceiptOwner();

            ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(
                receiptId
            );
            // only for receipts in batching
            if (receipt.cycleId != _currentCycleId) revert CycleClosed();

            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(
                receipt.token
            );

            if (amounts[i] >= receipt.amount || amounts[i] == 0) {
                uint256 receiptValue = ((receipt.amount * price) /
                    10**priceDecimals);
                toWithdraw += receiptValue;
                receiptContract.burn(receiptId);
            } else {
                uint256 amountValue = ((amounts[i] * price) /
                    10**priceDecimals);
                toWithdraw += amountValue;
                receiptContract.setAmount(
                    receiptId,
                    receipt.amount - amounts[i]
                );
            }
        }

        uint256 sharesToRepay = usdToShares(toWithdraw);
        if (cycles[_currentCycleId].strategiesDebtInShares < sharesToRepay)
            revert CantCrossWithdrawFromStrategiesNow();
        _withdrawFromStrategies(toWithdraw, withdrawToken);
        cycles[_currentCycleId].strategiesDebtInShares -= sharesToRepay;
    }

    /// @notice Withdraw tokens from strategies by shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported token that user wish to receive.
    function withdrawShares(uint256 shares, address withdrawToken)
        public
            {
        if (sharesToken.balanceOf(msg.sender) < shares)
            revert InsufficientShares();
        if (supportsToken(withdrawToken) == false)
            revert UnsupportedToken();

        uint256 amount = sharesToUsd(shares);
        sharesToken.burn(msg.sender, shares);
        _withdrawFromStrategies(amount, withdrawToken);
    }

    /// @notice Withdraw tokens from batching by shares.
    /// @param shares Amount of shares to withdraw.
    /// @param withdrawToken Supported token that user wish to receive.
    function crossWithdrawShares(uint256 shares, address withdrawToken)
        public
            {
        if (sharesToken.balanceOf(msg.sender) < shares)
            revert InsufficientShares();
        if (supportsToken(withdrawToken) == false)
            revert UnsupportedToken();

        uint256 amount = sharesToUsd(shares);
        // these shares will be owned by depositors of the current batching
        sharesToken.routerTransferFrom(msg.sender, address(this), shares);
        _withdrawFromBatching(amount, withdrawToken);
        cycles[currentCycleId].strategiesDebtInShares += shares;
    }

    /// @notice Withdraw tokens from batching while receipts are in batching.
    /// @notice On partial withdraw the receipt that partly fullfills requested amount will be updated.
    /// @notice Receipt is burned if withdraw whole amount noted in it.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported token that user wish to receive.
    /// @param amounts Amounts to withdraw from each passed receipt.
    /// @dev Only callable by user wallets.
    function withdrawFromBatching(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256[] calldata amounts
    ) public {
        batching.withdraw(msg.sender, receiptIds, withdrawToken, amounts);
    }

    /// @notice Withdraw tokens from batching while receipts are in strategies.
    /// @notice On partial withdraw leftover shares transferred to user.
    /// @notice Receipts are burned.
    /// @param receiptIds Receipt NFTs ids.
    /// @param withdrawToken Supported token that user wish to receive.
    /// @param shares Amount of shares from receipts to withdraw.
    /// @dev Only callable by user wallets.
    function crossWithdrawFromBatching(
        uint256[] calldata receiptIds,
        address withdrawToken,
        uint256 shares
    ) external {
        if (shares == 0) revert AmountNotSpecified();
        if (supportsToken(withdrawToken) == false)
            revert UnsupportedToken();

        uint256 unlockedShares = _unlockShares(receiptIds);
        if (unlockedShares > shares) {
            // leftover shares -> send to user
            sharesToken.transfer(msg.sender, unlockedShares - shares);
        } else if (unlockedShares < shares) {
            // lack of shares -> get from user
            sharesToken.routerTransferFrom(
                msg.sender,
                address(this),
                shares - unlockedShares
            );
        }

        uint256 valueToWithdraw = sharesToUsd(shares);

        _withdrawFromBatching(valueToWithdraw, withdrawToken);
        cycles[currentCycleId].strategiesDebtInShares += shares;
    }

    /// @notice Allows to withdraw tokens from batching and from strategies at the same time.
    /// @notice It also can cross withdraw if possible.
    /// @notice This function internally rely on the other withdraw functions, thus inherit some bussines logic.
    /// @param receiptIdsBatch ReceiptNFTs ids from batching.
    /// @param receiptIdsStrats ReceiptNFTs ids from strategies.
    /// @param withdrawToken Supported token that user wish to receive.
    /// @param amounts Amounts to withdraw from each passed receipt.
    /// @param shares Amount of shares to withdraw.
    /// @dev Only callable by user wallets.
    function withdrawUniversal(
        uint256[] calldata receiptIdsBatch,
        uint256[] calldata receiptIdsStrats,
        address withdrawToken,
        uint256[] calldata amounts,
        uint256 shares
    ) external {
        if (supportsToken(withdrawToken) == false)
            revert UnsupportedToken();

        uint256 fromBatchAmount;
        uint256 _currentCycleId = currentCycleId;
        for (uint256 i = 0; i < receiptIdsBatch.length; i++) {
            uint256 receiptId = receiptIdsBatch[i];
            ReceiptNFT.ReceiptData memory receipt = receiptContract.getReceipt(
                receiptId
            );
            (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(
                receipt.token
            );

            if (amounts[i] >= receipt.amount || amounts[i] == 0) {
                // withdraw whole receipt and burn receipt
                uint256 receiptValue = ((receipt.amount * price) /
                    10**priceDecimals);
                fromBatchAmount += receiptValue;
                receiptContract.burn(receiptId);
            } else {
                // withdraw only part of receipt and update receipt
                uint256 amountValue = ((amounts[i] * price) /
                    10**priceDecimals);
                fromBatchAmount += amountValue;
                receiptContract.setAmount(
                    receiptId,
                    receipt.amount - amounts[i]
                );
            }
        }

        if (fromBatchAmount > 0) {
            (uint256 totalBalance, ) = getBatchingValue();

            if (fromBatchAmount <= totalBalance) {
                // withdraw 100% from batching
                _withdrawFromBatching(fromBatchAmount, withdrawToken);
            } else {
                // withdraw as much as can from batching, then cross withdraw from strategies whatever left
                if (totalBalance > 0) {
                    _withdrawFromBatching(fromBatchAmount, withdrawToken);
                    fromBatchAmount -= totalBalance;
                }
                uint256 sharesToRepay = usdToShares(fromBatchAmount);
                if (cycles[_currentCycleId].strategiesDebtInShares < sharesToRepay)
                    revert CantCrossWithdrawFromStrategiesNow();
                _withdrawFromStrategies(fromBatchAmount, withdrawToken);
                cycles[_currentCycleId].strategiesDebtInShares -= sharesToRepay;
            }
        }

        // shares related code
        if (shares == 0) return;

        uint256 unlockedShares = _unlockShares(receiptIdsStrats);
        sharesToken.transfer(msg.sender, unlockedShares);
        // if user trying to withdraw more than he have, don't allow
        uint256 sharesBalance = sharesToken.balanceOf(msg.sender);
        if (sharesBalance < shares) shares = sharesBalance;

        uint256 fromStratsAmount = sharesToUsd(shares);

        (uint256 totalBalance, ) = getBatchingValue();

        if (fromStratsAmount <= totalBalance) {
            crossWithdrawShares(shares, withdrawToken);
        } else {
            if (totalBalance > 0) {
                uint256 _withdrawShares = (shares * totalBalance) /
                    fromStratsAmount;
                shares -= _withdrawShares;
                uint256 _withdrawAmount = sharesToUsd(_withdrawShares);
                sharesToken.burn(msg.sender, _withdrawShares);
                _withdrawFromBatching(_withdrawAmount, withdrawToken);
                cycles[currentCycleId].strategiesDebtInShares += _withdrawShares;
            }
            if (shares > 0) withdrawShares(shares, withdrawToken);
        }
    }

    /// @notice Deposit token into batching. dApp already asked user to approve spending of the token
    /// and we have allowance to transfer these funds to Batching smartcontract
    /// @notice Tokens not deposited into strategies immediately.
    /// @param depositToken Supported token to deposit.
    /// @param _amount Amount to deposit.
    /// @dev User should approve `_amount` of `depositToken` to this contract.
    /// @dev Only callable by user wallets.
    function depositToBatch(address depositToken, uint256 _amount)
        external
            {
        batching.deposit(msg.sender, depositToken, _amount);
        IERC20(depositToken).transferFrom(
            msg.sender,
            address(batching),
            _amount
        );
    }

    // Admin functions


    /// @notice Set token as supported for user deposit and withdraw.
    /// @dev Admin function.
    function setSupportedToken(address tokenAddress, bool supported)
        external
        onlyOwner
    {
        batching.setSupportedToken(tokenAddress, supported);
    }

    /// @notice Set address of oracle contract.
    /// @dev Admin function.
    function setOracle(address _oracle) external onlyOwner {
        oracle = IUsdOracle(_oracle);
        batching.setOracle(_oracle);
    }

    /// @notice Set address of ReceiptNFT contract.
    /// @dev Admin function.
    function setReceiptNFT(address  _receiptContract) external onlyOwner {
        receiptContract = ReceiptNFT(_receiptContract);
        batching.setReceiptNFT(_receiptContract);
    }

    /// @notice Set address of exchange contract.
    /// @dev Admin function.
    function setExchange(address newExchange) external onlyOwner {
        exchange = Exchange(newExchange);
        batching.setExchange(newExchange);
    }

    /// @notice Set address for collecting fees from rewards.
    /// @dev Admin function.
    function setFeeAddress(address _feeAddress) external onlyOwner {
        if (_feeAddress == address(0)) revert();
        feeAddress = _feeAddress;
    }

    /// @notice Set percent to take of rewards for owners.
    /// @dev Admin function.
    function setFeePercent(uint256 percent) external onlyOwner {
        feePercent = percent;
    }

    /// @notice Minimum usd needed to be able to close the cycle.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinUsdPerCycle(uint256 amount) external onlyOwner {
        minUsdPerCycle = amount;
    }

    /// @notice Minimum to be deposited in the batching.
    /// @param amount Amount of usd, must be `UNIFORM_DECIMALS` decimals.
    /// @dev Admin function.
    function setMinDeposit(uint256 amount) external onlyOwner {
        batching.setMinDeposit(amount);
    }

    /// @notice Minimum time needed to be able to close the cycle.
    /// @param duration Duration of cycle in seconds.
    /// @dev Admin function.
    function setCycleDuration(uint256 duration) external onlyOwner {
        cycleDuration = duration;
    }

    /// @notice Add strategy.
    /// @param _strategyAddress Address of the strategy.
    /// @param _depositTokenAddress Token to be deposited into strategy.
    /// @param _weight Weight of the strategy. Used to split user deposit between strategies.
    /// @dev Admin function.
    /// @dev Deposit token must be supported by the router.
    function addStrategy(
        address _strategyAddress,
        address _depositTokenAddress,
        uint256 _weight
    ) external onlyOwner {
        if (!supportsToken(_depositTokenAddress)) revert UnsupportedToken();
        uint256 len = strategies.length;
        for (uint256 i = 0; i < len; i++) {
            if (strategies[i].strategyAddress == _strategyAddress)
                revert DuplicateStrategy();
        }

        strategies.push(
            StrategyInfo({
                strategyAddress: _strategyAddress,
                depositToken: IStrategy(_strategyAddress).depositToken(),
                weight: _weight
            })
        );
    }

    /// @notice Update strategy weight.
    /// @param _strategyId Id of the strategy.
    /// @param _weight Weight of the strategy.
    /// @dev Admin function.
    function updateStrategy(uint256 _strategyId, uint256 _weight)
        external
        onlyOwner
    {
        strategies[_strategyId].weight = _weight;
    }

    /// @notice Remove strategy, deposit its balance in other strategies.
    /// @param _strategyId Id of the strategy.
    /// @dev Admin function.
    function removeStrategy(uint256 _strategyId) external onlyOwner {
        if (strategies.length < 2) revert CantRemoveLastStrategy();
        StrategyInfo memory removedStrategyInfo = strategies[_strategyId];
        IStrategy removedStrategy = IStrategy(
            removedStrategyInfo.strategyAddress
        );
        address removedDepositToken = removedStrategyInfo.depositToken;

        uint256 len = strategies.length - 1;
        strategies[_strategyId] = strategies[len];
        strategies.pop();

        // compound removed strategy
        removedStrategy.compound();

        // withdraw all from removed strategy
        uint256 withdrawnAmount = removedStrategy.withdrawAll();

        // compound all strategies
        for (uint256 i; i < len; i++) {
            IStrategy(strategies[i].strategyAddress).compound();
        }

        // deposit withdrawn funds into other strategies
        for (uint256 i; i < len; i++) {
            uint256 depositAmount = (withdrawnAmount *
                getStrategyPercentWeight(i)) / 1e18;
            address strategyDepositToken = strategies[i].depositToken;

            depositAmount = StrategyRouterLib.trySwap(
                exchange,
                depositAmount,
                removedDepositToken,
                strategyDepositToken
            );
            IERC20(strategyDepositToken).transfer(
                strategies[i].strategyAddress,
                depositAmount
            );
            IStrategy(strategies[i].strategyAddress).deposit(depositAmount);
        }
        Ownable(address(removedStrategy)).transferOwnership(msg.sender);
    }

    /// @notice Rebalance batching, so that token balances will match strategies weight.
    /// @return balances Amounts to be deposited in strategies, balanced according to strategies weights.
    function rebalanceBatching()
        external
        onlyOwner
        returns (uint256[] memory balances)
    {
        return batching.rebalance();
    }

    /// @notice Rebalance strategies, so that their balances will match their weights.
    /// @return balances Balances of the strategies after rebalancing.
    /// @dev Admin function.
    function rebalanceStrategies()
        external
        onlyOwner
        returns (uint256[] memory balances)
    {
        uint256 totalBalance;

        uint256 len = strategies.length;
        if (len < 2) revert NothingToRebalance();
        uint256[] memory _strategiesBalances = new uint256[](len);
        address[] memory _strategiesTokens = new address[](len);
        address[] memory _strategies = new address[](len);
        for (uint256 i; i < len; i++) {
            _strategiesTokens[i] = strategies[i].depositToken;
            _strategies[i] = strategies[i].strategyAddress;
            _strategiesBalances[i] = IStrategy(_strategies[i]).totalTokens();
            totalBalance += StrategyRouterLib.toUniform(
                _strategiesBalances[i],
                _strategiesTokens[i]
            );
        }

        uint256[] memory toAdd = new uint256[](len);
        uint256[] memory toSell = new uint256[](len);
        for (uint256 i; i < len; i++) {
            uint256 desiredBalance = (totalBalance *
                getStrategyPercentWeight(i)) / 1e18;
            desiredBalance = StrategyRouterLib.fromUniform(
                desiredBalance,
                _strategiesTokens[i]
            );
            unchecked {
                if (desiredBalance > _strategiesBalances[i]) {
                    toAdd[i] = desiredBalance - _strategiesBalances[i];
                } else if (desiredBalance < _strategiesBalances[i]) {
                    toSell[i] = _strategiesBalances[i] - desiredBalance;
                }
            }
        }

        for (uint256 i; i < len; i++) {
            for (uint256 j; j < len; j++) {
                if (toSell[i] == 0) break;
                if (toAdd[j] > 0) {
                    address sellToken = _strategiesTokens[i];
                    address buyToken = _strategiesTokens[j];
                    uint256 sellUniform = StrategyRouterLib.toUniform(
                        toSell[i],
                        sellToken
                    );
                    uint256 addUniform = StrategyRouterLib.toUniform(
                        toAdd[j],
                        buyToken
                    );
                    // curSell should have sellToken decimals
                    uint256 curSell = sellUniform > addUniform
                        ? StrategyRouterLib.changeDecimals(
                            addUniform,
                            UNIFORM_DECIMALS,
                            ERC20(sellToken).decimals()
                        )
                        : toSell[i];

                    if (sellUniform < REBALANCE_SWAP_THRESHOLD) {
                        unchecked {
                            toSell[i] = 0;
                            toAdd[j] -= StrategyRouterLib.changeDecimals(
                                curSell,
                                ERC20(sellToken).decimals(),
                                ERC20(buyToken).decimals()
                            );
                        }
                        break;
                    }

                    uint256 received = IStrategy(_strategies[i]).withdraw(
                        curSell
                    );
                    received = StrategyRouterLib.trySwap(
                        exchange,
                        received,
                        sellToken,
                        buyToken
                    );
                    ERC20(buyToken).transfer(_strategies[j], received);
                    IStrategy(_strategies[j]).deposit(received);

                    unchecked {
                        toSell[i] -= curSell;
                        toAdd[j] -= StrategyRouterLib.changeDecimals(
                            curSell,
                            ERC20(sellToken).decimals(),
                            ERC20(buyToken).decimals()
                        );
                    }
                }
            }
        }

        for (uint256 i; i < len; i++) {
            _strategiesBalances[i] = IStrategy(_strategies[i]).totalTokens();
            totalBalance += StrategyRouterLib.toUniform(
                _strategiesBalances[i],
                _strategiesTokens[i]
            );
        }

        return _strategiesBalances;
    }

    // Internals

    /// @param valueToWithdraw USD value to withdraw.
    function _withdrawFromBatching(
        uint256 valueToWithdraw,
        address withdrawToken
    ) private {
        batching._withdraw(msg.sender, valueToWithdraw, withdrawToken);
    }

    /// @param valueToWithdraw USD value to withdraw.
    function _withdrawFromStrategies(
        uint256 valueToWithdraw,
        address withdrawToken
    ) private {
        (
            uint256 strategiesBalance,
            uint256[] memory balances
        ) = getStrategiesValue();
        uint256 len = strategies.length;

        uint256 amountToTransfer;
        // try withdraw requested token directly
        for (uint256 i; i < len; i++) {
            if (
                strategies[i].depositToken == withdrawToken &&
                balances[i] >= valueToWithdraw
            ) {
                (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(
                    withdrawToken
                );
                amountToTransfer =
                    (valueToWithdraw * 10**priceDecimals) /
                    price;
                amountToTransfer = StrategyRouterLib.fromUniform(
                    amountToTransfer,
                    withdrawToken
                );
                amountToTransfer = IStrategy(strategies[i].strategyAddress)
                    .withdraw(amountToTransfer);
                valueToWithdraw = 0;
                break;
            }
        }

        // try withdraw token which balance is enough to do only 1 swap
        if (valueToWithdraw != 0) {
            for (uint256 i; i < len; i++) {
                if (balances[i] >= valueToWithdraw) {
                    address token = strategies[i].depositToken;
                    (uint256 price, uint8 priceDecimals) = oracle
                        .getTokenUsdPrice(token);
                    amountToTransfer =
                        (valueToWithdraw * 10**priceDecimals) /
                        price;
                    amountToTransfer = StrategyRouterLib.fromUniform(
                        amountToTransfer,
                        token
                    );
                    amountToTransfer = IStrategy(strategies[i].strategyAddress)
                        .withdraw(amountToTransfer);
                    amountToTransfer = StrategyRouterLib.trySwap(
                        exchange,
                        amountToTransfer,
                        token,
                        withdrawToken
                    );
                    valueToWithdraw = 0;
                    break;
                }
            }
        }

        // swap different tokens until withraw amount is fulfilled
        if (valueToWithdraw != 0) {
            for (uint256 i; i < len; i++) {
                address token = strategies[i].depositToken;
                uint256 toSwap;
                (uint256 price, uint8 priceDecimals) = oracle.getTokenUsdPrice(
                    token
                );

                toSwap = balances[i] < valueToWithdraw
                    ? balances[i]
                    : valueToWithdraw;
                unchecked {
                    valueToWithdraw -= toSwap;
                }
                // convert usd value into token amount
                toSwap = (toSwap * 10**priceDecimals) / price;
                // adjust decimals of the token amount
                toSwap = StrategyRouterLib.fromUniform(toSwap, token);
                toSwap = IStrategy(strategies[i].strategyAddress).withdraw(
                    toSwap
                );
                // swap for requested token
                amountToTransfer += StrategyRouterLib.trySwap(
                    exchange,
                    toSwap,
                    token,
                    withdrawToken
                );
                if(valueToWithdraw == 0) break;
            }
        }

        IERC20(withdrawToken).transfer(msg.sender, amountToTransfer);
        emit WithdrawFromStrategies(
            msg.sender,
            withdrawToken,
            amountToTransfer
        );
    }

    /// burn receipts and return amount of freed shares.
    function _unlockShares(uint256[] calldata receiptIds)
        private
        returns (uint256 shares)
    {
        ReceiptNFT _receiptContract = receiptContract;
        uint256 _currentCycleId = currentCycleId;
        for (uint256 i = 0; i < receiptIds.length; i++) {
            uint256 receiptId = receiptIds[i];
            if (receiptContract.ownerOf(receiptId) != msg.sender)
                revert NotReceiptOwner();
            shares += StrategyRouterLib.receiptToShares(
                _receiptContract,
                cycles,
                _currentCycleId,
                receiptId
            );
            receiptContract.burn(receiptId);
            emit UnlockShares(msg.sender, receiptId, shares);
        }
    }
}
