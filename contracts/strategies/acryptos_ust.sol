//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "../interfaces/IZapDepositer.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/IACryptoSFarmV4.sol";
import "../interfaces/IAcryptoSPool.sol";
// import "./interfaces/IExchangeRegistry.sol";
// import "./StrategyRouter.sol";
import "../Exchange.sol";

import "hardhat/console.sol";

contract acryptos_ust is Ownable, IStrategy {
    IZapDepositer public zapDepositer =
        IZapDepositer(0x4deb9077E49269B04Fd0324461aF301dD6600216);
    IERC20 public ust = IERC20(0x23396cF899Ca06c4472205fC903bDB4de249D6fC);
    IERC20 public acsi = IERC20(0x5b17b4d5e4009B5C43e3e3d63A5229F794cBA389);
    IERC20 public lpToken = IERC20(0xD3DEBe4a971e4492d0D61aB145468A5B2c23301b);
    IACryptoSFarmV4 public farm =
        IACryptoSFarmV4(0x0C3B6058c25205345b8f22578B27065a7506671C);

    StrategyRouter public strategyRouter;

    constructor(StrategyRouter _strategyRouter) {
        strategyRouter = _strategyRouter;
    }

    function deposit(uint256 amount) external override onlyOwner {

        console.log("--- deposit call, block: %s", block.number);

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
        console.log("--- withdraw call");

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
        console.log("--- compound call");
        farm.harvest(address(lpToken));
        uint256 acsiAmount = acsi.balanceOf(address(this));
        console.log("acsiAmount", acsiAmount);
        console.log("block.number", block.number);
        if (acsiAmount > 0) {
            Exchange exchange = strategyRouter.exchange();
            acsi.transfer(address(exchange), acsiAmount);
            uint256 amount = exchange.swapRouted(
                acsiAmount,
                acsi,
                ust,
                address(this)
            );
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

    function totalTokens() external view override returns (uint256) {


        console.log("--- totalTokens call");

        (uint256 amountOnFarm, , , ) = farm.userInfo(
            address(lpToken),
            address(this)
        );
        uint256 withdrawableAmount = zapDepositer.calc_withdraw_one_coin(
            amountOnFarm,
            0
        );
        console.log("vp %s, lp to tokens %s, withdrawableAmount %s", 
            IAcryptoSPool(zapDepositer.pool()).get_virtual_price(),
            IAcryptoSPool(zapDepositer.pool()).get_virtual_price() * amountOnFarm / 1e18,
            withdrawableAmount
        );
        // notice: if withdraw all then actual received amount could possibly be slighlty different
        return withdrawableAmount;
    }
}
