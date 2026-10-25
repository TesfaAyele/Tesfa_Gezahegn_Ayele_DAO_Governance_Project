const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const DELAY = 7 * DAY; // challenge window
const GRACE = 7 * DAY; // execution window
const THRESHOLD_BPS = 1000; // 10% of supply can veto
const GUARDIAN_THRESHOLD = 2; // 2-of-3 guardians can veto
const E = (n) => ethers.parseEther(String(n));

// Mirrors the Solidity enum
const State = { Active: 0n, Vetoed: 1n, Succeeded: 2n, Executed: 3n, Canceled: 4n, Expired: 5n };

async function deployFixture() {
  const [deployer, proposer, g1, g2, g3, alice, bob, carol, outsider] = await ethers.getSigners();

  // Token: 1,000,000 supply -> a 10% veto threshold is 100,000 tokens.
  const token = await (await ethers.getContractFactory("GovernanceToken")).deploy(deployer.address, E(1_000_000));
  await token.waitForDeployment();
  await token.transfer(alice.address, E(60_000));
  await token.transfer(bob.address, E(60_000));
  await token.transfer(carol.address, E(30_000));
  for (const s of [alice, bob, carol]) {
    await token.connect(s).delegate(s.address); // voting power only exists after delegation
  }

  const gov = await (await ethers.getContractFactory("OptimisticGovernor")).deploy(
    token.target,
    DELAY,
    GRACE,
    THRESHOLD_BPS,
    GUARDIAN_THRESHOLD,
    [proposer.address],
    [g1.address, g2.address, g3.address]
  );
  await gov.waitForDeployment();

  const box = await (await ethers.getContractFactory("Box")).deploy();
  await box.waitForDeployment();

  return { token, gov, box, deployer, proposer, g1, g2, g3, alice, bob, carol, outsider };
}

function boxProposal(box, newValue = 42, description = "Set the box value") {
  return {
    targets: [box.target],
    values: [0n],
    calldatas: [box.interface.encodeFunctionData("store", [newValue])],
    description,
    descriptionHash: ethers.id(description),
  };
}

async function submit(gov, signer, p) {
  await gov.connect(signer).propose(p.targets, p.values, p.calldatas, p.description);
  return gov.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);
}

function run(gov, p, signer) {
  const c = signer ? gov.connect(signer) : gov;
  return c.execute(p.targets, p.values, p.calldatas, p.descriptionHash);
}

