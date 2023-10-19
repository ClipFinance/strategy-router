pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    using SafeMath for uint256;

    uint8 public _decimals;

    constructor(uint256 _totalSupply, uint8 decimals_) ERC20("ERC20test", "TST") {
        // transfer initial supply to transaction origin, because it can deployed by Create2Deployer
        _mint(tx.origin, _totalSupply);
        _decimals = decimals_;
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
