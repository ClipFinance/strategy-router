### Development
Clone this repo, rename `.env.example` file to `.env` and fill the variables inside.  
Install dependencies via npm or pnpm `pnpm i`.  
To run all the tests `npx hardhat test`.  
To run specific test file `npx hardhat test test/router.js`.  

### Definitions
*Strategy* - is a smart contract that implements certain farming strategy with stablecoins, such as staking biswap LP tokens.  
*Strategy router* - is a smart contract that manages user funds and strategies, serves as intermediary between user and multiple strategies.   
*Batching balance* - each strategy have its own dedicated "batching" balance. This is where user funds appear after his deposit. Coins hold here before depositing them into related strategy. This is fully managed by Strategy Router.  
*Strategy balance* - amount returned by calling `totalTokens()` on the strategy, simply saying how much stablecoin you can withdraw from that strategy.  
*To close the cycle* - is when batching balances are deposited into related strategies, new cycle starts with 0 coins in batching. Cycle duration and minimum batching balance conditions should met to close the cycle.  
*Share Tokens or shares* - Utility ERC20 token to denote user share in the pool.  
*Receipt NFT or receipt* - Utility ERC721 token.

### General idea
Users depositing their stablecoins together into strategy router, collected funds are periodically deposited into strategies for profits. User can withdraw his share of the pool including his profits at anytime.

### User workflow
User choose one of the supported stablecoins to deposit in the batching and receive "Receipt NFT" that notes how much user just deposited and in which cycle.  

Then after cycle duration has been passed and batching has reached certain amount of coins, anyone can close the cycle and deposit batch into strategies which is done by special function. Now coins in strategies should generate profit. This whole process repeats and thus infinite number of cycles can be.  

User can withdraw part or whole amount noted in his Receipt NFT directly from the batching if that cycle is not closed. If closed then he can convert his NFTs into Share Tokens, these shares can be used to withdraw stablecoins from strategies inlcuding profits. User can choose one of the supported stablecoins to receive after withdraw.  

There is also function to compound all the strategies which can be called anytime by anyone, and it is also called when depositing batch into strategies.

## Technical description
#### Commonly used functions and formulas  

`toUniform()` is a function that transforms amount of stablecoin to have 18 decimals (which is called here *uniform*).  
`fromUniform()` is a function that transforms amount with 18 uniform decimals to have stablecoin decimals.  
  
Here is example of such transformation, let's say that `100` has 2 decimals and denotes 1 token, if we transform it to 4 decimals it will become `10000` which is still 1 token.

---
`B` is sum of the batching balances with uniform decimals:  
``` 
B = toUniform(x₁) + toUniform(x₂) + ...
```
Where `xᵢ` is batching balance of the strategy `i`.

---
`S` is sum of the strategies balances with uniform decimals.  
```
S = toUniform(x₁) + toUniform(x₂) + ...
```
Where `xᵢ` is balance of the strategy `i`, which is acquired by calling `totalTokens()` on that strategy.

## Contracts

### StrategyRouter

#### depositToBatch function

Only callable by user wallets.  
Allows user to deposit stablecoin into batch.   
Deposited stablecoin immediately swapped into stablecoins that are required by strategies.  
Mints ReceiptNFT to user each time.

__Implementation details.__   
Amount deposited by user is split according to strategies weight:  
```
xᵢ = d * wᵢ / 10000
xᵢ = trySwap(xᵢ)
```
`d` is amount of stablecoin deposited by user,  
`wᵢ` is weight of the strategy `i` in percents (in basis points where 100% is 10000),  
`xᵢ` is amount to be deposited into the batch balance of the strategy `i`,  
`trySwap()` is a function that will swap `xᵢ` of deposited token if it doesn't match token required by the strategy.

After that we increase batch balance of the strategy by amount `xᵢ`.  

Now we calculate amount to store in NFT:
```
y = toUniform(x₁) + toUniform(x₂) + ...
```
Where `y` is sum with uniform decimals which will be stored in the NFT.  

Finally current cycle index is stored in the same NFT.

We will need those values from NFT later in the withdraw functions.

