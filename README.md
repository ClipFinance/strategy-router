## Development
Clone this repo, rename `.env.example` file to `.env` and fill the variables inside.  
Install dependencies via npm or pnpm `pnpm i`.  
To run all the tests `npx hardhat test`.  
To run specific test file `npx hardhat test test/router.js`.  

## General idea
Users deposit their stablecoins together into strategies that should generate profits. Then any user can withdraw his share of the pool at any time including his profits. User interacts with strategy router which interacts with the strategies. The strategies is a smart contracts that are implementing different farming strategies.

### Details and user workflow
Users deposit their stablecoins in the common batch and receive 'Receipt NFTs' that notes how much user just deposited and in which cycle.  

Then after defined amount of time has been passed and batch has reached required amount of coins, anyone can close the cycle and deposit batch into strategies which is done by special function. Now coins in strategies should generate profit. This process repeats and thus infinite number of cycles can be.  

User can use Receipt NFT to withdraw part or whole amount noted in that NFT directly from the batch if that cycle still not closed. If closed then he can convert his NFTs into ERC20 tokens called 'ST' (Shares Token) representing his share, these STs can be used to withdraw stablecoins from strategies inlcuding profits. Since strategies work with different coins, a user can choose one of the supported stablecoins to receive after withdraw.  

There is also function to compound all the strategies which can be called anytime by anyone, and it is also called when depositing batch into strategies.
## Contracts
### StrategyRouter

#### depositToBatch function

Only callable by user wallets, not by contracts.  
Allows user to deposit stablecoins into batch. The batch balance of the strategy is not generating profits.  
Coins are immediately swapped into stablecoins that are required by strategies, division between strategies is done according to weights of the strategies.  
Mints ReceiptNFT to user, that NFT holds information about amount deposited and current cycle index.  

__Implementation details.__   
Deposited amount is split into multiple parts that match strategies weight and their stablecoin:  
```
xᵢ = d * wᵢ / 10000
```
Where `i` is strategy index,  
`d` is amount of stablecoin deposited by user,  
`w` is weight of the strategy in percents (in basis points where 100% is 10000),  
`x` is amount to be deposited into the batch balance of the strategy `i`,  

If user deposit token doesn't match token required by strategy `i`, then amount `xᵢ` is swapped to strategy's token:
```
xᵢ = swap(xᵢ)
```
Then `xᵢ` is added to the batch balance of the strategy `i`.  

Now we will note sum of `xᵢ` as a single amount in the Receipt NFT:
```
y = f(x₁) + f(x₂) ...
```
Where `f()` is function that transforms `xᵢ` to have 18 decimals instead of strategy `i` stablecoin decimals,  
`y` is result of the summation which will be noted in the NFT.

Finally current cycle index is saved in the same NFT.

#### withdrawFromBatching function
Allows user to withdraw stablecoins from the batching.  
User chooses what stablecoin he will receive, so that different coins from batch will be swapped to that stablecoin first.  
On partial withdraw amount noted in receipt is updated.  
Receipt is burned when withdrawing whole amount noted in it.  
Cycle noted in receipt must match current cycle (i.e. not closed).  
User provides Receipt NFT and amount to withdraw, max amount is what noted in NFT.  
If amount is 0 or greater than maximum, then max amount is choosen.  

__Implementation details.__   
Withdraw amount first being split into multiple parts matching balances of the batch:
```
yᵢ = f(w * bᵢ / t)
```
Where `w` is amount provided by user to withdraw (18 decimals),  
`bᵢ` is batching balance of the strategy `i` (18 decimals),  
`t` is total batching balance of all strategies (18 decimals),  
`f()` is function to transform from uniform 18 decimals to decimals of stablecoin of the strategy `i`.  

Now batching balance of strategy `i` is decreased by `yᵢ`.  

Then we calculate final amount to transfer to user:
```
x = s(y₁) + s(y₂) ...
```
Where `s()` is function that swaps coins to match user coin if they are different,  
`x` is amount of token to transfer to user.


#### depositToStrategies function
Deposit money collected in the batching into strategies.  
Callable by anyone when `cycleDuration` seconds has been passed and batch has reached `minUsdPerCycle` amount of coins.  
Only callable by user wallets.  

__Implementation details.__  
1) We compound all the strategies by calling their `compound()` function.  
2) Deposit batching balances into strategies via their `deposit()` function, so that funds from the batch can now generate profits.  
	1) There is high chance that strategy will have some leftover amount, bacause for example add_liquidity functions on DEXes often not use 100% of the provided tokens. So this dust left on strategy is currently handled by strategy itself, the dust is used on next call to compound or deposit.
3) Calculate price per share in current cycle and save result.
	1) Current implementation requires "admin initial deposit" to spwan initial shares.
    2) Calculation of price per share is different if its initial deposit or not.
4) Mint new Share Tokens.
5) Close the cycle by incrementing cycle index.
---
Lets assume that we doing __initial deposit__.  
First we deposit batching balances and get total batching balance as a single value:  
```
t = f(x₁) + f(x₂) ...
```
Where `xᵢ` is batching balance of the strategy `i`,  
`f()` is function that transforms `xᵢ` to have 18 decimals instead of strategy `i` stablecoin decimals,  
`t` is sum of batching balances.

Now we mint predefined amount of shares and calculate price per share:
```
p = t / s
```
Where `s` is total shares exists (only initial predefined amount),  
`p` is price per share for current cycle,  
`t` is sum of batching balances (see above).
Price per share is saved for current cycle and that cycle is closed.  
---
Lets say now we do __non-initial deposit__.  
First we compound strategies and get total *strategies* balance after compound by calling their `totalTokens()` function.  
```
t = f(x₁) + f(x₂) ...
```
Where `xᵢ` is balance of the strategy `i`, which is result of calling `totalTokens()` on the strategy,  
`f()` is function that transforms `xᵢ` to have 18 decimals instead of strategy `i` stablecoin decimals,  
`t` is sum of strategies balances.

Then price per share is calculated:
```
p = t / s
```
Where `s` is total shares exists,  
`p` is price per share for current cycle,  
`t` is sum of strategies balances (see above).

To see how much new shares to mint we use total batching balance, calculation for that total value is the same as in "initial deposit":
```
b = f(x₁) + f(x₂) ...
```
Where `xᵢ` is batching balance of the strategy `i`,  
`f()` is function that transforms `xᵢ` to have 18 decimals instead of strategy `i` stablecoin decimals,  
`b` is sum of batching balances.

Get amount of new shares and mint them:
```
n = b / p
```
Where `n` is amount of new shares,  
`b` is total batching balance,
`p` is just updated price per share.

Price per share is saved for current cycle, new shares minted and that cycle is closed.  