import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import { IpfsClient, ROLE_HASHES, RpcFailoverPool } from '@chaintrace/shared';
import { createApp } from './app';
import { loadConfig } from './config';
import { runMigrations } from './db/migrate';

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
  throw new Error('Hardhat node failed to start');
}

function buildSiweString(address: string, nonce: string, chainId = 31337) {
  return `localhost:3000 wants you to sign in with your Ethereum account:
${address}

Sign in to ChainTrace Enterprise

URI: http://localhost:3000
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${new Date().toISOString()}`;
}

describe('ChainTrace API Integration & Failure Resilience', () => {
  const PORT = 18547;
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  const BASE_DB_URL =
    process.env.DATABASE_URL ||
    'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace';

  let hhProcess: ChildProcess;
  let provider: ethers.JsonRpcProvider;
  let pool: Pool;
  let rpcPool: RpcFailoverPool;
  let ipfsClient: IpfsClient;
  let contractAddress: string;
  let artifactAbi: ethers.InterfaceAbi;
  let app: ReturnType<typeof createApp>;

  const admin = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const manufacturer = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const customer = new ethers.Wallet(
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  );

  beforeAll(async () => {
    const testDbUrl = await ensureTestDb(BASE_DB_URL, 'chaintrace_api_test');
    pool = new Pool({ connectionString: testDbUrl });
    await runMigrations(pool);
    await pool.query(
      `TRUNCATE auth_nonces, users, scan_logs, offchain_shipments, product_secrets, products, batches,
                product_events, failed_transactions, reorg_events, indexed_blocks, indexer_checkpoints, relayer_jobs
       RESTART IDENTITY CASCADE`,
    );

    const contractsDir = path.resolve(__dirname, '../../../packages/contracts');
    const hhBin = require.resolve('hardhat/internal/cli/cli');
    hhProcess = spawn(process.execPath, [hhBin, 'node', '--port', String(PORT)], {
      cwd: contractsDir,
      stdio: 'ignore',
    });
    provider = await waitForRpc(RPC_URL);

    const artifact = JSON.parse(
      fs.readFileSync(
        path.resolve(
          contractsDir,
          'artifacts/contracts/ChainTraceRegistry.sol/ChainTraceRegistry.json',
        ),
        'utf8',
      ),
    );
    artifactAbi = artifact.abi;

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, admin.connect(provider));
    const deployed = await factory.deploy(admin.address);
    await deployed.waitForDeployment();
    contractAddress = await deployed.getAddress();

    const regAdmin = new ethers.Contract(contractAddress, artifact.abi, admin.connect(provider));
    await (await regAdmin.grantRole(ROLE_HASHES.MANUFACTURER_ROLE, manufacturer.address)).wait();

    rpcPool = new RpcFailoverPool({ urls: [RPC_URL], chainId: 31337 });
    ipfsClient = new IpfsClient(process.env.IPFS_API_URL || 'http://127.0.0.1:5001');
    const config = {
      ...loadConfig(),
      databaseUrl: testDbUrl,
      rpcUrls: [RPC_URL],
      contractAddress,
      chainId: 31337,
    };

    app = createApp({ config, pool, rpcPool, ipfsClient });
  });

  afterAll(async () => {
    await rpcPool?.destroy();
    await pool?.end();
    provider?.destroy();
    if (hhProcess && !hhProcess.killed) {
      hhProcess.kill('SIGTERM');
    }
  });

  it('enforces SIWE auth, prevents nonce replay, pins batch to IPFS, verifies on-chain, and degrades cleanly when DB or RPC is offline', async () => {
    // 1. OpenAPI & Liveness probes
    const liveRes = await request(app).get('/health/live');
    expect(liveRes.status).toBe(200);
    const specRes = await request(app).get('/api/openapi.json');
    expect(specRes.status).toBe(200);
    expect(specRes.body.openapi).toBe('3.0.3');

    // 2. SIWE auth flow for Manufacturer + replay block
    const nonceRes = await request(app)
      .post('/api/auth/nonce')
      .send({ walletAddress: manufacturer.address });
    expect(nonceRes.status).toBe(200);
    const siweMsg = buildSiweString(manufacturer.address, nonceRes.body.nonce);
    const sig = await manufacturer.signMessage(siweMsg);

    const authRes = await request(app)
      .post('/api/auth/verify')
      .send({ message: siweMsg, signature: sig });
    expect(authRes.status).toBe(200);
    expect(authRes.body.user.roles).toContain('MANUFACTURER');
    const mfgToken = authRes.body.token as string;

    // Replay same SIWE nonce -> MUST reject 401
    const replayRes = await request(app)
      .post('/api/auth/verify')
      .send({ message: siweMsg, signature: sig });
    expect(replayRes.status).toBe(401);

    // 3. Customer auth -> 403 Forbidden on Manufacturer endpoint
    const custNonce = await request(app)
      .post('/api/auth/nonce')
      .send({ walletAddress: customer.address });
    const custMsg = buildSiweString(customer.address, custNonce.body.nonce);
    const custSig = await customer.signMessage(custMsg);
    const custAuth = await request(app)
      .post('/api/auth/verify')
      .send({ message: custMsg, signature: custSig });
    const forbiddenRes = await request(app)
      .post('/api/batches/prepare')
      .set('Authorization', `Bearer ${custAuth.body.token}`)
      .send({
        batchCode: 'FORBIDDEN-1',
        productName: 'X',
        sku: 'SKU',
        category: 'Cat',
        manufacturerName: 'Mfg',
        description: 'Desc',
        serialPrefix: 'SN',
        unitCount: 1,
      });
    expect(forbiddenRes.status).toBe(403);

    // 4. Manufacturer prepares batch -> pins to IPFS Kubo -> generates Merkle tree + QR
    const prepRes = await request(app)
      .post('/api/batches/prepare')
      .set('Authorization', `Bearer ${mfgToken}`)
      .send({
        batchCode: 'API-TEST-BATCH-1',
        productName: 'Enterprise Router R9',
        sku: 'R9-PRO',
        category: 'Networking',
        manufacturerName: 'ChainTrace Corp',
        description: 'Zero-trust hardware router',
        serialPrefix: 'R9SN',
        unitCount: 4,
      });
    expect(prepRes.status).toBe(201);
    const { batchId, merkleRoot, ipfsCid, unitCount, sampleProducts } = prepRes.body;

    // Anchor batch on-chain
    const regMfg = new ethers.Contract(contractAddress, artifactAbi, manufacturer.connect(provider));
    await (await regMfg.registerBatch(batchId, merkleRoot, ipfsCid, unitCount)).wait();
    await pool.query(`UPDATE batches SET onchain_confirmed = TRUE WHERE batch_id = $1`, [batchId]);

    // Generate QR bundle
    const target = sampleProducts[0];
    const qrRes = await request(app)
      .get(`/api/batches/${batchId}/products/${target.productId}/qr`)
      .set('Authorization', `Bearer ${mfgToken}`);
    expect(qrRes.status).toBe(200);
    expect(qrRes.body.payload.claimSecret).toMatch(/^CT-/);

    // 5. Verify normally via API (DB + RPC)
    const verifyRes = await request(app).get(`/api/verify/${target.serialNumber}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verdict).toBe('VERIFIED_AUTHENTIC');
    expect(verifyRes.body.source).toBe('CHAIN_AND_INDEX');

    // 6. Simulate DB tamper -> Explorer anomaly audit MUST flag mismatch!
    await pool.query(`UPDATE batches SET merkle_root = $1 WHERE batch_id = $2`, [
      ethers.ZeroHash,
      batchId,
    ]);
    const anomalyRes = await request(app).get('/api/explorer/anomalies');
    expect(anomalyRes.status).toBe(200);
    expect(anomalyRes.body.integrityMismatches.length).toBeGreaterThanOrEqual(1);
    // Restore DB merkle root
    await pool.query(`UPDATE batches SET merkle_root = $1 WHERE batch_id = $2`, [
      merkleRoot,
      batchId,
    ]);

    // 7. Simulate PostgreSQL Unavailable -> Stateless Direct-RPC Fallback returns 200!
    const deadPool = new Pool({
      connectionString: 'postgresql://chaintrace:bad@127.0.0.1:59999/nope',
      connectionTimeoutMillis: 200,
    });
    const dbOfflineApp = createApp({
      config: { ...loadConfig(), contractAddress, chainId: 31337 },
      pool: deadPool,
      rpcPool,
      ipfsClient,
    });
    const degradedDbRes = await request(dbOfflineApp)
      .get(`/api/verify/${target.productId}`)
      .query({
        batchId,
        serialNumber: target.serialNumber,
        metadataHash: qrRes.body.payload.metadataHash,
        claimSecretHash: target.claimSecretHash,
        merkleProof: JSON.stringify(target.merkleProof),
      });
    expect(degradedDbRes.status).toBe(200);
    expect(degradedDbRes.body.source).toBe('CHAIN_DIRECT_DB_DEGRADED');
    expect(degradedDbRes.body.verdict).toBe('VERIFIED_AUTHENTIC');
    await deadPool.end();

    // 8. Simulate Blockchain RPC Offline -> Degraded Cached Mode returns explicit warning instead of 500!
    const deadRpcPool = new RpcFailoverPool({
      urls: ['http://127.0.0.1:59998'],
      requestTimeoutMs: 250,
      failureThreshold: 1,
    });
    const rpcOfflineApp = createApp({
      config: { ...loadConfig(), contractAddress, chainId: 31337 },
      pool,
      rpcPool: deadRpcPool,
      ipfsClient,
    });
    const degradedRpcRes = await request(rpcOfflineApp).get(`/api/verify/${target.productId}`);
    expect(degradedRpcRes.status).toBe(200);
    expect(degradedRpcRes.body.verdict).toBe('RPC_UNAVAILABLE_CACHED');
    expect(degradedRpcRes.body.source).toBe('INDEX_CACHE_RPC_OFFLINE');
    await deadRpcPool.destroy();
  });
});
