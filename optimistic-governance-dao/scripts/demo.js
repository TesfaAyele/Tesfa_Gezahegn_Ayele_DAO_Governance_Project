// A guided walkthrough of the full lifecycle on Hardhat's in-process network:
//
//   npx hardhat run scripts/demo.js
//
// Scenario A: a proposal nobody objects to passes "lazily" after the time-lock.
// Scenario B: a proposal is stopped by the Guardian Council.
// Scenario C: a proposal is stopped by a token-holder challenge.

const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const NAMES = ["Active", "Vetoed", "Succeeded", "Executed", "Canceled", "Expired"];
const E = (n) => ethers.parseEther(String(n));

async function main() {
  const [deployer, proposer, g1, g2, g3, alice, bob] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("GovernanceToken")).deploy(deployer.address, E(1_000_000));
  await token.transfer(alice.address, E(60_000));
  await token.transfer(bob.address, E(60_000));
  await token.connect(alice).delegate(alice.address);
  await token.connect(bob).delegate(bob.address);

  const gov = await (await ethers.getContractFactory("OptimisticGovernor")).deploy(
    token.target, 7 * DAY, 7 * DAY, 1000, 2, [proposer.address], [g1.address, g2.address, g3.address]
  );
  const box = await (await ethers.getContractFactory("Box")).deploy();

  async function propose(value, description) {
    const targets = [box.target];
    const values = [0];
    const calldatas = [box.interface.encodeFunctionData("store", [value])];
    await gov.connect(proposer).propose(targets, values, calldatas, description);
    const id = await gov.hashProposal(targets, values, calldatas, ethers.id(description));
    return { id, targets, values, calldatas, descriptionHash: ethers.id(description) };
  }
  const stateOf = async (p) => NAMES[Number(await gov.state(p.id))];
  const exec = (p) => gov.execute(p.targets, p.values, p.calldatas, p.descriptionHash);

  console.log("--- Scenario A: lazy approval ---");
  const a = await propose(1, "A: set value to 1");
  console.log("right after proposing:       ", await stateOf(a));
  await time.increase(7 * DAY + 1);
  console.log("after 7 days, no objections: ", await stateOf(a));
  await exec(a);
  console.log("after execute:               ", await stateOf(a), "| box.value =", (await box.value()).toString());

  console.log("\n--- Scenario B: Guardian Council veto (2 of 3) ---");
  const b = await propose(2, "B: set value to 2");
  await gov.connect(g1).guardianVeto(b.id);
  console.log("after 1 guardian veto:       ", await stateOf(b));
  await gov.connect(g2).guardianVeto(b.id);
  console.log("after 2 guardian vetoes:     ", await stateOf(b));

  console.log("\n--- Scenario C: token-holder challenge (10% of supply = 100,000 OGT) ---");
  const c = await propose(3, "C: set value to 3");
  await mine(1);
  await gov.connect(alice).challenge(c.id);
  console.log("alice challenges (60,000):   ", await stateOf(c));
  await gov.connect(bob).challenge(c.id);
  console.log("bob challenges (+60,000):    ", await stateOf(c));
  console.log("box.value is still:          ", (await box.value()).toString(), "(vetoed proposals never execute)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
