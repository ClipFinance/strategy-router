# Solidity API

## StrategyRouter

### onlyWhitelisted

```solidity
modifier onlyWhitelisted()
```

Restrict msg.sender to be externally owned accounts only.

### UNIFORM_DECIMALS

```solidity
uint8 UNIFORM_DECIMALS
```

We adjust tokens amounts to have uniform number of decimals where needed for calculations.

### cycleDuration

```solidity
uint256 cycleDuration
```

Minimum time needed before depositing batching balance into strategies.

### minUsdPerCycle

```solidity
uint256 minUsdPerCycle
```

Minimum batching balance to be deposited into strategies.

### minDeposit

```solidity
uint256 minDeposit
```

Minimum amount to be deposited into batching by the user.

### cycles

```solidity
mapping(uint256 &#x3D;&gt; struct StrategyRouter.Cycle) cycles
```

Contains info such as how much were deposited into strategies or price per share in each cycle.

### allocateToStrategies

```solidity
function allocateToStrategies() external
```

Deposit money collected in the batching into strategies.
Can be called when &#x60;cycleDuration&#x60; seconds has been passed or
        batch has reached &#x60;minUsdPerCycle&#x60; amount of coins.

_Only callable by user wallets._

### compoundAll

```solidity
function compoundAll() external
```

Compound all strategies.

_Only callable by user wallets._

### getSupportedTokens

```solidity
function getSupportedTokens() public view returns (address[])
```

_Returns list of supported tokens._

### getStrategyPercentWeight

```solidity
function getStrategyPercentWeight(uint256 _strategyId) public view returns (uint256 strategyPercentAllocation)
```

_Returns strategy weight as percent of total weight._

### getStrategiesCount

```solidity
function getStrategiesCount() public view returns (uint256 count)
```

Returns count of strategies.

### getStrategies

```solidity
function getStrategies() public view returns (struct StrategyRouter.StrategyInfo[])
```

Returns array of strategies.

### getStrategiesBalance

```solidity
function getStrategiesBalance() public view returns (uint256 totalBalance, uint256[] balances)
```

Returns amount of tokens in strategies.
All returned numbers have &#x60;UNIFORM_DECIMALS&#x60; decimals.

| Name | Type | Description |
| ---- | ---- | ----------- |
| totalBalance | uint256 | Total amount of tokens in strategies. |
| balances | uint256[] | Array of token amount in each strategy. |

### getBatchingBalance

```solidity
function getBatchingBalance() public view returns (uint256 totalBalance, uint256[] balances)
```

Returns token balances and their sum in the batching.
Shows total batching balance, possibly not total to be deposited into strategies.
        because strategies might not take all token supported by router.
All returned amounts have &#x60;UNIFORM_DECIMALS&#x60; decimals.

| Name | Type | Description |
| ---- | ---- | ----------- |
| totalBalance | uint256 | Total tokens in the batching. |
| balances | uint256[] | Array of token balances in the batching. |

### receiptToShares

```solidity
function receiptToShares(uint256 receiptId) public view returns (uint256 shares)
```

Returns amount of shares retrievable by receipt.
Cycle noted in receipt should be closed.

### sharesToUsd

```solidity
function sharesToUsd(uint256 shares) public view returns (uint256 amount)
```

Calculate how much usd shares representing using current price per share.

_Returns amount with uniform decimals_

### unlockShares

```solidity
function unlockShares(uint256 receiptId) public returns (uint256 shares)
```

Convert receipt NFT into share tokens, withdraw functions do it internally.
Cycle noted in receipt should be closed.

### withdrawFromStrategies

```solidity
function withdrawFromStrategies(uint256 receiptId, address withdrawToken, uint256 shares, uint256 amount) external
```

User withdraw usd from strategies via receipt NFT.
On partial withdraw leftover shares transfered to user.
Receipt is burned.
Internally all receipt's shares unlocked from that NFT.

_Only callable by user wallets._

| Name | Type | Description |
| ---- | ---- | ----------- |
| receiptId | uint256 | Receipt NFT id. |
| withdrawToken | address | Supported token that user wish to receive. |
| shares | uint256 | Amount of shares to withdraw. |
| amount | uint256 | Uniform amount from receipt to withdraw, only for current cycle. |

