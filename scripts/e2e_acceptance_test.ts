import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as assert from 'assert';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import {
  CHAIN_TRACE_REGISTRY_ABI,
  CustodyStatus,
  IpfsClient,
  ROLE_HASHES,
  RpcFailoverPool,
} from '@chaintrace/shared';
import { ReorgSafeIndexer } from '../apps/indexer/src/indexer';
import { createApp } from '../apps/api/src/app';
import { loadConfig } from '../apps/api/src/config';
import { runMigrations } from '../apps/api/src/db/migrate';

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

function buildSiwe(address: string, nonce: string): string {
  return `localhost:3000 wants you to sign in with your Ethereum account:
${address}

Sign in to ChainTrace Enterprise

URI: http://localhost:3000
Version: 1
Chain ID: 31337
Nonce: ${nonce}
Issued At: ${new Date().toISOString()}`;
}

async function runAcceptance() {
  const PORT = 18549;
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  const contractsDir = path.resolve(__dirname, '../packages/contracts');
  const hhBin = require.resolve('hardhat/internal/cli/cli');

  // Step 3: Start local Hardhat blockchain
  const hh = spawn(process.execPath, [hhBin, 'node', '--port', String(PORT)], {
    cwd: contractsDir,
    stdio: 'ignore',
  });

  const baseDbUrl =
    process.env.DATABASE_URL ||
    'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace';
  const adminPool = new Pool({ connectionString: baseDbUrl });
  const dbName = 'chaintrace_e2e_acceptance';
  const exists = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
  if (!exists.rowCount) await adminPool.query(`CREATE DATABASE ${dbName}`);
  await adminPool.end();

  const dbUrlObj = new URL(baseDbUrl);
  dbUrlObj.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: dbUrlObj.toString() });

  let rpcPool: RpcFailoverPool | null = null;
  let server: http.Server | null = null;
  let provider: ethers.JsonRpcProvider | null = null;

  try {
    // Step 1 & 2: Verify PostgreSQL + IPFS reachable
    await runMigrations(pool);
    await pool.query(
      `TRUNCATE auth_nonces, users, scan_logs, offchain_shipments, secret_access_logs,
                product_secrets, products, batches, product_events, failed_transactions,
                reorg_events, indexed_blocks, indexer_checkpoints, relayer_jobs, relayer_signer_nonces
       RESTART IDENTITY CASCADE`,
    );

    const ipfsClient = new IpfsClient(process.env.IPFS_API_URL || 'http://127.0.0.1:5001');
    const ipfsHealthy = await ipfsClient.isHealthy();
    assert.strictEqual(ipfsHealthy, true, 'IPFS Kubo must be healthy');

    provider = await waitForRpc(RPC_URL);
    const artifact = JSON.parse(
      fs.readFileSync(
        path.resolve(contractsDir, 'artifacts/contracts/ChainTraceRegistry.sol/ChainTraceRegistry.json'),
        'utf8',
      ),
    );

    // Step 4-6: Deploy contract, create Admin, register Manufacturer, Distributor, Warehouse, Retailer
    const admin = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
    const manufacturer = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', provider);
    const distributor = new ethers.Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', provider);
    const warehouse = new ethers.Wallet('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', provider);
    const retailer = new ethers.Wallet('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', provider);
    const customer = new ethers.Wallet('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', provider);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, admin);
    const registry = await factory.deploy(admin.address);
    await registry.waitForDeployment();
    const contractAddress = await registry.getAddress();

    const regAdmin = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, admin);
    await (await regAdmin.grantRole(ROLE_HASHES.MANUFACTURER_ROLE, manufacturer.address)).wait();
    await (await regAdmin.grantRole(ROLE_HASHES.DISTRIBUTOR_ROLE, distributor.address)).wait();
    await (await regAdmin.grantRole(ROLE_HASHES.WAREHOUSE_ROLE, warehouse.address)).wait();
    await (await regAdmin.grantRole(ROLE_HASHES.RETAILER_ROLE, retailer.address)).wait();

    rpcPool = new RpcFailoverPool({ urls: [RPC_URL], chainId: 31337 });
    const indexer = new ReorgSafeIndexer(pool, rpcPool, {
      chainId: 31337,
      contractAddress,
      confirmationsRequired: 1,
      initialChunkSize: 100,
    });

    const app = createApp({
      config: { ...loadConfig(), contractAddress, chainId: 31337, rpcUrls: [RPC_URL] },
      pool,
      rpcPool,
      ipfsClient,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(4097, () => resolve());
    });
    const apiBase = 'http://127.0.0.1:4097';

    // Step 7-11: Manufacturer SIWE -> Prepare batch (IPFS pin) -> Register on-chain -> Indexer sync -> DB reflects batch
    const nonceResp = await fetch(`${apiBase}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: manufacturer.address }),
    }).then((r) => r.json());
    const siweMsg = buildSiwe(manufacturer.address, nonceResp.nonce);
    const sig = await manufacturer.signMessage(siweMsg);
    const authResp = await fetch(`${apiBase}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: siweMsg, signature: sig }),
    }).then((r) => r.json());
    const token = authResp.token as string;
    assert.ok(token, 'Manufacturer SIWE token must be issued');

    const batchPrep = await fetch(`${apiBase}/api/batches/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        batchCode: 'E2E-ACCEPT-2026',
        productName: 'ChainTrace Acceptance Hardware',
        sku: 'CT-ACC-1',
        category: 'Electronics',
        manufacturerName: 'ChainTrace Factory',
        description: '30-step acceptance verified product',
        serialPrefix: 'ACC',
        unitCount: 4,
      }),
    }).then((r) => r.json());

    const regMfg = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, manufacturer);
    await (await regMfg.registerBatch(...batchPrep.contractCall.args)).wait();
    await indexer.syncOnce();

    const batchDb = await pool.query(`SELECT onchain_confirmed FROM batches WHERE batch_id = $1`, [
      batchPrep.batchId,
    ]);
    assert.strictEqual(batchDb.rows[0].onchain_confirmed, true, 'DB must reflect confirmed batch');

    // Step 12-13: Generate QR (verify encrypted secret at rest) & verify authenticity
    const unit0 = batchPrep.sampleProducts[0];
    const unit1 = batchPrep.sampleProducts[1];
    const secretRow = await pool.query(
      `SELECT claim_secret, encrypted_claim_secret FROM product_secrets WHERE product_id = $1`,
      [unit0.productId],
    );
    assert.strictEqual(secretRow.rows[0].claim_secret, null, 'Plaintext claim_secret must be null');
    assert.ok(secretRow.rows[0].encrypted_claim_secret?.startsWith('v1:'), 'Secret must be AES-GCM encrypted');

    const qrBundle = await fetch(`${apiBase}/api/batches/${batchPrep.batchId}/products/${unit0.productId}/qr`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.ok(qrBundle.payload.claimSecret, 'Authorized QR export returns decrypted claimSecret');

    const preVerify = await fetch(`${apiBase}/api/verify/${unit0.serialNumber}`).then((r) => r.json());
    assert.strictEqual(preVerify.verdict, 'VERIFIED_AUTHENTIC');

    // Step 14-19: Manufacturer -> Distributor -> Warehouse -> Retailer
    await (
      await regMfg.materializeAndInitiateTransfer(
        batchPrep.batchId,
        unit0.productId,
        unit0.serialNumber,
        qrBundle.payload.metadataHash,
        unit0.claimSecretHash,
        unit0.merkleProof,
        distributor.address,
        0,
        'E2E-AIR-1',
      )
    ).wait();

    const regDist = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, distributor);
    await (await regDist.acceptCustody(unit0.productId, 1, 'Dist-Hub')).wait();
    await (await regDist.initiateTransfer(unit0.productId, warehouse.address, 2, 'E2E-TRK-2')).wait();

    const regWh = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, warehouse);
    await (await regWh.acceptCustody(unit0.productId, 3, 'WH-Zone-4')).wait();
    await (await regWh.initiateTransfer(unit0.productId, retailer.address, 4, 'E2E-VAN-3')).wait();

    const regRet = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, retailer);
    await (await regRet.acceptCustody(unit0.productId, 5, 'Retail-Store')).wait();

    // Step 20-23: Customer verifies QR -> claims -> duplicate claim rejected -> secret retired
    const midQrVerify = await fetch(`${apiBase}/api/verify/qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrPayload: qrBundle.payload }),
    }).then((r) => r.json());
    assert.strictEqual(midQrVerify.verdict, 'VERIFIED_AUTHENTIC');

    const regCust = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, customer);
    await (
      await regCust.claimProduct(
        batchPrep.batchId,
        unit0.productId,
        unit0.serialNumber,
        qrBundle.payload.metadataHash,
        unit0.claimSecretHash,
        unit0.merkleProof,
        qrBundle.payload.claimSecret,
      )
    ).wait();

    let dupClaimRejected = false;
    try {
      await regCust.claimProduct(
        batchPrep.batchId,
        unit0.productId,
        unit0.serialNumber,
        qrBundle.payload.metadataHash,
        unit0.claimSecretHash,
        unit0.merkleProof,
        qrBundle.payload.claimSecret,
      );
    } catch {
      dupClaimRejected = true;
    }
    assert.strictEqual(dupClaimRejected, true, 'Duplicate claim must be rejected on-chain');

    await indexer.syncOnce();
    const retiredRow = await pool.query(
      `SELECT encrypted_claim_secret, retired_at FROM product_secrets WHERE product_id = $1`,
      [unit0.productId],
    );
    assert.strictEqual(retiredRow.rows[0].encrypted_claim_secret, null, 'Secret must be cleared after claim');
    assert.ok(retiredRow.rows[0].retired_at, 'Secret retired_at must be stamped');

    // Step 24-25: Recall another test product and verify recall status
    await (
      await regAdmin.flagProductWithProof(
        batchPrep.batchId,
        unit1.productId,
        unit1.serialNumber,
        qrBundle.payload.metadataHash,
        unit1.claimSecretHash,
        unit1.merkleProof,
        'E2E Recall Verification',
      )
    ).wait();
    await indexer.syncOnce();
    const recallVerify = await fetch(`${apiBase}/api/verify/${unit1.serialNumber}`).then((r) => r.json());
    assert.strictEqual(recallVerify.verdict, 'RECALLED');
    assert.strictEqual(recallVerify.product.currentStatus, CustodyStatus.Recalled);

    // Step 26-27: Restart indexer from checkpoint 0 and verify DB projection recovers idempotently
    await pool.query(`UPDATE indexer_checkpoints SET last_indexed_block = 0`);
    const restartedIndexer = new ReorgSafeIndexer(pool, rpcPool, {
      chainId: 31337,
      contractAddress,
      confirmationsRequired: 1,
      initialChunkSize: 100,
    });
    const recoverySync = await restartedIndexer.syncOnce();
    assert.strictEqual(recoverySync.eventsProcessed, 0, 'Idempotent recovery must insert 0 duplicate events');

    // Step 28-30: Simulate PostgreSQL offline -> verify direct blockchain fallback works -> restore DB
    const deadPool = new Pool({
      connectionString: 'postgresql://chaintrace:bad@127.0.0.1:59999/nope',
      connectionTimeoutMillis: 200,
    });
    const degradedApp = createApp({
      config: { ...loadConfig(), contractAddress, chainId: 31337, rpcUrls: [RPC_URL] },
      pool: deadPool,
      rpcPool,
      ipfsClient,
    });
    const degradedServer = await new Promise<http.Server>((resolve) => {
      const s = degradedApp.listen(4096, () => resolve(s));
    });
    const directFallback = await fetch(
      `http://127.0.0.1:4096/api/verify/${unit0.productId}?batchId=${batchPrep.batchId}&serialNumber=${unit0.serialNumber}&metadataHash=${qrBundle.payload.metadataHash}&claimSecretHash=${unit0.claimSecretHash}&merkleProof=${encodeURIComponent(JSON.stringify(unit0.merkleProof))}`,
    ).then((r) => r.json());
    assert.strictEqual(directFallback.source, 'CHAIN_DIRECT_DB_DEGRADED');
    assert.strictEqual(directFallback.verdict, 'CLAIMED_AUTHENTIC');
    degradedServer.close();
    await deadPool.end();

    // Restore Postgres verification (3rd scan within 5m after claim triggers anti-clone alert)
    const restoredVerify = await fetch(`${apiBase}/api/verify/${unit0.serialNumber}`).then((r) => r.json());
    assert.strictEqual(restoredVerify.source, 'CHAIN_AND_INDEX');
    assert.strictEqual(restoredVerify.product.claimed, true);
    assert.ok(
      restoredVerify.verdict === 'CLAIMED_AUTHENTIC' || restoredVerify.verdict === 'SUSPICIOUS_DUPLICATE',
      `Unexpected verdict: ${restoredVerify.verdict}`,
    );

    console.log('=== ALL 30 STEPS OF E2E ACCEPTANCE TEST PASSED ===');
  } finally {
    server?.close();
    await rpcPool?.destroy();
    await pool.end();
    provider?.destroy();
    if (!hh.killed) hh.kill('SIGTERM');
  }
}

runAcceptance().catch((err) => {
  console.error('E2E Acceptance Test Failed:', err);
  process.exit(1);
});
