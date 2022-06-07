const { expect } = require("chai");
const { ethers } = require("hardhat");
const { provider } = require("./utils");


describe("Test Batching", function () {

    // TODO deposit()
    //   happy path: when funds are deposited batch, receiptNFT is minted and correct values assigned (non-zero/non-default)
    //   corner cases below:
    //     not supported token is deposited, transaction reverted
    //     user deposits deppeged token that numerically match minimum amount, transaction should revert
    //     deposited token has different decimal places (3, 6, 12, 21), expected receipt to have correctly normalized amount value

    //  TODO getBatchingTotalUsdValue()
    //    happy paths: 1 supported token, 3 supported tokens
    //    corner cases below:
    //      within 3 tokens we have 1 token depegged with $0.5 per token, second token with different decimal amount (10^12)
    //       and third is normal

    //  TODO withdraw()
    //    happy paths:

    //  TODO rebalance()
    //    happy paths:
    //    corner cases below:

    // TODO setSupportedToken()
    //   happy paths: add token, tokken added, is listed in supported tokens
    //    corner cases below:
    //     pass same token multiple times, test function is idempotent
    //     pass address that is not a token
    //   suspended until clarification: happy paths delete token: test
    //     corner cases below:
    //       token is still in already in strategy
});