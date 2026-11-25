import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { RpcFailoverPool } from '@chaintrace/shared';
import { ReorgSafeIndexer } from './indexer';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function resolveContractAddress(): string {
  if (process.env.CONTRACT_ADDRESS) return process.env.CONTRACT_ADDRESS;
  const deploymentsPath = path.resolve(__dirname, '../../../packages/contracts/deployments.json');
  if (fs.existsSync(deploymentsPath)) {
    const parsed = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
    if (parsed.contractAddress) return parsed.contractAddress;
  }
  return '';
}

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace';
  const rpcUrls = (process.env.RPC_URLS || 'http://127.0.0.1:8545').split(',');
  const chainId = Number(process.env.CHAIN_ID || '31337');
  const confirmationsRequired = Number(process.env.CONFIRMATIONS_REQUIRED || '2');
  const pollIntervalMs = Number(process.env.INDEXER_POLL_INTERVAL_MS || '1500');
  const initialChunkSize = Number(process.env.INDEXER_CHUNK_SIZE || '2000');

  const contractAddress = resolveContractAddress();
  if (!contractAddress) {
    throw new Error('CONTRACT_ADDRESS is not set and packages/contracts/deployments.json not found');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const rpcPool = new RpcFailoverPool({ urls: rpcUrls, chainId });
  const indexer = new ReorgSafeIndexer(pool, rpcPool, {
    chainId,
    contractAddress,
    confirmationsRequired,
    initialChunkSize,
  });

  console.log(
    `ChainTrace Indexer started for contract ${contractAddress} on chainId=${chainId} (confirmations=${confirmationsRequired})`,
  );

  let running = true;
  process.on('SIGINT', () => {
    running = false;
  });
  process.on('SIGTERM', () => {
    running = false;
  });

  while (running) {
    try {
      const report = await indexer.syncOnce();
      if (report.eventsProcessed > 0 || report.failedTxsDetected > 0 || report.reorgDetected) {
        console.log('[Indexer Sync]', JSON.stringify(report));
      }
    } catch (err) {
      console.error('[Indexer Error]', err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  await rpcPool.destroy();
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal indexer startup failure:', err);
    process.exit(1);
  });
}
