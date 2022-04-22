### Diagrams
https://miro.com/app/board/uXjVOXGtYEw=/

### Definitions
*Strategies* - is a smart contracts that implements certain farming strategies with stablecoins, such as staking biswap UST-BUSD LP tokens. Users can't interact with strategy contracts directly.  

*Strategy router* - is a smart contract that manages user funds and strategies, serves as intermediary between user and multiple strategies.   

*Batching balance* - This is where user funds appear after his deposit. Coins hold here before depositing them into strategies, thus money in batching doesn't generate any profits. This is managed by Strategy Router.  

*Strategy balance* - Simply saying how much stablecoin you can withdraw from that strategy, not accounting for fee or slippage. Money in strategies are generating profits.  

*To close the cycle* - is when batching balance is deposited into strategies. Cycle duration and minimum batching balance conditions should met to close the cycle.  

*Share Tokens or shares* - Utility ERC20 token to denote user share in the pool.  

*Receipt NFT or receipt* - Utility ERC721 token to denote user deposits.  

### General overview
Users depositing their stablecoins together into strategy router, collected funds are periodically deposited into strategies. User can withdraw his share of the pool including his profits at anytime. Strategy router can add, remove or rebalance strategies.

### User workflow
User choose one of the supported stablecoins to deposit in the batching and receive "Receipt NFT" that notes how much user just deposited and in which cycle.  

Then after cycle duration has been passed and batching has reached certain minimum of coins, anyone can close the cycle and deposit batch into strategies which is done by special function. Now coins in strategies should generate profit. This whole process can repeat for infinite number of cycles.  

User can withdraw part or whole amount noted in his Receipt NFT directly from the batching if cycle noted in the receipt is not closed. If closed then he can convert his NFTs into Share Tokens, these shares can be used to withdraw stablecoins from strategies inlcuding profits. User can choose one of the supported stablecoins to receive after withdraw.  

There is also function to compound all the strategies which can be called anytime by anyone, and it is also called when depositing batch into strategies.
