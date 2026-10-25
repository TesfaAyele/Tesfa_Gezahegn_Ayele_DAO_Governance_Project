require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

// Only register the Sepolia network when it is fully configured, so that
// `npx hardhat test` and `npx hardhat compile` work with no .env file at all.
const networks = {};
const looksLikeKey = (k) => /^(0x)?[0-9a-fA-F]{64}$/.test(k || "");
if (SEPOLIA_RPC_URL && looksLikeKey(PRIVATE_KEY)) {
  networks.sepolia = {
    url: SEPOLIA_RPC_URL,
    accounts: [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`],
  };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks,
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
};
