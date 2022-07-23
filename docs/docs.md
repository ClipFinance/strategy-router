### Diagrams
https://miro.com/app/board/uXjVOXGtYEw=/

### Definitions
*Strategies* - is a smart contracts that implements certain farming strategies with tokens, such as staking biswap LP tokens. Users can't interact with strategy contracts directly.  

*Strategy router* - is a smart contract that manages user funds and strategies, serves as intermediary between user and multiple strategies.   

*Batch balance* - This is where user funds appear after his deposit. Coins hold here before depositing them into strategies, thus money in batch doesn't generate any profits. This is managed by Strategy Router.  

*Strategy balance* - Simply saying how much token you can withdraw from that strategy, not accounting for fee or slippage. Money in strategies are generating profits.  

*Cycle* - Every cycle has its own price per share (PPS).  

*To close the cycle* - is when batch balance is deposited into strategies. Cycle duration and minimum batch balance conditions should met to close the cycle.  

*Share Tokens or shares* - Utility ERC20 token to denote user share in the pool.  

*Receipt NFT or receipt* - Utility ERC721 token to denote user deposits.  

### General overview
Users depositing their tokens together into strategy router, collected funds are periodically deposited into strategies. User can withdraw his share of the pool including his profits at anytime. Strategy router can add, remove or rebalance strategies.

### User workflow
User choose one of the supported tokens to deposit in the batch and receive "Receipt NFT" that notes how much user just deposited and assigned unique ID for the cycle. Unique cycle ID is incrementing integer number.  

Then after cycle duration has been passed or batch has reached minimum amount of required coins, a Chainlink Keeper triggers current batch deposits into strategies. Now the coins in the strategies are generating profits. This whole process can be repeated for infinite number of cycles.  

Strategy contract is collecting rewards until auto-compounding is called. Currently auto-compounding is called with Keeper when batch is sent to strategy.  

During withdrawal user enters full amount of coins to withdraw (initial deposit + earnings). Amount and NFT ID is passed to withdrawal function. Contract does its math on how much shares user has. In user's NFT is recorded coins amount and price per share. User shares formula: amount of user deposit divided by cycle's price per share. (deposit/cycle PPS)<sub>1</sub> + ... + (deposit/cycle PPS)<sub>n</sub>.  

Maximum withdrawable amount's formula is user's total shares times current PPS.  

With partial withdraw all NFTs are burned and issuing share tokens for remaining amount. User's share tokens formula is remaining amount of coins divided by current PPS.  

User can withdraw part or whole amount noted in his Receipt NFT directly from the batch if cycle noted in the receipt is not closed yet. If closed then he can convert his NFTs into Share Tokens, these shares can be used to withdraw tokens from strategies inlcuding profits. User can choose one of the supported tokens to receive after withdraw.  

There is also function to compound all the strategies which can be called anytime by anyone, and it is also called when depositing batch into strategies.

### Platform fee collection
Platform fee is collected inside each strategy as strategies are unique. I.e biswap gives token in reward and when platform sells token for token to auto-compound, 20% from the amount is moved to platform's treasury.  
Acryptos on BSC and Curve give rewards in their token and also in the interest bearing token.  

### Adjust to most profitable strategies

### Compounding occurence
* Happens whenever Keeper sends the batch to strategies
* There's an option to trigger Keeper whenever we want, i.e when over $x amount of tokens were farmed to sell them and increase deposit for higher rewards
