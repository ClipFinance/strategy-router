
### DEV NOTES

Currently for simplicity a cycle can finish only by call `depositToStrategies`, though cycle finish conditions must be met.

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.