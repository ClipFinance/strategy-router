
### DEV NOTES

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.
get_best_rate uses ~180.000 gas 
Possible solutions: 
1) create function to query all necessary pools and save them, and you can call it later with the same params to update addresses of pools if needed
2) query all necessary pools off-chain, and save their addresses on-chain, then use these for swaps  