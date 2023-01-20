pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockLpToken is ERC20("MockLP", "LP") {
    address public token0;
    address public token1;

    uint112 public reserve0;
    uint112 public reserve1;

    uint32 public blockTimestampLast;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function setToken0(address _token0) external {
        token0 = _token0;
    }

    function setToken1(address _token1) external {
        token1 = _token1;
    }

    function setReserves(uint112 _reserve0, uint112 _reserve1) external {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
    }

    function getReserves()
        public
        view
        returns (
            uint112 _reserve0,
            uint112 _reserve1,
            uint32 _blockTimestampLast
        )
    {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
