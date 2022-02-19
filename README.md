### DEV NOTES

Currently for simplicity a cycle can finish only by call `depositToStrategies`, though cycle finish conditions must be met.

Since strategies should be removable, we need to manage 'balance' field of these structs, or choose different approach.

When deposit in batching, should we note in NFT all tokens amount deposited, or only value of all amounts?