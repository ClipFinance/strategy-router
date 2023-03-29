//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

interface IDodoSingleAssetPool {
    function withdrawBase(uint256 amount) external returns (uint256);

    function depositBase(uint256 amount) external returns (uint256);

    function withdrawQuote(uint256 amount) external returns (uint256);

    function depositQuote(uint256 amount) external returns (uint256);

    function withdrawAllBase() external returns (uint256);

    function withdrawAllQuote() external returns (uint256);

    function _BASE_TOKEN_() external returns (address);

    function _QUOTE_TOKEN_() external returns (address);
    
    function _R_STATUS_() external returns (address);

    function getExpectedTarget()
        external
        view
        returns (uint256 baseTarget, uint256 quoteTarget);

    function getWithdrawBasePenalty(uint256 amount)
        external
        view
        returns (uint256);

    function getWithdrawQuotePenalty(uint256 amount)
        external
        view
        returns (uint256);

    function getLpQuoteBalance(address lp) 
        external
        view 
        returns (uint256 lpBalance);

    function sellBaseToken(
        uint256 amount,
        uint256 minReceiveQuote,
        bytes calldata data
    ) 
        external 
        returns (uint256);
}
