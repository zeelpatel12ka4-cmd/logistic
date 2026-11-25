import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { performance } from 'perf_hooks';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import {
  buildMerkleTree,
  computeBatchId,
  computeClaimSecretHash,
  computeLeaf,
  computeMetadataHash,
  computeProductId,
  CustodyStatus,
  IpfsClient,
  RpcFailoverPool,
} from '@chaintrace/shared';
import { createApp } from '../apps/api/src/app';
import { loadConfig } from '../apps/api/src/config';
import { runMigrations } from '../apps/api/src/db/migrate';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

async function main() {
  const TARGET_PRODUCTS = 1_000_000;
  const CHUNK_SIZE = 25_000;
  const TOTAL_CONCURRENT_REQUESTS = 10_000;
  const CONCURRENCY_WINDOW = 200;

  const baseDbUrl =
    process.env.DATABASE_URL ||
    'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace';
  const adminPool = new Pool({ connectionString: baseDbUrl });
  const benchDbName = 'chaintrace_benchmark';
  const exists = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [benchDbName]);
  if (!exists.rowCount) await adminPool.query(`CREATE DATABASE ${benchDbName}`);
  await adminPool.end();

  const dbUrlObj = new URL(baseDbUrl);
  dbUrlObj.pathname = `/${benchDbName}`;
  const pool = new Pool({ connectionString: dbUrlObj.toString(), max: 40 });

  await runMigrations(pool);

  // 1. Merkle Tree benchmark for 100,000 leaves
  const mfg = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const batchId = computeBatchId(mfg, 'BENCH-1M-BATCH');
  const metaHash = computeMetadataHash({ sku: 'BENCH-X', units: TARGET_PRODUCTS });

  const merkleStart = performance.now();
  const sampleLeaves: string[] = new Array(100_000);
  for (let i = 0; i < 100_000; i++) {
    const serial = `BM1M-${String(i).padStart(7, '0')}`;
    const pid = computeProductId(mfg, batchId, serial);
    sampleLeaves[i] = computeLeaf({
      batchId,
      productId: pid,
      serialNumber: serial,
      metadataHash: metaHash,
      claimSecretHash: ethers.ZeroHash,
    });
  }
  const tree100k = buildMerkleTree(sampleLeaves);
  const merkleMs = Number((performance.now() - merkleStart).toFixed(2));
  console.log(`[Benchmark] 100,000-leaf Merkle tree built in ${merkleMs} ms (root: ${tree100k.root})`);

  // 2. Seed 1,000,000 products into PostgreSQL if not already present
  const countRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM products WHERE batch_id = $1`,
    [batchId],
  );
  const existingCount = Number(countRes.rows[0].cnt);
  let seedDurationMs = 0;

  if (existingCount < TARGET_PRODUCTS) {
    await pool.query(`TRUNCATE products, batches RESTART IDENTITY CASCADE`);
    await pool.query(
      `INSERT INTO batches (
         batch_id, chain_id, batch_code, product_name, sku, category, manufacturer_name,
         serial_prefix, manufacturer_address, batch_custodian, merkle_root, ipfs_cid,
         unit_count, batch_status, previous_batch_status, onchain_confirmed
       ) VALUES ($1, 31337, 'BENCH-1M-BATCH', 'Benchmark Unit 1M', 'BM-1M', 'Electronics',
                 'ChainTrace Labs', 'BM1M', $2, $2, $3, 'bafybenchmarkcid', $4, 1, 1, TRUE)`,
      [batchId, mfg, tree100k.root, TARGET_PRODUCTS],
    );

    const seedStart = performance.now();
    for (let offset = 0; offset < TARGET_PRODUCTS; offset += CHUNK_SIZE) {
      const len = Math.min(CHUNK_SIZE, TARGET_PRODUCTS - offset);
      const pids = new Array<string>(len);
      const serials = new Array<string>(len);
      const idxs = new Array<number>(len);
      const secretHashes = new Array<string>(len);

      for (let j = 0; j < len; j++) {
        const idx = offset + j;
        const serial = `BM1M-${String(idx).padStart(7, '0')}`;
        pids[j] = ethers.keccak256(ethers.toUtf8Bytes(`pid-${idx}`));
        serials[j] = serial;
        idxs[j] = idx;
        secretHashes[j] = computeClaimSecretHash(`sec-${idx}`);
      }

      await pool.query(
        `INSERT INTO products (
           product_id, batch_id, serial_number, leaf_index, metadata_hash,
           claim_secret_hash, current_custodian, custody_status, previous_status
         )
         SELECT u.product_id, $1, u.serial_number, u.leaf_index, $2,
                u.claim_secret_hash, $3, $4, $4
         FROM UNNEST($5::text[], $6::text[], $7::int[], $8::text[])
           AS u(product_id, serial_number, leaf_index, claim_secret_hash)`,
        [batchId, metaHash, mfg, CustodyStatus.Manufactured, pids, serials, idxs, secretHashes],
      );
    }
    seedDurationMs = Number((performance.now() - seedStart).toFixed(2));
    console.log(`[Benchmark] Seeded 1,000,000 products into Postgres in ${seedDurationMs} ms`);
  } else {
    console.log(`[Benchmark] Found ${existingCount} existing products in benchmark DB`);
  }

  // 3. Measure key indexed query latencies at 1,000,000 rows
  const q1Start = performance.now();
  await pool.query(`SELECT * FROM products WHERE serial_number = 'BM1M-0876543' LIMIT 1`);
  const exactSerialMs = Number((performance.now() - q1Start).toFixed(2));

  const q2Start = performance.now();
  await pool.query(
    `SELECT product_id, serial_number FROM products WHERE current_custodian = $1 AND custody_status = 1 ORDER BY product_id DESC LIMIT 25`,
    [mfg],
  );
  const cursorPageMs = Number((performance.now() - q2Start).toFixed(2));

  // 4. Launch Express API & run 10,000 concurrent requests across 1M-row table
  const rpcPool = new RpcFailoverPool({
    urls: ['http://127.0.0.1:59999'],
    requestTimeoutMs: 50,
    failureThreshold: 1,
    cooldownMs: 60_000,
  });
  const ipfsClient = new IpfsClient(process.env.IPFS_API_URL || 'http://127.0.0.1:5001');
  const app = createApp({
    config: { ...loadConfig(), contractAddress: '', chainId: 31337 },
    pool,
    rpcPool,
    ipfsClient,
  });

  let server: http.Server;
  await new Promise<void>((resolve) => {
    server = app.listen(4098, () => resolve());
  });

  const latencies: number[] = [];
  let succeeded = 0;
  let failed = 0;
  const loadStart = performance.now();

  for (let w = 0; w < TOTAL_CONCURRENT_REQUESTS; w += CONCURRENCY_WINDOW) {
    const batch = Array.from({ length: Math.min(CONCURRENCY_WINDOW, TOTAL_CONCURRENT_REQUESTS - w) }, (_, idx) => {
      const targetIdx = (w + idx) % TARGET_PRODUCTS;
      const serial = `BM1M-${String(targetIdx).padStart(7, '0')}`;
      const t0 = performance.now();
      return fetch(`http://127.0.0.1:4098/api/products?q=${serial}&limit=5`)
        .then((res) => {
          if (res.ok) succeeded += 1;
          else failed += 1;
        })
        .catch(() => {
          failed += 1;
        })
        .finally(() => {
          latencies.push(performance.now() - t0);
        });
    });
    await Promise.all(batch);
  }

  const totalLoadMs = Number((performance.now() - loadStart).toFixed(2));
  latencies.sort((a, b) => a - b);

  const report = {
    timestamp: new Date().toISOString(),
    merkle100kBuildMs: merkleMs,
    dbRowsSeeded: TARGET_PRODUCTS,
    dbSeedDurationMs: seedDurationMs,
    exactSerialLookupAt1MMs: exactSerialMs,
    cursorPaginationAt1MMs: cursorPageMs,
    httpLoadTest: {
      totalRequests: TOTAL_CONCURRENT_REQUESTS,
      concurrencyWindow: CONCURRENCY_WINDOW,
      succeeded,
      failed,
      totalDurationMs: totalLoadMs,
      requestsPerSec: Number(((TOTAL_CONCURRENT_REQUESTS / totalLoadMs) * 1000).toFixed(2)),
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99),
    },
  };

  console.log('=== ChainTrace 1M Scale & 10k Concurrency Report ===');
  console.log(JSON.stringify(report, null, 2));

  fs.writeFileSync(
    path.resolve(__dirname, '../docs/benchmark-results.json'),
    JSON.stringify(report, null, 2),
  );

  server!.close();
  await rpcPool.destroy();
  await pool.end();
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
