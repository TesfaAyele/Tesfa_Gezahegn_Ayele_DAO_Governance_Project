# Optimistic Governance DAO ("Lazy Governance")

A Solidity DAO governor that fixes **voter fatigue and low turnout**.

In a standard DAO every proposal needs a quorum of active voters, and most people stop voting. Here the default flips: **proposals from trusted contributors pass automatically after a time-lock (e.g. 7 days) unless someone stops them.**

```
 PROPOSER_ROLE                       challenge window (delay)                 grace period
 creates proposal ───────────────────────────────────────────────▶ passes ───────────────▶ expires
        │                                                              │
        │   Guardian Council veto (M-of-N)  ─┐                         └── anyone can execute()
        └── Token-holder challenge (≥ X%)   ─┴──▶ Vetoed (never executes)
```

## How it works

| Piece | Contract | What it does |
|---|---|---|
| Governance token | `GovernanceToken.sol` | ERC-20 + `ERC20Votes` (checkpointed, delegatable voting power). Used to **challenge**, not to approve. |
| Governor | `OptimisticGovernor.sol` | Creates, vetoes, and executes proposals. Holds a treasury (ETH). Governs itself. |
| Test helper | `mocks/Box.sol` | Trivial target contract used by the tests and demo. |

**Lifecycle of a proposal**

1. A member of `PROPOSER_ROLE` calls `propose(targets, values, calldatas, description)`.
   The contract records a **snapshot** (previous block) and the **challenge threshold**
   (`challengeThresholdBps` of total supply at the snapshot).
2. For `delay` seconds the proposal is `Active`. It can be stopped by either:
   - **Guardian Council**: `guardianThreshold` distinct guardians call `guardianVeto(id)` (e.g. 2 of 3).
   - **Token holders**: holders call `challenge(id)`. Their snapshot voting power is added up; once it reaches the threshold (e.g. 10% of supply) the proposal is vetoed.
3. If nobody vetoes, after `delay` the proposal is `Succeeded`, and **anyone** can call `execute(...)` until `gracePeriod` runs out (then it is `Expired`).
4. The proposer can `cancel(id)` their own proposal any time before it executes.

States: `Active → Vetoed | Succeeded → Executed | Expired`, plus `Canceled`.

**Self-governance.** The governor holds its own `DEFAULT_ADMIN_ROLE`. The setters (`setDelay`, `setGracePeriod`, `setChallengeThresholdBps`, `setGuardianThreshold`) and role management (`grantRole` / `revokeRole`, e.g. appointing guardians or proposers) can only be reached through a proposal that has itself survived the challenge window. No admin key exists.

### Security design notes

- **Snapshot voting power** is read from the block *before* the proposal, so flash-loaned or freshly bought tokens cannot challenge. Holders must `delegate()` (even to themselves) **before** a proposal is created for their tokens to count.
- **Guardian quorum protection:** guardians cannot be removed or renounce below `guardianThreshold`, so the veto path can't be accidentally disabled.
- **Reentrancy:** `execute` marks the proposal executed before making calls and is `nonReentrant`.
- **Parameter floors:** delay ≥ 1 hour, grace period ≥ 1 day.
- **Trust model:** this design trades participation for trust in proposers + guardians. Pick proposers carefully, keep guardians independent, and make sure the veto threshold is reachable by your actual holder base.
- This code has **not been audited**. Get an audit before holding real value.

## Project layout

```
contracts/            GovernanceToken.sol, OptimisticGovernor.sol, mocks/Box.sol
test/                 OptimisticGovernor.test.js
scripts/deploy.js     deploy + save addresses + optional Etherscan verification
scripts/demo.js       narrated walkthrough of the three scenarios
hardhat.config.js     compiler + network config
.env.example          template for your secrets / DAO parameters
```

## Quick start

Requires **Node.js 18, 20 or 22** and npm.

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat run scripts/demo.js     # see the lifecycle printed step by step
```

## Deploying

### 1. Local (free, instant)

```bash
# terminal 1: start a local blockchain with 20 funded accounts
npx hardhat node

# terminal 2: deploy to it
npx hardhat run scripts/deploy.js --network localhost
```

### 2. Sepolia testnet

1. Create a **new throwaway wallet** (e.g. in MetaMask) and copy its private key. Never use a wallet that holds real funds.
2. Get free Sepolia test ETH from a faucet (search "Sepolia faucet"; Alchemy, Infura and others offer one).
3. Get an RPC URL for Sepolia from Alchemy, Infura or QuickNode (free tier is fine).
4. Optional: get a free API key from [etherscan.io](https://etherscan.io/apis) to auto-verify source code.
5. Configure and deploy:

```bash
cp .env.example .env        # then edit .env: SEPOLIA_RPC_URL, PRIVATE_KEY, (ETHERSCAN_API_KEY)
# Strongly recommended: also set PROPOSERS and GUARDIANS (comma-separated addresses)
npx hardhat run scripts/deploy.js --network sepolia
```

The script prints both addresses and writes them to `deployments/sepolia.json`.
If you skipped the Etherscan key, verify later with:

```bash
npx hardhat verify --network sepolia <TOKEN_ADDRESS> <DEPLOYER_ADDRESS> 1000000000000000000000000
```

(The governor has array arguments, so it is easier to let `deploy.js` verify it with an Etherscan key set.)

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PROPOSERS` | deployer | Trusted contributors who can create proposals |
| `GUARDIANS` | deployer | Guardian Council members |
| `GUARDIAN_THRESHOLD` | min(2, #guardians) | Guardian vetoes needed to stop a proposal |
| `DELAY_SECONDS` | 604800 (7 days) | Challenge window |
| `GRACE_PERIOD_SECONDS` | 604800 (7 days) | How long a passed proposal stays executable |
| `CHALLENGE_THRESHOLD_BPS` | 1000 (10%) | Share of supply that can veto |
| `INITIAL_SUPPLY` | 1000000 | Whole tokens minted to the deployer |
| `TRANSFER_TOKEN_OWNERSHIP` | false | Hand minting rights to the governor |

After deploying, distribute tokens and have every holder call `token.delegate(theirOwnAddress)`.

## Putting this project on GitHub

```bash
# one-time Git identity (use the email tied to your GitHub account)
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"

cd optimistic-governance-dao
git init -b main
git add .
git status                      # CHECK: .env and node_modules must NOT be listed
git commit -m "Initial commit: optimistic governance DAO"
```

Create an empty repository on github.com (**New repository**, no README/.gitignore/license since this project has them), then:

```bash
git remote add origin https://github.com/<your-username>/optimistic-governance-dao.git
git push -u origin main
```

GitHub does not accept account passwords for pushes: use a Personal Access Token (Settings → Developer settings → Personal access tokens, "repo" scope) as the password, or sign in through GitHub CLI (`gh auth login`) or Git Credential Manager.

## License

MIT
