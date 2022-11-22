* [Documantion](./docs/docs.md)  
* [StrategyRouter API](./docs/StrategyRouter.md)  
* [ReceiptNFT API](./docs/ReceiptNFT.md)  

---

### Development
Requirements  
* Node version 14+
* Npm version 6+

Clone this repo, rename `.env.example` file to `.env` and fill the variables inside.  

For connecting to binance smart chain node, paste your RPC node url and paste it to `.env` `BNB_URL` value. Use on of the public nodes. You can find them here https://docs.bscscan.com/misc-tools-and-utilities/public-rpc-nodes  
For example use this in `BNB_URL=https://bsc-dataseed3.ninicoin.io/`

Install dependencies via npm `npm i`.  
To run all the tests `npx hardhat test`.  
To run specific test file `npx hardhat test test/router.js`.  

Deploy to get ABI
Go to directory and launch:  
`solcjs --abi --include-path node_modules/ --base-path . contracts/StrategyRouter.sol`