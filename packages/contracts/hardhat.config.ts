import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const sepoliaUrl = process.env.SEPOLIA_RPC_URL || '';
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.28',
    settings: {
      evmVersion: 'cancun',
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },
    localhost: {
      url: process.env.RPC_URLS?.split(',')[0] || 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    ...(sepoliaUrl && deployerKey
      ? {
          sepolia: {
            url: sepoliaUrl,
            accounts: [deployerKey],
            chainId: 11155111,
          },
        }
      : {}),
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    noColors: true,
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  typechain: {
    outDir: 'typechain-types',
    target: 'ethers-v6',
  },
};

export default config;
