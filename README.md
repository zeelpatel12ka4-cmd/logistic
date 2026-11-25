# ChainTrace Enterprise

**Decentralized Supply Chain Tracking & Product Authentication Platform**

ChainTrace Enterprise tracks physical products from factory floor to end consumer across **Manufacturer -> Distributor -> Warehouse -> Retailer -> Customer**, ensuring ownership, provenance, and anti-counterfeit checks remain cryptographically verifiable on-chain while maintaining sub-millisecond search across **1,000,000+ products** in PostgreSQL.

## Repository Layout

- [packages/contracts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/packages/contracts) — Solidity `0.8.28` `ChainTraceRegistry` (Merkle batch anchoring, lazy product materialization, 2-step custody, EIP-712, sealed claim secrets), Hardhat tests, gas benchmarks, deploy script.
- [packages/shared](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/packages/shared) — Canonical Keccak256 Merkle tree & leaf SDK, Zod schemas, ABI bindings, `RpcFailoverPool` with circuit breaker, `IpfsClient`.
- [apps/indexer](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/indexer) — Reorg-safe EVM event & failed-tx indexer with adaptive chunked backfill and atomic PostgreSQL rollback.
- [apps/api](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/api) — Node.js/TypeScript REST API, SIWE (EIP-4361) auth, IPFS pinning, cursor-paginated queries, stateless DB-offline verify fallback, EIP-712 relayer, OpenAPI docs at `/api/docs`.
- [apps/web](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/web) — Next.js 15 App Router UI covering Manufacturer Dashboard, Logistics Workbench, Blockchain Explorer & Anomaly Monitor, and Customer QR Portal (including Trustless Direct-RPC Verification).
- [scripts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/scripts) — Live E2E lifecycle demo (`demo_lifecycle.ts`) and 1M-product / 10k-concurrent-request benchmark (`benchmark_scale.ts`).
- [docs](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/docs) — Architecture blueprint, database ER schema, smart contract security audit, performance report, and interview architectural defense.

## Quickstart (Local Development)

1. **Copy environment template & install dependencies:**
   ```bash
   cp .env.example .env
   npm install
   ```
2. **Start PostgreSQL 16 + IPFS Kubo containers:**
   ```bash
   npm run docker:infra
   ```
3. **Start local Hardhat EVM node (Terminal 1):**
   ```bash
   npm run chain:node
   ```
4. **Deploy contracts & apply database migrations (Terminal 2):**
   ```bash
   npm run contracts:deploy:local
   npm run db:migrate
   ```
5. **Run Event Indexer, Backend API & Next.js Frontend:**
   ```bash
   npm run dev:indexer
   npm run dev:api
   npm run dev:web
   ```
   - Web Portal: `http://localhost:3000`
   - Swagger API Docs: `http://localhost:4000/api/docs`

## Testnet Deployment (Sepolia / EVM)

Set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY` in `.env`, then run:

```bash
npm run deploy:sepolia --workspace=@chaintrace/contracts
```

## Full Containerized Stack

```bash
docker compose --profile full up --build -d
```

## Verification & Benchmarking Commands

- Unit & shared crypto tests: `npm run test --workspace=@chaintrace/shared`
- Smart contract unit + gas report: `npm run test:gas --workspace=@chaintrace/contracts`
- Reorg-safe indexer integration test: `npm run test --workspace=@chaintrace/indexer -- --runInBand`
- API + DB/RPC failure-resilience integration test: `npm run test --workspace=@chaintrace/api -- --runInBand`
- End-to-end 5-party lifecycle demo: `npx tsx scripts/demo_lifecycle.ts`
- 1M-product & 10k-concurrency benchmark: `npx tsx scripts/benchmark_scale.ts`
