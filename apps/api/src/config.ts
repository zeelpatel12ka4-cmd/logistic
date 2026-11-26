import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { resolveSecretEncryptionKey } from './services/secretCrypto';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  ipfsApiUrl: string;
  ipfsGatewayUrl: string;
  rpcUrls: string[];
  chainId: number;
  contractAddress: string;
  jwtSecret: string;
  secretEncryptionKey: Buffer;
  siweDomain: string;
  corsOrigins: string[];
  relayerPrivateKey: string;
}

export function resolveContractAddress(): string {
  if (process.env.CONTRACT_ADDRESS) return process.env.CONTRACT_ADDRESS;
  const deploymentsPath = path.resolve(__dirname, '../../../packages/contracts/deployments.json');
  if (fs.existsSync(deploymentsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as {
        contractAddress?: string;
      };
      if (parsed.contractAddress) return parsed.contractAddress;
    } catch {
      // ignore malformed deployments file
    }
  }
  return '';
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const rawJwtSecret = process.env.JWT_SECRET || '';
  const isDefaultSecret =
    !rawJwtSecret ||
    rawJwtSecret === 'dev_only_change_me_at_least_32_characters_long' ||
    rawJwtSecret.length < 32;

  if (nodeEnv === 'production' && isDefaultSecret) {
    throw new Error('JWT_SECRET must be set to a strong >=32 char secret in production');
  }

  return {
    nodeEnv,
    port: Number(process.env.API_PORT || '4000'),
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace',
    ipfsApiUrl: process.env.IPFS_API_URL || 'http://127.0.0.1:5001',
    ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || 'http://127.0.0.1:8080',
    rpcUrls: (process.env.RPC_URLS || 'http://127.0.0.1:8545')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    chainId: Number(process.env.CHAIN_ID || '31337'),
    contractAddress: resolveContractAddress(),
    jwtSecret: rawJwtSecret || 'dev_only_change_me_at_least_32_characters_long',
    secretEncryptionKey: resolveSecretEncryptionKey(process.env.SECRET_ENCRYPTION_KEY, nodeEnv),
    siweDomain: process.env.SIWE_DOMAIN || 'localhost:3000',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || '',
  };
}
