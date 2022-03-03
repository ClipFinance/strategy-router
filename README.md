
### DEV NOTES

TODO: probably should calculate shares in different way in depositToStrategies function, reference https://miro.com/app/board/uXjVOXGtYEw=/

TODO: need to save deposited total balance in strategy structure, in case if there is strats with the same token.

Currently for simplicity a cycle can finish only by call `depositToStrategies`, though cycle finish conditions must be met.

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.