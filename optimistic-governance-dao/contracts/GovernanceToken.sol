// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GovernanceToken
/// @notice ERC-20 with checkpointed voting power (ERC20Votes). In the optimistic DAO this token is
///         NOT used to vote "yes" on proposals; it is used to *challenge* them. Holders must
///         delegate (to themselves or to someone else) before their balance counts as voting power.
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
    constructor(address initialOwner, uint256 initialSupply)
        ERC20("Optimistic Governance Token", "OGT")
        ERC20Permit("Optimistic Governance Token")
        Ownable(initialOwner)
    {
        _mint(initialOwner, initialSupply);
    }

    /// @notice Mint new tokens. Ownership should be handed to the governor so minting is itself governed.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // ---- required overrides (ERC20 + ERC20Votes + ERC20Permit) ----

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
