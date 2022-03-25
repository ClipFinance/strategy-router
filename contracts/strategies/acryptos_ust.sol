//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/IZapDepositer.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IACryptoSFarmV4.sol";
// import "./interfaces/IExchangeRegistry.sol";
// import "./StrategyRouter.sol";

import "hardhat/console.sol";

contract acryptos_ust is Ownable, IStrategy {
    IZapDepositer public zapDepositer =
        IZapDepositer(0x4deb9077E49269B04Fd0324461aF301dD6600216);
    IERC20 public ust = IERC20(0x23396cF899Ca06c4472205fC903bDB4de249D6fC);
    IERC20 public acsi = IERC20(0x5b17b4d5e4009B5C43e3e3d63A5229F794cBA389);
    IERC20 public lpToken = IERC20(0xD3DEBe4a971e4492d0D61aB145468A5B2c23301b);
    IACryptoSFarmV4 public farm =
        IACryptoSFarmV4(0x0C3B6058c25205345b8f22578B27065a7506671C);
    IUniswapV2Router02 public router = IUniswapV2Router02(
        0x10ED43C718714eb63d5aA57B78B54704E256024E
    );

    constructor() {}

    function deposit(uint256 amount) external override onlyOwner {
        console.log("block.number", block.number);
        ust.transferFrom(msg.sender, address(this), amount);
        ust.approve(address(zapDepositer), amount);
        uint256[5] memory amounts;
        amounts[0] = amount;
        zapDepositer.add_liquidity(amounts, 0);
        uint256 lpAmount = lpToken.balanceOf(address(this));
        lpToken.approve(address(farm), lpAmount);
        //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));
        farm.deposit(address(lpToken), lpAmount);
        //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));

        // (uint256 amount, , , ) = farm.userInfo(address(lpToken), address(this));
        //  console.log(lpAmount, amount);
    }

    function withdraw(uint256 amount)
        external
        override
        onlyOwner
        returns (uint256 amountWithdrawn)
    {
        uint256[5] memory amounts;
        amounts[0] = amount;
        // get LP amount from ust amount
        uint256 withdrawAmount = zapDepositer.calc_token_amount(amounts, false);
        console.log("withdrawAmount", withdrawAmount);
        farm.withdraw(address(lpToken), withdrawAmount);
        uint256 lpAmount = lpToken.balanceOf(address(this));
        lpToken.approve(address(zapDepositer), lpAmount);
        amountWithdrawn = zapDepositer.remove_liquidity_one_coin(
            lpAmount,
            0,
            0
        );
        ust.transfer(msg.sender, amountWithdrawn);
    }

    function compound() external override onlyOwner {
        farm.harvest(address(lpToken));
        uint256 acsiAmount = acsi.balanceOf(address(this));
        console.log("acsiAmount", acsiAmount);
        console.log("block.number", block.number);
        if(acsiAmount > 0) {
            uint256 amount = swapExactTokensForTokens(acsiAmount, acsi, ust);
            ust.approve(address(zapDepositer), amount);
            uint256[5] memory amounts;
            amounts[0] = amount;
            zapDepositer.add_liquidity(amounts, 0);
            uint256 lpAmount = lpToken.balanceOf(address(this));
            lpToken.approve(address(farm), lpAmount);
            //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));
            farm.deposit(address(lpToken), lpAmount);
            //  console.log(lpAmount, amount, lpToken.balanceOf(address(this)), lpToken.balanceOf(address(farm)));

            // (uint256 amount, , , ) = farm.userInfo(address(lpToken), address(this));
            //  console.log(lpAmount, amount);
        }
    }

    function totalTokens() external view override onlyOwner returns (uint256) {
        (uint256 amountOnFarm, , , ) = farm.userInfo(
            address(lpToken),
            address(this)
        );
        uint256 withdrawableAmount = zapDepositer.calc_withdraw_one_coin(
            amountOnFarm,
            0
        );
        // notice: if withdraw all then actual received amount could possibly be slighlty different 
        return withdrawableAmount;
    }

    function swapExactTokensForTokens(
        uint256 amountA, 
        IERC20 tokenA, 
        IERC20 tokenB
    ) public returns (uint256 amountReceivedTokenB) {

        tokenA.approve(address(router), amountA);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = router.WETH();
        path[2] = address(tokenB);

        uint256 received = router.swapExactTokensForTokens(
            amountA, 
            0, 
            path, 
            address(this), 
            block.timestamp
        )[path.length - 1];

        return received;
    }
}
