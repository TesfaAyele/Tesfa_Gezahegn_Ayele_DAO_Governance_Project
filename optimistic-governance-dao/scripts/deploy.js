// Deploys GovernanceToken + OptimisticGovernor and saves the addresses to deployments/<network>.json
//
//   npx hardhat run scripts/deploy.js                      (in-process test network)
//   npx hardhat run scripts/deploy.js --network localhost  (needs `npx hardhat node` running)
//   npx hardhat run scripts/deploy.js --network sepolia    (needs .env, see .env.example)
//
// Configuration comes from environment variables (see .env.example). Every value has a default
// so the script also works out of the box on a local network.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network } = hre;

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function main() {
  const [deployer] = await ethers.getSigners();
  const isLocal = ["hardhat", "localhost"].includes(network.name);

  const delay = Number(process.env.DELAY_SECONDS || 7 * 24 * 60 * 60); // 7 days
  const gracePeriod = Number(process.env.GRACE_PERIOD_SECONDS || 7 * 24 * 60 * 60); // 7 days
  const challengeBps = Number(process.env.CHALLENGE_THRESHOLD_BPS || 1000); // 10%
  const initialSupply = ethers.parseEther(process.env.INITIAL_SUPPLY || "1000000");

  let proposers = list(process.env.PROPOSERS);
  let guardians = list(process.env.GUARDIANS);
  if (proposers.length === 0) proposers = [deployer.address];
  if (guardians.length === 0) guardians = [deployer.address];
  const guardianThreshold = Number(process.env.GUARDIAN_THRESHOLD || Math.min(2, guardians.length));

  if (!isLocal && (!process.env.PROPOSERS || !process.env.GUARDIANS)) {
    console.warn(
      "WARNING: PROPOSERS and/or GUARDIANS not set; falling back to the deployer address.\n" +
        "         That is fine for a testnet experiment but NOT for a real DAO.\n"
    );
  }

  console.log(`Network:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Proposers: ${proposers.join(", ")}`);
  console.log(`Guardians: ${guardians.join(", ")} (veto needs ${guardianThreshold})`);
  console.log(`Window:    ${delay}s challenge + ${gracePeriod}s grace, ${challengeBps} bps token veto\n`);

  // 1. Token
  const token = await (await ethers.getContractFactory("GovernanceToken")).deploy(deployer.address, initialSupply);
  await token.waitForDeployment();
  console.log(`GovernanceToken:   ${token.target}`);

  // 2. Governor
  const governor = await (await ethers.getContractFactory("OptimisticGovernor")).deploy(
    token.target,
    delay,
    gracePeriod,
    challengeBps,
    guardianThreshold,
    proposers,
    guardians
  );
  await governor.waitForDeployment();
  console.log(`OptimisticGovernor: ${governor.target}`);

  // 3. Optionally make minting itself a governed action
  if (process.env.TRANSFER_TOKEN_OWNERSHIP === "true") {
    await (await token.transferOwnership(governor.target)).wait();
    console.log("Token ownership transferred to the governor (minting now requires a proposal).");
  }

  // 4. Save addresses
  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    token: token.target,
    governor: governor.target,
    constructorArgs: {
      token: { initialOwner: deployer.address, initialSupply: initialSupply.toString() },
      governor: { delay, gracePeriod, challengeBps, guardianThreshold, proposers, guardians },
    },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(deployment, null, 2));
  console.log(`\nSaved deployments/${network.name}.json`);

  // 5. Verify on Etherscan (public networks only)
  if (!isLocal && process.env.ETHERSCAN_API_KEY) {
    console.log("\nWaiting for confirmations before verifying...");
    await token.deploymentTransaction().wait(5);
    await governor.deploymentTransaction().wait(5);
    try {
      await hre.run("verify:verify", {
        address: token.target,
        constructorArguments: [deployer.address, initialSupply],
        contract: "contracts/GovernanceToken.sol:GovernanceToken",
      });
      await hre.run("verify:verify", {
        address: governor.target,
        constructorArguments: [token.target, delay, gracePeriod, challengeBps, guardianThreshold, proposers, guardians],
        contract: "contracts/OptimisticGovernor.sol:OptimisticGovernor",
      });
    } catch (err) {
      console.warn(`Verification failed (you can retry later): ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
