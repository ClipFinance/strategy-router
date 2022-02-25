### DEV NOTES

TODO: in withdraw function need to convert amountWithdraw which is USD price to strategy asset amount

TODO: make sure that there is no problem with the fact that we have constant number of shares,
otherwise need to fix if that's a problem (especially in withdraw function, receipt.amount / pps)

TODO: make sure decimals not screwed up

Currently for simplicity a cycle can finish only by call `depositToStrategies`, though cycle finish conditions must be met.

should we swap user deposit immediately to strategy tokens or we swap everything when deposit in strategies?
imagine we swap user deposit to 10 + 90 (two tokens), their value is 11 + 93 = 104, then in withdraw when we try to get 90% and 10% of these 104, we won't get 11+93, more likely 10.4 + 93.6! 
or should we save value of each token after swaps in user deposit function, this may solve problem described above.    
Also currently thats problem we swap immediately when user deposits, because percentages applied to 'depositAmount' which is in 1 token, but then we swap derived percentage to other tokens, this leads to problem when percentage of values of tokens after swap is not the same as we applied, for example we applied 90% and 10%, but received 11% and 89%.
Maybe another solution would be to have derived prices calculations, that means we cant ask price for UST/USDT but we can derive that (see chainlink docs for example)

Think if we care about this warning in the end of page: https://curve.readthedocs.io/registry-exchanges.html
We might want to query best-rate-pool off-chain as it might be expensive to call on-chain.