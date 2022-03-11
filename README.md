
### DEV NOTES

problem: after everyone withdraw there is some dust left in strategies, then when users deposit and try to withdraw, they will withdraw 99/100 shares, so 1 share is unwithdrawable, this way this unwithdrawable dust can grow and thus making user withdrawable amount even more less such as 97/100.

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html  
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.  
get_best_rate uses ~180.000 gas   
Possible solutions:   
1) create function to query all necessary pools and save them, and you can call it later with the same params to update addresses of pools if needed  
2) query all necessary pools off-chain, and save their addresses on-chain, then use these for swaps  