#### withdrawFromBatching function
Allows user to withdraw stablecoins from the batching.  
User chooses supported stablecoin to receive, internally other stablecoins will be swapped to chosen one.  
On partial withdraw amount noted in receipt is updated.  
Receipt is burned when withdrawing whole amount.  
Cycle id noted in receipt must match current cycle (i.e. not closed).  
User provides Receipt NFT and amount to withdraw, max amount is what noted in NFT.  
If amount is 0 or greater than maximum, then max amount is chosen.  

__Implementation details.__   
Withdraw amount first being split according to batching balances:
```
yᵢ = fromUniform(w * bᵢ / B)
```
Where `w` is amount provided by user to withdraw (uniform decimals),  
`bᵢ` is batching balance of the strategy `i` (uniform decimals),  
`B` is sum of the batching balances with uniform decimals,  
`yᵢ` is amount to withdraw from batching balance of strategy `i` (stablecoin decimals)

Next, batching balance of strategy `i` is decreased by `yᵢ`.  

Then we calculate final amount to transfer to user:
```
x = trySwap(y₁) + trySwap(y₂) ...
```
Where `trySwap()` is function that swaps batching coins to match stablecoin requested by user if they are different,  
`x` is amount of token to transfer to user.


#### depositToStrategies function
Deposit money collected in the batching into strategies.  
Callable by anyone when `cycleDuration` seconds has been passed and batch has reached `minUsdPerCycle` amount of coins.  
Only callable by user wallets.  

__Implementation details.__  
1) We compound all the strategies by calling their `compound()` function.  
2) Deposit batching balances into strategies via their `deposit()` function.  
	1) There is high chance that strategy will have some leftover amount, bacause for example add_liquidity functions on uniswap often not take 100% of the provided tokens. So this dust left on strategy is currently handled by strategy itself, the dust is used on next call to compound or deposit.
3) Calculate price per share for current cycle and store it.
	1) Current implementation requires "initial deposit" to spwan initial shares, and it is unwithdrawable.
    2) Calculation of price per share is different if it is initial deposit or not.
4) Mint new shares to the strategy router itself.
5) Increment cycles counter.
---
Lets say we are doing __initial deposit__.  
We deposit batching balances into strategies, then we mint initial amount of shares and calculate price per share:
```
p = B / s
```
Where `s` is initial amount of shares,  
`p` is price per share,  
`B` is sum of the batching balances with uniform decimals, before deposit into strategies.  
Price per share is stored for current cycle and cycles counter incremented.  

---
Lets say now we do __non-initial deposit__.  
The price per share is calculated this way:
```
p = S / s
```
Where `s` is total shares exists,  
`p` is price per share,  
`S` is sum of the strategies balances with uniform decimals, after compound but before batch deposit.  

Calculate amount of new shares and mint them:
```
n = B / p
```
Where `n` is amount of new shares,  
`B` is sum of the batching balances with uniform decimals, before deposit into strategies,  
`p` is just calculated price per share.  

Price per share is stored for current cycle, new shares minted and cycles counter incremented.  

#### withdrawByReceipt function
User withdraw usd from strategies via receipt NFT.  
User provides percent of total shares from that receipt to withdraw (this param is subject to change).   
On partial withdraw leftover shares transfered to user.  
Receipt is burned anyway.  
Cycle noted in receipt must be closed.  
Only callable by user wallets.    

__Implementation details.__  
1) Calculate user shares using amount noted in receipt and price per share from cycle id noted in receipt.
```
u = a / p
```
Where `u` is total shares unlocked from that receipt,  
`a` is amount noted in receipt (better to remember how that amount was calculated in deposit function),  
`p` is 	price per share of the cycle noted in receipt.

2) Calculate current price per share and multiply by user shares from step 1
```
w = S / s
```
Where `w` is total amount to withdraw including profits,  
`S` is sum of the strategies balances with uniform decimals,  
`s` is total shares exists.  

3) Split that withdraw amount between strategies
```
yᵢ = fromUniform(w * xᵢ / S)
```
Where `yᵢ` is amount to withdraw from strategy `i` (stablecoin decimals),  
`xᵢ` is balance of strategy `i`,  
`S` is sum of the strategies balances with uniform decimals.  

4) Last step is to just swap tokens received from strategies to the token requested by user and transfer to him.

todo: need add explanation with formulas for each strategy