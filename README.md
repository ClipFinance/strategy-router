### DEV NOTES

TODO: make sure that there is no problem with the fact that we have constant number of shares,
otherwise need to fix if that's a problem (especially in withdraw function, receipt.amount / pps)

TODO: make sure decimals not screwed up

Currently for simplicity a cycle can finish only by call `depositToStrategies`, though cycle finish conditions must be met.

Since strategies should be removable, we need to manage 'balance' field of these structs, or choose different approach.

When deposit in batching, should we note in NFT all tokens amount deposited, or only value of all amounts?

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.