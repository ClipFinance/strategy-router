// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestCurrency is ERC20 {

  using SafeMath for uint256;

  uint8 public _decimals;

  constructor(uint256 _totalSupply, uint8 decimals_) ERC20("ERC20test", "TST") {
    _mint(msg.sender, _totalSupply);
    _decimals = decimals_;
  }

  function decimals() public view virtual override returns (uint8) {
      return _decimals;
  }

}