### withdrawShares

```solidity
function withdrawShares(uint256 shares, address withdrawToken) external
```

User withdraw tokens from strategies via shares. Receipts should be converted to shares prior to call this.

| Name | Type | Description |
| ---- | ---- | ----------- |
| shares | uint256 | Amount of shares to withdraw. |
| withdrawToken | address | Supported token that user wish to receive. |


### withdrawFromBatching

```solidity
function withdrawFromBatching(uint256 receiptId, address withdrawToken, uint256 shares, uint256 amount) external
```

User withdraw tokens from batching.
On partial withdraw amount noted in receipt is updated.
Receipt is burned when withdrawing whole amount.

_Only callable by user wallets._

| Name | Type | Description |
| ---- | ---- | ----------- |
| receiptId | uint256 | Receipt NFT id. |
| withdrawToken | address | Supported token that user wish to receive. |
| shares | uint256 | Amount of shares to withdraw, specify this if money of receipt were deposited into strategies. |
| amount | uint256 | Amount to withdraw, specify this if money of receipt isn't deposited into strategies yet. |

### depositToBatch

```solidity
function depositToBatch(address depositToken, uint256 _amount) external
```

Deposit token into batching.
Tokens not deposited into strategies immediately.

_User should approve &#x60;_amount&#x60; of &#x60;depositToken&#x60; to this contract.
Only callable by user wallets._

| Name | Type | Description |
| ---- | ---- | ----------- |
| depositToken | address | Supported token to deposit. |
| _amount | uint256 | Amount to deposit. |

### setExchange

```solidity
function setExchange(contract Exchange newExchange) external
```

Set address of exchange contract.

_Admin function._

### setMinUsdPerCycle

```solidity
function setMinUsdPerCycle(uint256 amount) external
```

Minimum usd needed to be able to close the cycle.

_Admin function._

| Name | Type | Description |
| ---- | ---- | ----------- |
| amount | uint256 | Amount of usd, must be &#x60;UNIFORM_DECIMALS&#x60; decimals. |

### setMinDeposit

```solidity
function setMinDeposit(uint256 amount) external
```

Minimum to be deposited in the batching.

_Admin function._

| Name | Type | Description |
| ---- | ---- | ----------- |
| amount | uint256 | Amount of usd, must be &#x60;UNIFORM_DECIMALS&#x60; decimals. |

### setCycleDuration

```solidity
function setCycleDuration(uint256 duration) external
```

Minimum time needed to be able to close the cycle.

_Admin function._

| Name | Type | Description |
| ---- | ---- | ----------- |
| duration | uint256 | Duration of cycle in seconds. |

### addStrategy

```solidity
function addStrategy(address _strategyAddress, address _depositTokenAddress, uint256 _weight) external
```

Add strategy.

_Admin function.
Deposit asset must be supported by the router._

| Name | Type | Description |
| ---- | ---- | ----------- |
| _strategyAddress | address | Address of the strategy. |
| _depositTokenAddress | address | Asset to be deposited into strategy. |
| _weight | uint256 | Weight of the strategy. Used to split user deposit between strategies. |

### updateStrategy

```solidity
function updateStrategy(uint256 _strategyId, uint256 _weight) external
```

Update strategy weight.

_Admin function._

| Name | Type | Description |
| ---- | ---- | ----------- |
| _strategyId | uint256 | Id of the strategy. |
| _weight | uint256 | Weight of the strategy. |

### removeStrategy

```solidity
function removeStrategy(uint256 _strategyId) external
```

Remove strategy, deposit its balance in other strategies.

_Admin function._

| Name | Type | Description |
| ---- | ---- | ----------- |
| _strategyId | uint256 | Id of the strategy. |

### rebalanceStrategies

```solidity
function rebalanceStrategies() external returns (uint256 totalInStrategies, uint256[] balances)
```

Rebalance strategies, so that their balances will match their weights.

_Admin function._

### setSupportedToken

```solidity
function setSupportedToken(address tokenAddress, bool supported) external
```

Set token as supported for user deposit and withdraw.

_Admin function._


