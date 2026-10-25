// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Trivial target contract used by the tests to prove that governance can execute arbitrary calls.
contract Box {
    uint256 public value;

    event ValueChanged(uint256 newValue);

    function store(uint256 newValue) external {
        value = newValue;
        emit ValueChanged(newValue);
    }

    function alwaysReverts() external pure {
        revert("Box: nope");
    }
}
