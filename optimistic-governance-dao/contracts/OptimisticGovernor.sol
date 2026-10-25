// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";

/// @title OptimisticGovernor ("Lazy Governance")
/// @notice A DAO governor built to fix voter fatigue and low turnout.
///
///         Instead of asking every token holder to vote on every proposal, proposals created by
///         trusted contributors (PROPOSER_ROLE) PASS BY DEFAULT once a time-lock window (e.g. 7 days)
///         elapses. During that window the proposal can be stopped in two ways:
///
///           1. Guardian Council veto: `guardianThreshold` distinct GUARDIAN_ROLE members call
///              `guardianVeto`.
///           2. Token-holder challenge: holders call `challenge`; once the combined voting power
///              (measured at a snapshot taken at proposal creation) reaches
///              `challengeThresholdBps` of total supply, the proposal is vetoed.
///
///         If neither happens, anyone can `execute` the proposal during the grace period.
///
///         The contract governs itself: its parameters and roles can only be changed by a proposal
///         that has itself survived the challenge window (the governor holds DEFAULT_ADMIN_ROLE).
contract OptimisticGovernor is AccessControlEnumerable, ReentrancyGuard {
    // ------------------------------------------------------------------ roles & constants

    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 public constant MAX_BPS = 10_000;
    uint48 public constant MIN_DELAY = 1 hours; // safety floor for the challenge window
    uint48 public constant MIN_GRACE_PERIOD = 1 days; // safety floor for the execution window

    // ------------------------------------------------------------------ types

    enum ProposalState {
        Active, // challenge window open: can be vetoed or challenged
        Vetoed, // stopped by guardians or token holders
        Succeeded, // window elapsed with no veto: executable
        Executed,
        Canceled, // withdrawn by its proposer
        Expired // nobody executed it before the grace period ended
    }

    enum VetoSource {
        Guardians,
        TokenHolders
    }

    struct Proposal {
        address proposer;
        uint48 snapshot; // token clock value used for challenge voting power
        uint48 challengeEnd; // timestamp when the challenge window closes
        uint48 executableUntil; // timestamp after which the proposal expires
        bool executed;
        bool canceled;
        bool vetoed;
        uint32 guardianVetoes;
        uint256 challengeThreshold; // voting power needed to veto (fixed at creation)
        uint256 challengeWeight; // voting power that has challenged so far
    }

    // ------------------------------------------------------------------ storage

    IERC5805 public immutable token;

    uint48 public delay; // length of the challenge window (seconds)
    uint48 public gracePeriod; // how long a passed proposal stays executable (seconds)
    uint16 public challengeThresholdBps; // % of total supply (in bps) needed to veto
    uint32 public guardianThreshold; // guardian vetoes needed to veto

    mapping(uint256 id => Proposal) private _proposals;
    mapping(uint256 id => mapping(address account => bool)) public hasChallenged;
    mapping(uint256 id => mapping(address guardian => bool)) public hasGuardianVetoed;

    // ------------------------------------------------------------------ events

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        address[] targets,
        uint256[] values,
        bytes[] calldatas,
        string description,
        uint48 challengeEnd,
        uint48 executableUntil
    );
    event ProposalChallenged(uint256 indexed id, address indexed account, uint256 weight, uint256 totalWeight);
    event GuardianVetoCast(uint256 indexed id, address indexed guardian, uint256 totalGuardianVetoes);
    event ProposalVetoed(uint256 indexed id, VetoSource source);
    event ProposalCanceled(uint256 indexed id);
    event ProposalExecuted(uint256 indexed id);

    event DelaySet(uint48 oldDelay, uint48 newDelay);
    event GracePeriodSet(uint48 oldGracePeriod, uint48 newGracePeriod);
    event ChallengeThresholdBpsSet(uint16 oldBps, uint16 newBps);
    event GuardianThresholdSet(uint32 oldThreshold, uint32 newThreshold);

    // ------------------------------------------------------------------ errors

    error NotGovernance();
    error InvalidParameter();
    error EmptyProposal();
    error ArrayLengthMismatch();
    error ProposalAlreadyExists(uint256 id);
    error UnknownProposal(uint256 id);
    error WrongState(uint256 id, ProposalState current);
    error NotProposer();
    error AlreadyChallenged();
    error AlreadyVetoed();
    error NoVotingPower();
    error NoVotingSupply();
    error GuardianQuorumBroken();
    error CallFailed(uint256 index, bytes returndata);

    // ------------------------------------------------------------------ modifiers

    /// @dev Only the governor itself (i.e. an executed proposal) may call.
    modifier onlyGovernance() {
        if (msg.sender != address(this)) revert NotGovernance();
        _;
    }

    // ------------------------------------------------------------------ constructor

    /// @param token_ ERC-20 token with ERC-5805 voting (e.g. GovernanceToken)
    /// @param delay_ challenge window in seconds (e.g. 7 days)
    /// @param gracePeriod_ execution window after the challenge window, in seconds
    /// @param challengeThresholdBps_ share of total supply (basis points) that can veto, e.g. 1000 = 10%
    /// @param guardianThreshold_ number of guardians that must veto, e.g. 2 of 3
    /// @param proposers trusted contributors allowed to create proposals
    /// @param guardians members of the Guardian Council
    constructor(
        IERC5805 token_,
        uint48 delay_,
        uint48 gracePeriod_,
        uint16 challengeThresholdBps_,
        uint32 guardianThreshold_,
        address[] memory proposers,
        address[] memory guardians
    ) {
        if (address(token_) == address(0)) revert InvalidParameter();
        token = token_;

        _setDelay(delay_);
        _setGracePeriod(gracePeriod_);
        _setChallengeThresholdBps(challengeThresholdBps_);

        // The governor administers itself: roles can only change through a surviving proposal.
        _grantRole(DEFAULT_ADMIN_ROLE, address(this));

        for (uint256 i = 0; i < proposers.length; ++i) {
            _grantRole(PROPOSER_ROLE, proposers[i]);
        }
        for (uint256 i = 0; i < guardians.length; ++i) {
            _grantRole(GUARDIAN_ROLE, guardians[i]);
        }

        // Validated against the guardian count, so it must come after the grants.
        _setGuardianThreshold(guardianThreshold_);
    }

    /// @dev The governor can hold ETH (a treasury) and spend it through proposals.
    receive() external payable {}

    // ------------------------------------------------------------------ proposing

    /// @notice Create a proposal. It passes automatically after `delay` unless vetoed.
    function propose(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        string calldata description
    ) external onlyRole(PROPOSER_ROLE) returns (uint256 id) {
        if (targets.length == 0) revert EmptyProposal();
        if (targets.length != values.length || targets.length != calldatas.length) revert ArrayLengthMismatch();

        id = hashProposal(targets, values, calldatas, keccak256(bytes(description)));
        Proposal storage p = _proposals[id];
        if (p.proposer != address(0)) revert ProposalAlreadyExists(id);

        // Voting power is read one clock tick in the past, so tokens moved in the same block as
        // the proposal (e.g. flash loans) can never count towards a challenge.
        uint48 snapshot = token.clock() - 1;
        uint256 threshold = (token.getPastTotalSupply(snapshot) * challengeThresholdBps) / MAX_BPS;
        if (threshold == 0) revert NoVotingSupply();

        uint48 challengeEnd = uint48(block.timestamp) + delay;
        uint48 executableUntil = challengeEnd + gracePeriod;

        p.proposer = msg.sender;
        p.snapshot = snapshot;
        p.challengeEnd = challengeEnd;
        p.executableUntil = executableUntil;
        p.challengeThreshold = threshold;

        // snapshot and challengeThreshold can be read back with getProposal(id)
        emit ProposalCreated(id, msg.sender, targets, values, calldatas, description, challengeEnd, executableUntil);
    }

    /// @notice The proposer can withdraw their own proposal before it is executed.
    function cancel(uint256 id) external {
        Proposal storage p = _proposals[id];
        ProposalState s = state(id);
        if (s != ProposalState.Active && s != ProposalState.Succeeded) revert WrongState(id, s);
        if (msg.sender != p.proposer) revert NotProposer();

        p.canceled = true;
        emit ProposalCanceled(id);
    }

    // ------------------------------------------------------------------ vetoing

    /// @notice Guardian Council veto. Once `guardianThreshold` distinct guardians have called
    ///         this during the challenge window, the proposal is vetoed.
    function guardianVeto(uint256 id) external onlyRole(GUARDIAN_ROLE) {
        _requireState(id, ProposalState.Active);
        if (hasGuardianVetoed[id][msg.sender]) revert AlreadyVetoed();

        Proposal storage p = _proposals[id];
        hasGuardianVetoed[id][msg.sender] = true;
        uint32 total = ++p.guardianVetoes;
        emit GuardianVetoCast(id, msg.sender, total);

        if (total >= guardianThreshold) {
            p.vetoed = true;
            emit ProposalVetoed(id, VetoSource.Guardians);
        }
    }

    /// @notice Token-holder challenge. Adds the caller's snapshot voting power to the proposal's
    ///         challenge tally; reaching the threshold vetoes the proposal.
    function challenge(uint256 id) external returns (uint256 weight) {
        _requireState(id, ProposalState.Active);
        if (hasChallenged[id][msg.sender]) revert AlreadyChallenged();

        Proposal storage p = _proposals[id];
        weight = token.getPastVotes(msg.sender, p.snapshot);
        if (weight == 0) revert NoVotingPower();

        hasChallenged[id][msg.sender] = true;
        uint256 total = p.challengeWeight + weight;
        p.challengeWeight = total;
        emit ProposalChallenged(id, msg.sender, weight, total);

        if (total >= p.challengeThreshold) {
            p.vetoed = true;
            emit ProposalVetoed(id, VetoSource.TokenHolders);
        }
    }

    // ------------------------------------------------------------------ executing

    /// @notice Execute a proposal that survived its challenge window. Callable by anyone.
    function execute(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) external nonReentrant returns (uint256 id) {
        id = hashProposal(targets, values, calldatas, descriptionHash);
        _requireState(id, ProposalState.Succeeded);

        // effects before interactions
        _proposals[id].executed = true;

        for (uint256 i = 0; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(calldatas[i]);
            if (!ok) revert CallFailed(i, ret);
        }

        emit ProposalExecuted(id);
    }

    // ------------------------------------------------------------------ self-governance

    function setDelay(uint48 newDelay) external onlyGovernance {
        _setDelay(newDelay);
    }

    function setGracePeriod(uint48 newGracePeriod) external onlyGovernance {
        _setGracePeriod(newGracePeriod);
    }

    function setChallengeThresholdBps(uint16 newBps) external onlyGovernance {
        _setChallengeThresholdBps(newBps);
    }

    function setGuardianThreshold(uint32 newThreshold) external onlyGovernance {
        _setGuardianThreshold(newThreshold);
    }

    // ------------------------------------------------------------------ views

    function hashProposal(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(targets, values, calldatas, descriptionHash)));
    }

    function state(uint256 id) public view returns (ProposalState) {
        Proposal storage p = _proposals[id];
        if (p.proposer == address(0)) revert UnknownProposal(id);

        if (p.executed) return ProposalState.Executed;
        if (p.canceled) return ProposalState.Canceled;
        if (p.vetoed) return ProposalState.Vetoed;
        if (block.timestamp < p.challengeEnd) return ProposalState.Active;
        if (block.timestamp > p.executableUntil) return ProposalState.Expired;
        return ProposalState.Succeeded;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        if (_proposals[id].proposer == address(0)) revert UnknownProposal(id);
        return _proposals[id];
    }

    // ------------------------------------------------------------------ internals

    function _requireState(uint256 id, ProposalState expected) internal view {
        ProposalState current = state(id);
        if (current != expected) revert WrongState(id, current);
    }

    function _setDelay(uint48 newDelay) internal {
        if (newDelay < MIN_DELAY) revert InvalidParameter();
        emit DelaySet(delay, newDelay);
        delay = newDelay;
    }

    function _setGracePeriod(uint48 newGracePeriod) internal {
        if (newGracePeriod < MIN_GRACE_PERIOD) revert InvalidParameter();
        emit GracePeriodSet(gracePeriod, newGracePeriod);
        gracePeriod = newGracePeriod;
    }

    function _setChallengeThresholdBps(uint16 newBps) internal {
        if (newBps == 0 || newBps > MAX_BPS) revert InvalidParameter();
        emit ChallengeThresholdBpsSet(challengeThresholdBps, newBps);
        challengeThresholdBps = newBps;
    }

    function _setGuardianThreshold(uint32 newThreshold) internal {
        if (newThreshold == 0 || newThreshold > getRoleMemberCount(GUARDIAN_ROLE)) revert InvalidParameter();
        emit GuardianThresholdSet(guardianThreshold, newThreshold);
        guardianThreshold = newThreshold;
    }

    /// @dev Never let the Guardian Council shrink below the number of vetoes it needs,
    ///      otherwise the guardian veto path would become impossible to use.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        revoked = super._revokeRole(role, account);
        if (revoked && role == GUARDIAN_ROLE && getRoleMemberCount(GUARDIAN_ROLE) < guardianThreshold) {
            revert GuardianQuorumBroken();
        }
    }
}
