// SPDX-License-Identifier: Unlicense
pragma solidity >=0.7.5;

interface IAlgebraPool {
  function globalState() external view returns (
    uint160 price, // The square root of the current price in Q64.96 format
    int24 tick, // The current tick
    uint16 fee, // The current fee in hundredths of a bip, i.e. 1e-6
    uint16 timepointIndex, // The index of the last written timepoint
    uint16 communityFeeToken0, // The community fee represented as a percent of all collected fee in thousandths (1e-3)
    uint16 communityFeeToken1,
    bool unlocked // True if the contract is unlocked, otherwise - false
  );
}