import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import {
  buildMerkleTree,
  computeBatchId,
  computeClaimSecretHash,
  computeLeaf,
  computeMetadataHash,
  computeProductId,
  ROLE_HASHES,
  RpcFailoverPool,
} from '@chaintrace/shared';
import { ReorgSafeIndexer } from './indexer';

jest.setTimeout(90_000);

async function ensureTestDb(adminUrl: string, dbName: string): Promise<string> {
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const exists = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!exists.rowCount) {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await adminPool.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

import { runMigrations } from '../../api/src/db/migrate';

async function applyMigrations(pool: Pool) {
  await runMigrations(pool);
}

async function waitForRpc(url: string): Promise<ethers.JsonRpcProvider> {
  const provider = new ethers.JsonRpcProvider(url, ethers.Network.from(31337), {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  for (let i = 0; i < 40; i++) {
    try {
      await provider.getBlockNumber();
      return provider;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Hardhat node failed to become ready');
}

describe('ReorgSafeIndexer Integration (Real Hardhat + Real PostgreSQL)', () => {
  const PORT = 18546;
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  const BASE_DB_URL =
    process.env.DATABASE_URL ||
    'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace';

  let hhProcess: ChildProcess;
  let provider: ethers.JsonRpcProvider;
  let pool: Pool;
  let rpcPool: RpcFailoverPool;
  let contractAddress: string;
  let indexer: ReorgSafeIndexer;

  beforeAll(async () => {
    const testDbUrl = await ensureTestDb(BASE_DB_URL, 'chaintrace_indexer_test');
    pool = new Pool({ connectionString: testDbUrl });
    await applyMigrations(pool);
    await pool.query(
      `TRUNCATE indexed_blocks, indexer_checkpoints, reorg_events, product_events,
                failed_transactions, products, batches RESTART IDENTITY CASCADE`,
    );

    const contractsDir = path.resolve(__dirname, '../../../packages/contracts');
    const hhBin = require.resolve('hardhat/internal/cli/cli');
    hhProcess = spawn(process.execPath, [hhBin, 'node', '--port', String(PORT)], {
      cwd: contractsDir,
      stdio: 'ignore',
    });

    provider = await waitForRpc(RPC_URL);

    // Load compiled artifact
    const artifactPath = path.resolve(
      contractsDir,
      'artifacts/contracts/ChainTraceRegistry.sol/ChainTraceRegistry.json',
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    // Standard Hardhat deterministic accounts #0, #1, #2, #3
    const admin = new ethers.Wallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      provider,
    );
    const manufacturer = new ethers.Wallet(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      provider,
    );
    const distributor = new ethers.Wallet(
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      provider,
    );

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, admin);
    const deployed = await factory.deploy(admin.address);
    await deployed.waitForDeployment();
    contractAddress = await deployed.getAddress();

    const registryAsAdmin = new ethers.Contract(contractAddress, artifact.abi, admin);
    await (await registryAsAdmin.grantRole(ROLE_HASHES.MANUFACTURER_ROLE, manufacturer.address)).wait();
    await (await registryAsAdmin.grantRole(ROLE_HASHES.DISTRIBUTOR_ROLE, distributor.address)).wait();

    rpcPool = new RpcFailoverPool({ urls: [RPC_URL], chainId: 31337 });
    indexer = new ReorgSafeIndexer(pool, rpcPool, {
      chainId: 31337,
      contractAddress,
      confirmationsRequired: 2,
      initialChunkSize: 50,
    });
  });

  afterAll(async () => {
    await rpcPool?.destroy();
    await pool?.end();
    provider?.destroy();
    if (hhProcess && !hhProcess.killed) {
      hhProcess.kill('SIGTERM');
    }
  });

  it('indexes canonical events, catches reverted unauthorized txs, survives crash/restart, and rolls back chain reorgs', async () => {
    const artifactPath = path.resolve(
      __dirname,
      '../../../packages/contracts/artifacts/contracts/ChainTraceRegistry.sol/ChainTraceRegistry.json',
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const manufacturer = new ethers.Wallet(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      provider,
    );
    const distributor = new ethers.Wallet(
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      provider,
    );
    const attacker = new ethers.Wallet(
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
      provider,
    );

    const regMfg = new ethers.Contract(contractAddress, artifact.abi, manufacturer);
    const regDist = new ethers.Contract(contractAddress, artifact.abi, distributor);
    const regAttacker = new ethers.Contract(contractAddress, artifact.abi, attacker);

    const batchId = computeBatchId(manufacturer.address, 'IDX-BATCH-1');
    const serial = 'SN-IDX-001';
    const productId = computeProductId(manufacturer.address, batchId, serial);
    const metadataHash = computeMetadataHash({ name: 'Indexer Test Device' });
    const claimSecretHash = computeClaimSecretHash('SEC-IDX-1');
    const leaf = computeLeaf({
      batchId,
      productId,
      serialNumber: serial,
      metadataHash,
      claimSecretHash,
    });
    const tree = buildMerkleTree([leaf]);

    // 1. Register batch on-chain
    await (await regMfg.registerBatch(batchId, tree.root, 'bafytestcid', 1)).wait();

    // 2. Submit an unauthorized reverted transaction with explicit gasLimit so it mines on-chain as status=0
    try {
      const badTx = await regAttacker.registerBatch(
        computeBatchId(attacker.address, 'EVIL'),
        tree.root,
        'bafyevil',
        1,
        { gasLimit: 300_000 },
      );
      await badTx.wait();
    } catch {
      // Hardhat node automine mines reverted tx AND throws JSON-RPC error with txHash
    }

    const report1 = await indexer.syncOnce();
    expect(report1.eventsProcessed).toBe(1);
    expect(report1.failedTxsDetected).toBe(1);

    const failedRows = await pool.query(`SELECT decoded_error FROM failed_transactions`);
    expect(failedRows.rowCount).toBe(1);
    expect(failedRows.rows[0].decoded_error).toContain('AccessControlUnauthorizedAccount');

    // 3. Simulate crash & restart by rolling checkpoint back without clearing events
    await pool.query(`UPDATE indexer_checkpoints SET last_indexed_block = 0`);
    const reportCrash = await indexer.syncOnce();
    expect(reportCrash.eventsProcessed).toBe(0); // Idempotent: 0 duplicate events added!

    // 4. Take EVM snapshot BEFORE materializing & transferring unit, then simulate REORG!
    const snapshotId = (await provider.send('evm_snapshot', [])) as string;

    await (
      await regMfg.materializeAndInitiateTransfer(
        batchId,
        productId,
        serial,
        metadataHash,
        claimSecretHash,
        tree.getProof(0),
        distributor.address,
        0,
        'SHIP-BEFORE-REORG',
      )
    ).wait();

    const reportPreReorg = await indexer.syncOnce();
    expect(reportPreReorg.eventsProcessed).toBe(2); // ProductMaterialized + TransferInitiated

    let prodRes = await pool.query(`SELECT is_materialized, pending_custodian FROM products WHERE product_id = $1`, [
      productId,
    ]);
    expect(prodRes.rows[0].is_materialized).toBe(true);
    expect(prodRes.rows[0].pending_custodian.toLowerCase()).toBe(distributor.address.toLowerCase());

    // Revert chain to snapshot (simulating chain reorg dropping TransferInitiated block)
    await provider.send('evm_revert', [snapshotId]);
    // Mine a different canonical block (recall or batch status update) at the same height
    await (await regMfg.updateBatchDeliveryStatus(batchId, 1, 'Canonical-Block')).wait();

    const reportReorg = await indexer.syncOnce();
    expect(reportReorg.reorgDetected).toBe(true);

    // Rolled back ProductMaterialized & TransferInitiated must be marked is_reorged = TRUE
    const reorgEventsCount = await pool.query(`SELECT COUNT(*)::int AS cnt FROM reorg_events`);
    expect(reorgEventsCount.rows[0].cnt).toBeGreaterThanOrEqual(1);

    const reorgedRows = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM product_events WHERE is_reorged = TRUE`,
    );
    expect(reorgedRows.rows[0].cnt).toBe(2);

    // Product projection rolled back cleanly to unsplit batch state!
    prodRes = await pool.query(`SELECT is_materialized, pending_custodian FROM products WHERE product_id = $1`, [
      productId,
    ]);
    expect(prodRes.rows[0].is_materialized).toBe(false);
    expect(prodRes.rows[0].pending_custodian).toBeNull();

    // Canonical BatchStatusUpdated event is indexed cleanly
    const canonicalStatusEvents = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM product_events WHERE event_name = 'BatchStatusUpdated' AND is_reorged = FALSE`,
    );
    expect(canonicalStatusEvents.rows[0].cnt).toBe(1);
    void regDist;
  });
});