describe("OptimisticGovernor", () => {
  describe("deployment", () => {
    it("stores the configuration and assigns roles", async () => {
      const { gov, token, proposer, g1, g2, g3, deployer } = await loadFixture(deployFixture);

      expect(await gov.token()).to.equal(token.target);
      expect(await gov.delay()).to.equal(DELAY);
      expect(await gov.gracePeriod()).to.equal(GRACE);
      expect(await gov.challengeThresholdBps()).to.equal(THRESHOLD_BPS);
      expect(await gov.guardianThreshold()).to.equal(GUARDIAN_THRESHOLD);

      expect(await gov.hasRole(await gov.PROPOSER_ROLE(), proposer.address)).to.equal(true);
      for (const g of [g1, g2, g3]) {
        expect(await gov.hasRole(await gov.GUARDIAN_ROLE(), g.address)).to.equal(true);
      }
      // The governor administers itself; the deployer keeps no special power.
      expect(await gov.hasRole(await gov.DEFAULT_ADMIN_ROLE(), gov.target)).to.equal(true);
      expect(await gov.hasRole(await gov.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
    });

    it("rejects invalid parameters", async () => {
      const { gov, token, proposer, g1, g2, g3 } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory("OptimisticGovernor");
      const guardians = [g1.address, g2.address, g3.address];

      // delay below the 1 hour floor
      await expect(Factory.deploy(token.target, 60, GRACE, 1000, 2, [proposer.address], guardians)).to.be.revertedWithCustomError(gov, "InvalidParameter");
      // more required vetoes than guardians
      await expect(Factory.deploy(token.target, DELAY, GRACE, 1000, 4, [proposer.address], guardians)).to.be.revertedWithCustomError(gov, "InvalidParameter");
      // 0% threshold would make every proposal unstoppable by tokens
      await expect(Factory.deploy(token.target, DELAY, GRACE, 0, 2, [proposer.address], guardians)).to.be.revertedWithCustomError(gov, "InvalidParameter");
    });
  });

  describe("proposing", () => {
    it("only lets proposers create proposals", async () => {
      const { gov, box, alice } = await loadFixture(deployFixture);
      const p = boxProposal(box);
      await expect(gov.connect(alice).propose(p.targets, p.values, p.calldatas, p.description)).to.be.revertedWithCustomError(gov, "AccessControlUnauthorizedAccount");
    });

    it("creates an Active proposal with a fixed snapshot, window and threshold", async () => {
      const { gov, box, proposer } = await loadFixture(deployFixture);
      const p = boxProposal(box);

      await expect(gov.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description)).to.emit(gov, "ProposalCreated");
      const id = await gov.hashProposal(p.targets, p.values, p.calldatas, p.descriptionHash);

      expect(await gov.state(id)).to.equal(State.Active);
      const stored = await gov.getProposal(id);
      expect(stored.proposer).to.equal(proposer.address);
      expect(stored.challengeThreshold).to.equal(E(100_000)); // 10% of 1,000,000
      expect(stored.challengeEnd).to.equal(BigInt(await time.latest()) + BigInt(DELAY));
    });

    it("rejects empty, mismatched and duplicate proposals", async () => {
      const { gov, box, proposer } = await loadFixture(deployFixture);
      const p = boxProposal(box);

      await expect(gov.connect(proposer).propose([], [], [], "nothing")).to.be.revertedWithCustomError(gov, "EmptyProposal");
      await expect(gov.connect(proposer).propose(p.targets, [], p.calldatas, "bad")).to.be.revertedWithCustomError(gov, "ArrayLengthMismatch");

      await gov.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description);
      await expect(gov.connect(proposer).propose(p.targets, p.values, p.calldatas, p.description)).to.be.revertedWithCustomError(gov, "ProposalAlreadyExists");
    });

    it("reverts on unknown proposal ids", async () => {
      const { gov } = await loadFixture(deployFixture);
      await expect(gov.state(123)).to.be.revertedWithCustomError(gov, "UnknownProposal");
    });
  });

  describe("passing by default (no veto)", () => {
    it("cannot be executed while the challenge window is open", async () => {
      const { gov, box, proposer } = await loadFixture(deployFixture);
      const p = boxProposal(box);
      await submit(gov, proposer, p);

      await time.increase(DELAY - 60);
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "WrongState");
      expect(await box.value()).to.equal(0n);
    });

    it("passes automatically after the window and anyone can execute it", async () => {
      const { gov, box, proposer, outsider } = await loadFixture(deployFixture);
      const p = boxProposal(box, 42);
      const id = await submit(gov, proposer, p);

      await time.increase(DELAY + 1);
      expect(await gov.state(id)).to.equal(State.Succeeded);

      await expect(run(gov, p, outsider)).to.emit(gov, "ProposalExecuted").withArgs(id);
      expect(await box.value()).to.equal(42n);
      expect(await gov.state(id)).to.equal(State.Executed);
    });

    it("cannot be executed twice", async () => {
      const { gov, box, proposer } = await loadFixture(deployFixture);
      const p = boxProposal(box);
      await submit(gov, proposer, p);
      await time.increase(DELAY + 1);

      await run(gov, p);
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "WrongState");
    });

    it("expires if nobody executes it within the grace period", async () => {
      const { gov, box, proposer } = await loadFixture(deployFixture);
      const p = boxProposal(box);
      const id = await submit(gov, proposer, p);

      await time.increase(DELAY + GRACE + 10);
      expect(await gov.state(id)).to.equal(State.Expired);
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "WrongState");
    });

    it("bubbles up a failing call as CallFailed", async () => {
      const { gov, box, proposer } = await loadFixture(deployFixture);
      const p = {
        targets: [box.target],
        values: [0n],
        calldatas: [box.interface.encodeFunctionData("alwaysReverts")],
        description: "this will fail",
        descriptionHash: ethers.id("this will fail"),
      };
      await submit(gov, proposer, p);
      await time.increase(DELAY + 1);
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "CallFailed");
    });

    it("can spend treasury ETH held by the governor", async () => {
      const { gov, proposer, deployer, outsider } = await loadFixture(deployFixture);
      await deployer.sendTransaction({ to: gov.target, value: E(2) });

      const p = {
        targets: [outsider.address],
        values: [E(1)],
        calldatas: ["0x"],
        description: "Pay outsider 1 ETH",
        descriptionHash: ethers.id("Pay outsider 1 ETH"),
      };
      await submit(gov, proposer, p);
      await time.increase(DELAY + 1);

      await expect(run(gov, p)).to.changeEtherBalances([gov, outsider], [-E(1), E(1)]);
    });
  });

  describe("Guardian Council veto", () => {
    it("vetoes once the guardian threshold (2 of 3) is reached", async () => {
      const { gov, box, proposer, g1, g2 } = await loadFixture(deployFixture);
      const p = boxProposal(box);
      const id = await submit(gov, proposer, p);

      await expect(gov.connect(g1).guardianVeto(id)).to.emit(gov, "GuardianVetoCast");
      expect(await gov.state(id)).to.equal(State.Active); // 1 of 2 needed

      await expect(gov.connect(g2).guardianVeto(id)).to.emit(gov, "ProposalVetoed").withArgs(id, 0);
      expect(await gov.state(id)).to.equal(State.Vetoed);

      await time.increase(DELAY + 1);
      expect(await gov.state(id)).to.equal(State.Vetoed); // staying vetoed after the window
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "WrongState");
      expect(await box.value()).to.equal(0n);
    });

    it("does not let one guardian veto twice or non-guardians veto at all", async () => {
      const { gov, box, proposer, g1, alice } = await loadFixture(deployFixture);
      const id = await submit(gov, proposer, boxProposal(box));

      await gov.connect(g1).guardianVeto(id);
      await expect(gov.connect(g1).guardianVeto(id)).to.be.revertedWithCustomError(gov, "AlreadyVetoed");
      await expect(gov.connect(alice).guardianVeto(id)).to.be.revertedWithCustomError(gov, "AccessControlUnauthorizedAccount");
    });

    it("cannot veto after the challenge window has closed", async () => {
      const { gov, box, proposer, g1 } = await loadFixture(deployFixture);
      const id = await submit(gov, proposer, boxProposal(box));

      await time.increase(DELAY + 1);
      await expect(gov.connect(g1).guardianVeto(id)).to.be.revertedWithCustomError(gov, "WrongState");
    });

    it("prevents the council from shrinking below its veto threshold", async () => {
      const { gov, g1, g2, g3 } = await loadFixture(deployFixture);
      const role = await gov.GUARDIAN_ROLE();

      await gov.connect(g3).renounceRole(role, g3.address); // 3 -> 2 guardians, threshold is 2: ok
      await expect(gov.connect(g2).renounceRole(role, g2.address)).to.be.revertedWithCustomError(gov, "GuardianQuorumBroken");
      expect(await gov.hasRole(role, g1.address)).to.equal(true);
    });
  });

  describe("token-holder challenge", () => {
    it("vetoes once challengers reach the threshold (10% of supply)", async () => {
      const { gov, box, proposer, alice, bob, carol } = await loadFixture(deployFixture);
      const id = await submit(gov, proposer, boxProposal(box));
      await mine(1);

      await gov.connect(carol).challenge(id); // 30k
      await gov.connect(alice).challenge(id); // +60k = 90k, still below 100k
      expect(await gov.state(id)).to.equal(State.Active);
      expect((await gov.getProposal(id)).challengeWeight).to.equal(E(90_000));

      await expect(gov.connect(bob).challenge(id)).to.emit(gov, "ProposalVetoed").withArgs(id, 1); // +60k = 150k
      expect(await gov.state(id)).to.equal(State.Vetoed);
    });

    it("lets a proposal pass when challenges stay below the threshold", async () => {
      const { gov, box, proposer, alice } = await loadFixture(deployFixture);
      const p = boxProposal(box, 7);
      const id = await submit(gov, proposer, p);
      await mine(1);

      await gov.connect(alice).challenge(id); // 60k < 100k
      await time.increase(DELAY + 1);

      expect(await gov.state(id)).to.equal(State.Succeeded);
      await run(gov, p);
      expect(await box.value()).to.equal(7n);
    });

    it("rejects double challenges and zero-power challengers", async () => {
      const { gov, box, proposer, alice, outsider } = await loadFixture(deployFixture);
      const id = await submit(gov, proposer, boxProposal(box));
      await mine(1);

      await gov.connect(alice).challenge(id);
      await expect(gov.connect(alice).challenge(id)).to.be.revertedWithCustomError(gov, "AlreadyChallenged");
      await expect(gov.connect(outsider).challenge(id)).to.be.revertedWithCustomError(gov, "NoVotingPower");
    });

    it("ignores tokens acquired after the proposal snapshot (flash-loan / vote-buying protection)", async () => {
      const { gov, token, box, proposer, deployer, outsider } = await loadFixture(deployFixture);
      const id = await submit(gov, proposer, boxProposal(box));

      // Whale appears after the proposal was created
      await token.connect(deployer).transfer(outsider.address, E(500_000));
      await token.connect(outsider).delegate(outsider.address);
      await mine(1);

      await expect(gov.connect(outsider).challenge(id)).to.be.revertedWithCustomError(gov, "NoVotingPower");
      expect(await gov.state(id)).to.equal(State.Active);
    });

    it("does not count undelegated tokens", async () => {
      const { gov, token, box, proposer, deployer, outsider } = await loadFixture(deployFixture);
      await token.connect(deployer).transfer(outsider.address, E(500_000)); // never delegates
      await mine(1);
      const id = await submit(gov, proposer, boxProposal(box));
      await mine(1);

      await expect(gov.connect(outsider).challenge(id)).to.be.revertedWithCustomError(gov, "NoVotingPower");
    });
  });

  describe("cancelling", () => {
    it("lets the proposer withdraw their proposal, nobody else", async () => {
      const { gov, box, proposer, alice } = await loadFixture(deployFixture);
      const p = boxProposal(box);
      const id = await submit(gov, proposer, p);

      await expect(gov.connect(alice).cancel(id)).to.be.revertedWithCustomError(gov, "NotProposer");
      await expect(gov.connect(proposer).cancel(id)).to.emit(gov, "ProposalCanceled").withArgs(id);
      expect(await gov.state(id)).to.equal(State.Canceled);

      await time.increase(DELAY + 1);
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "WrongState");
    });
  });

  describe("self-governance", () => {
    it("rejects direct calls to governance-only setters", async () => {
      const { gov, alice, proposer } = await loadFixture(deployFixture);
      await expect(gov.connect(alice).setDelay(2 * DAY)).to.be.revertedWithCustomError(gov, "NotGovernance");
      await expect(gov.connect(proposer).setGuardianThreshold(1)).to.be.revertedWithCustomError(gov, "NotGovernance");
    });

    it("changes its own delay through a proposal that survives the window", async () => {
      const { gov, proposer } = await loadFixture(deployFixture);
      const description = "Shorten the challenge window to 2 days";
      const p = {
        targets: [gov.target],
        values: [0n],
        calldatas: [gov.interface.encodeFunctionData("setDelay", [2 * DAY])],
        description,
        descriptionHash: ethers.id(description),
      };
      await submit(gov, proposer, p);
      await time.increase(DELAY + 1);
      await run(gov, p);

      expect(await gov.delay()).to.equal(2 * DAY);
    });

    it("manages roles through proposals (add a guardian)", async () => {
      const { gov, proposer, outsider } = await loadFixture(deployFixture);
      const role = await gov.GUARDIAN_ROLE();
      const description = "Appoint a new guardian";
      const p = {
        targets: [gov.target],
        values: [0n],
        calldatas: [gov.interface.encodeFunctionData("grantRole", [role, outsider.address])],
        description,
        descriptionHash: ethers.id(description),
      };
      await submit(gov, proposer, p);
      await time.increase(DELAY + 1);
      await run(gov, p);

      expect(await gov.hasRole(role, outsider.address)).to.equal(true);
    });

    it("can be stopped by guardians when a proposal tries to hijack governance", async () => {
      const { gov, proposer, outsider, g1, g2 } = await loadFixture(deployFixture);
      const role = await gov.PROPOSER_ROLE();
      const description = "Malicious: make outsider a proposer";
      const p = {
        targets: [gov.target],
        values: [0n],
        calldatas: [gov.interface.encodeFunctionData("grantRole", [role, outsider.address])],
        description,
        descriptionHash: ethers.id(description),
      };
      const id = await submit(gov, proposer, p);
      await gov.connect(g1).guardianVeto(id);
      await gov.connect(g2).guardianVeto(id);

      await time.increase(DELAY + 1);
      await expect(run(gov, p)).to.be.revertedWithCustomError(gov, "WrongState");
      expect(await gov.hasRole(role, outsider.address)).to.equal(false);
    });
  });
});
