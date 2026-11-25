import { IpfsClient, RpcFailoverPool } from '@chaintrace/shared';
import { loadConfig } from './config';
import { createDbPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { createApp } from './app';

async function main() {
  const config = loadConfig();
  const pool = createDbPool(config.databaseUrl);
  const rpcPool = new RpcFailoverPool({ urls: config.rpcUrls, chainId: config.chainId });
  const ipfsClient = new IpfsClient(config.ipfsApiUrl);

  try {
    await runMigrations(pool);
  } catch (err) {
    console.warn('[API Startup] Warning: migrations could not run at boot:', err);
  }

  const app = createApp({ config, pool, rpcPool, ipfsClient });
  const server = app.listen(config.port, () => {
    console.log(
      `ChainTrace API listening on http://localhost:${config.port} (docs: /api/docs, contract: ${config.contractAddress || 'UNSET'})`,
    );
  });

  const shutdown = async () => {
    server.close();
    await rpcPool.destroy();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal API startup failure:', err);
    process.exit(1);
  });
}
