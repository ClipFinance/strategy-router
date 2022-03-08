
### DEV NOTES

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.


manual simulation:
farms weights 90%, 10%
farms tokens ust, usdc

user deposits 100$, swap to 90.2 + 10.1, noted total 100.3
farm1 90.2, farm2 10.1
user2 deposits 200$, swap to 180.2 + 19.8, noted total 200
farm1 270.4, farm2 29.9

total batching balance 300.3

deposit to strategies function call:
1) balanceAfterCompound = 0
2) balance after deposit = 300.3
3) shares = initial_shares = 1e6
