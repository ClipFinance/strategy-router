#### Table of contents:
* [Definitions](#definitions)
* [General idea](#general-idea)
* [User workflow](#user-workflow)
* [Technical description](#technical-description)
	* [StrategyRouter contract](#strategyrouter)
		* [Commonly used functions and formulas](#commonly-used-functions-and-formulas)
		* [depositToBatch function](#deposittobatch-function)
		* [withdrawFromBatching function](#withdrawfrombatching-function)
		* [depositToStrategies function](#deposittostrategies-function)
		* [withdrawFromStrategies function](#withdrawFromStrategies-function)
	* [Strategies general interface](#strategies-general-interface)

---
### Development
Clone this repo, rename `.env.example` file to `.env` and fill the variables inside.  
Install dependencies via npm `npm i`.  
To run all the tests `npx hardhat test`.  
To run specific test file `npx hardhat test test/router.js`.  

### Definitions
*Strategy* - is a smart contract that implements certain farming strategy with stablecoins, such as staking biswap LP tokens.  
*Strategy router* - is a smart contract that manages user funds and strategies, serves as intermediary between user and multiple strategies.   
*Batching balance* - each strategy have its own dedicated "batching" balance. This is where user funds appear after his deposit. Coins hold here before depositing them into related strategy. This is fully managed by Strategy Router.  
*Strategy balance* - amount returned by calling `totalTokens()` on the strategy, simply saying how much stablecoin you can withdraw from that strategy. Not accounting for fee or slippage.  
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
### StrategyRouter contract
#### Commonly used functions and formulas  

`toUniform()` is a function that transforms amount of stablecoin to have 18 decimals (which is called here *uniform*, can also be called *normalized*).  
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
`S` is sum of the strategies balances with uniform decimals, after deposit.  

Amount received by strategies after deposit is saved in cycle info, calculated as difference between strategies balance before and after deposit.  
Batching balance before deposit is also saved in cycle info.  
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
n = D / p
```
Where `n` is amount of new shares,  
`D` is amount received by strategies after deposit, calculated as difference between strategies balance before and after deposit,  
`p` is just calculated price per share.  

Amount received by strategies after deposit is saved in cycle info, calculated as difference between strategies balance before and after deposit.  
Batching balance before deposit is also saved in cycle info.  
Price per share is stored for current cycle, new shares minted and cycles counter incremented.  

#### withdrawFromStrategies function
User withdraw usd from strategies via receipt NFT.  
User provides percent of total shares from that receipt to withdraw (this param is subject to change).   
On partial withdraw leftover shares transfered to user.  
Receipt is burned anyway.  
Cycle noted in receipt must be closed.  
Only callable by user wallets.    

__Implementation details.__  
1) Calculate user shares using info stored for cycle id that is noted in receipt.
First adjust amount noted in NFT:
```
a = a * R / D;
```
Where `R` and `D` are values stored in cycle info after `depositToStrategies` function.  
`R` is amount received by strategies after deposit,  
`D` is batching balance that was deposited.  
```
u = a / p
```
Where `u` is total shares 'unlocked' from that receipt,  
`a` is amount noted in receipt (adjusted as above),  
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

### Strategies general interface
That interface is subject to changes.  
In current version of the interface its assumed that owner of the Strategies is StrategyRouter. All the functions of Strategies is only callable by the owner of the contract.  
There is no approvals between strategies and the router, tokens transferred immediately to or from strategy when calling deposit or withdraw functions respectively.
    
#### function deposit(uint256 amount) external;
Deposit amount of coins to strategy.    
Deposited amount immediately invested according to concrete yield farming strategy.  

#### function withdraw(uint256 amount) external returns (uint256 amountWithdrawn);

Withdraw amount of tokens from strategy.   
Tokens immediately transfered to StrategyRouter.  
Returns amount withdrawn.  
 
#### function compound() external;
Harvest rewards and re-invest them according to concrete yield farming strategy.
 
#### function totalTokens() external view returns (uint256);
Returns total amount of tokens withdrawable from the strategy, you should be able to pass that amount to `withdraw` function and have no errors.    
It shouldn't account for fees or slippage, unless there is no way in withdraw function to have calculations without accounting for fees or slippage.    

#### function withdrawAll() external returns (uint256 amountWithdrawn);
Withdraw all tokens from strategy.  
Currently used only when removing strategy from StrategyRouter.  
Returns amount withdrawn.  

### Strategy - ACRYPTOS ust
Useful links:  

Acryptos dapp: https://app.acryptos.com/contracts/  
Acryptos docs: https://docs.acryptos.com/  

ACS4UST pool: https://bscscan.com/address/0x99c92765EfC472a9709Ced86310D64C4573c4b77  
ACS4UST zap depositer: https://bscscan.com/address/0x4deb9077e49269b04fd0324461af301dd6600216  
ACS4UST LP token: https://bscscan.com/address/0xd3debe4a971e4492d0d61ab145468a5b2c23301b  
UST: https://bscscan.com/address/0x23396cF899Ca06c4472205fC903bDB4de249D6fC  
ACSI: https://bscscan.com/address/0x5b17b4d5e4009b5c43e3e3d63a5229f794cba389  
ACryptoSFarmV4: https://bscscan.com/address/0x0c3b6058c25205345b8f22578b27065a7506671c  

---
#### deposit function
Its assumed that coins already transfered to Strategy before the function is called, amount transfered is passed as argument.  

1) approve zap depositer contract to transfer UST
2) call add_liquidity on zap depositer and receive LP tokens
3) approve ACryptoSFarmV4 to transfer ACS4UST LP tokens
4) call deposit on ACryptoSFarmV4 farm to deposit LPs

#### withdraw function

1) StrategyRouter will provide us amount of coins to withdraw. Please see explanation of the router's `withdrawFromStrategies` function to understand how that amount is calculated.
2) Convert that amount to LP tokens amount:
```
l = w * 1e18 / p
```
Where `p` is virtual price, returned by pool's `get_virtual_price()` function,  
`l` is amount of LPs to withdraw from the farm,  
`w` is withdraw amount of UST tokens passed by StrategyRouter,  
`1e18` is pool's price normalization.
3) Withdraw LPs from farm, then call pool's `remove_liquidity_one_coin` to remove liquidity and receive UST tokens.
4) Transfer received UST back to StrategyRouter.

#### compound function
1) Harvest ACSI tokens by call to harvest(address _lpToken)
2) If received rewards, then swap those ACSI for more UST
3) Reinvest in the same way that deposit function doing it.

#### totalTokens function

1) Get amount of LPs in farm
2) Convert that LP amount to UST amount:
```
u = p * l / 1e18
```
Where `p` is virtual price, returned by pool's `get_virtual_price()` function,  
`l` is amount of LPs on farm,  
`1e18` is pool's price normalization,
`u` is total amount of UST we can receive if remove all liquidity.