import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
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
  throw new Error('Hardhat node failed to start');
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

async function runDemo() {
  const PORT = 18548;
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  const contractsDir = path.resolve(__dirname, '../packages/contracts');
  const hhBin = require.resolve('hardhat/internal/cli/cli');
  const hh = spawn(process.execPath, [hhBin, 'node', '--port', String(PORT)], {
    cwd: contractsDir,
    stdio: 'ignore',
  });

  const baseDbUrl =
    process.env.DATABASE_URL ||
    'postgresql://chaintrace:chaintrace_dev_password@localhost:5432/chaintrace';
  const adminPool = new Pool({ connectionString: baseDbUrl });
  const demoDbName = 'chaintrace_demo';
  const exists = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [demoDbName]);
  if (!exists.rowCount) await adminPool.query(`CREATE DATABASE ${demoDbName}`);
  await adminPool.end();

  const dbUrlObj = new URL(baseDbUrl);
  dbUrlObj.pathname = `/${demoDbName}`;
  const pool = new Pool({ connectionString: dbUrlObj.toString() });

  let rpcPool: RpcFailoverPool | null = null;
  let server: http.Server | null = null;
  let provider: ethers.JsonRpcProvider | null = null;

  try {
    await runMigrations(pool);
    await pool.query(
      `TRUNCATE auth_nonces, users, scan_logs, offchain_shipments, product_secrets, products, batches,
                product_events, failed_transactions, reorg_events, indexed_blocks, indexer_checkpoints, relayer_jobs
       RESTART IDENTITY CASCADE`,
    );

    provider = await waitForRpc(RPC_URL);
    const artifact = JSON.parse(
      fs.readFileSync(
        path.resolve(contractsDir, 'artifacts/contracts/ChainTraceRegistry.sol/ChainTraceRegistry.json'),
        'utf8',
      ),
    );

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
    const ipfsClient = new IpfsClient(process.env.IPFS_API_URL || 'http://127.0.0.1:5001');
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
      server = app.listen(4099, () => resolve());
    });
    const apiBase = 'http://127.0.0.1:4099';

    // 1. Manufacturer SIWE login + prepare batch
    const nonceResp = await fetch(`${apiBase}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: manufacturer.address }),
    }).then((r) => r.json());
    const siweMessage = buildSiwe(manufacturer.address, nonceResp.nonce);
    const sig = await manufacturer.signMessage(siweMessage);
    const authResp = await fetch(`${apiBase}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: siweMessage, signature: sig }),
    }).then((r) => r.json());
    const token = authResp.token;
    if (!token) throw new Error(`Auth failed: ${JSON.stringify(authResp)}`);

    const batchPrep = await fetch(`${apiBase}/api/batches/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        batchCode: 'DEMO-E2E-2026',
        productName: 'Helios Quantum Sensor Q9',
        sku: 'HQ-Q9',
        category: 'Industrial Hardware',
        manufacturerName: 'Helios Global',
        description: 'End-to-end verifiable hardware unit',
        serialPrefix: 'HQ9',
        unitCount: 5,
      }),
    }).then((r) => r.json());
    if (!batchPrep.contractCall) throw new Error(`Prepare failed: ${JSON.stringify(batchPrep)}`);

    const regMfg = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, manufacturer);
    await (await regMfg.registerBatch(...batchPrep.contractCall.args)).wait();
    await indexer.syncOnce();

    const unit = batchPrep.sampleProducts[0];
    const qrBundle = await fetch(`${apiBase}/api/batches/${batchPrep.batchId}/products/${unit.productId}/qr`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());

    // 2. Manufacturer -> Distributor -> Warehouse -> Retailer -> Customer
    await (
      await regMfg.materializeAndInitiateTransfer(
        batchPrep.batchId,
        unit.productId,
        unit.serialNumber,
        qrBundle.payload.metadataHash,
        unit.claimSecretHash,
        unit.merkleProof,
        distributor.address,
        0,
        'AIR-100',
      )
    ).wait();

    const regDist = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, distributor);
    await (await regDist.acceptCustody(unit.productId, 1, 'Distributor-Hub-Mumbai')).wait();
    await (await regDist.initiateTransfer(unit.productId, warehouse.address, 2, 'TRK-200')).wait();

    const regWh = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, warehouse);
    await (await regWh.acceptCustody(unit.productId, 3, 'Warehouse-Pune-Zone4')).wait();
    await (await regWh.initiateTransfer(unit.productId, retailer.address, 4, 'VAN-300')).wait();

    const regRet = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, retailer);
    await (await regRet.acceptCustody(unit.productId, 5, 'Flagship-Retail-Store')).wait();

    // 3. Customer claims ownership with sealed secret
    const regCust = new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, customer);
    await (
      await regCust.claimProduct(
        batchPrep.batchId,
        unit.productId,
        unit.serialNumber,
        qrBundle.payload.metadataHash,
        unit.claimSecretHash,
        unit.merkleProof,
        qrBundle.payload.claimSecret,
      )
    ).wait();

    const syncReport = await indexer.syncOnce();
    const verification = await fetch(`${apiBase}/api/verify/${unit.serialNumber}`).then((r) => r.json());

    console.log('=== E2E Lifecycle Demo Passed ===');
    console.log({
      contractAddress,
      batchId: batchPrep.batchId,
      ipfsCid: batchPrep.ipfsCid,
      serialNumber: unit.serialNumber,
      verdict: verification.verdict,
      status: CustodyStatus[verification.product.currentStatus],
      historyEventsCount: verification.events.length,
      lastSync: syncReport,
    });
  } finally {
    server?.close();
    await rpcPool?.destroy();
    await pool.end();
    provider?.destroy();
    if (!hh.killed) hh.kill('SIGTERM');
  }
}

runDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
