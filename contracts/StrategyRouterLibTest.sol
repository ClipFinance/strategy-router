pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@chainlink/contracts/src/v0.8/AutomationCompatible.sol";
import "./deps/OwnableUpgradeable.sol";
import "./deps/Initializable.sol";
import "./deps/UUPSUpgradeable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "./interfaces/IIdleStrategy.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IUsdOracle.sol";
import {ReceiptNFT} from "./ReceiptNFT.sol";
import {Exchange} from "./exchange/Exchange.sol";
import {SharesToken} from "./SharesToken.sol";
import "./Batch.sol";
import "./StrategyRouterLib.sol";
import "./idle-strategies/DefaultIdleStrategy.sol";

// import "hardhat/console.sol";


/// @custom:oz-upgrades-unsafe-allow external-library-linking
contract StrategyRouterLibTest {

    // uint8 private constant UNIFORM_DECIMALS = 18;
    // uint256 private constant PRECISION = 1e18;
    // uint256 private constant MAX_FEE_PERCENT = 2000;
    // uint256 private constant FEE_PERCENT_PRECISION = 100;
    // we do not try to withdraw amount below this threshold
    // cause gas spendings are high compared to this amount
    // uint256 private constant WITHDRAWAL_DUST_THRESHOLD_USD = 1e17; // 10 cents / 0.1 USD

    /// @notice The time of the first deposit that triggered a current cycle
    // uint256 public currentCycleFirstDepositAt;
    /// @notice Current cycle duration in seconds, until funds are allocated from batch to strategies
    // uint256 public allocationWindowTime;
    /// @notice Current cycle counter. Incremented at the end of the cycle
    // uint256 public currentCycleId;
    /// @notice Current cycle deposits counter. Incremented on deposit and decremented on withdrawal.
    // uint256 public currentCycleDepositsCount;
    /// @notice Protocol comission in percents taken from yield. One percent is 100.
    // uint256 public feePercent;

    // ReceiptNFT private receiptContract;
    // Exchange public exchange;
    // IUsdOracle private oracle;
    // SharesToken private sharesToken;
    // Batch private batch;
    // address public feeAddress;

    StrategyRouter.TokenPrice[] public supportedTokenPrices;
    StrategyRouter.StrategyInfo[] public strategies;
    // uint256 public allStrategiesWeightSum;

    // IdleStrategyInfo[] public idleStrategies;

    // mapping(uint256 => Cycle) public cycles;
    // mapping(address => bool) public moderators;

    constructor() { }

    function setStrategies(
        StrategyRouter.StrategyInfo[] calldata _strategies
    ) external {
        for(uint256 i; i < _strategies.length; i++) {
            strategies.push(_strategies[i]);
        }
    }

    function setSupportedTokenPrices(
        StrategyRouter.TokenPrice[] calldata _supportedTokenPrices
    ) external {
        for(uint256 i; i < _supportedTokenPrices.length; i++) {
            supportedTokenPrices.push(_supportedTokenPrices[i]);
        }
    }

    function getStrategyIndexToSupportedTokenIndexMap() 
        public
        view
        returns (uint256[] memory strategyIndexToSupportedTokenIndex)
    {
        return StrategyRouterLib.getStrategyIndexToSupportedTokenIndexMap(
            supportedTokenPrices,
            strategies
        );
    }

}