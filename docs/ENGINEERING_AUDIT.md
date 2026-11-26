# ChainTrace Enterprise — Baseline Engineering Audit

**Audit Date:** 2026-11-25
**Repository:** `https://github.com/zeelpatel12ka4-cmd/logistic.git` (Baseline commit: `d3d13ce`)

---

## 1. Existing Architecture & Working Functionality

The repository is an npm workspaces monorepo implementing a 5-party supply chain tracking platform (`Manufacturer → Distributor → Warehouse → Retailer → Customer`):
- **Smart Contracts (`packages/contracts`):** `ChainTraceRegistry.sol` (Solidity `0.8.28`, OpenZeppelin `AccessControl`, `EIP712`, `MerkleProof`, `ReentrancyGuard`) supporting O(1)-gas batch Merkle root anchoring, lazy individual unit materialization, 2-step custody transfers, monotonic per-product nonces, EIP-712 meta-transactions, sealed claim secrets, and batch/unit recalls.
- **Shared SDK (`packages/shared`):** Canonical Keccak256 leaf/tree builder, Zod validation schemas, ABI bindings, `RpcFailoverPool` with circuit breaker, and `IpfsClient`.
- **Indexer (`apps/indexer`):** `ReorgSafeIndexer` with chunked log backfill, `block_hash` reorg detection + rollback, reverted transaction decoding, and idempotent PostgreSQL commits.
- **Backend API (`apps/api`):** Express + TypeScript REST API with SIWE auth, batch preparation, IPFS pinning, keyset-paginated search, explorer/anomaly endpoints, stateless DB-offline verify fallback, and Swagger `/api/docs`.
- **Frontend (`apps/web`):** Next.js 15 App Router UI with MetaMask integration, Manufacturer, Logistics, Explorer, and Customer Verification (QR camera/upload/ID + Direct-RPC mode).

---

## 2. Baseline Build & Test Status

| Check | Baseline Status | Notes |
| :--- | :--- | :--- |
| `npm run lint` | **FAIL** | `apps/web` `next lint` prompts interactively due to missing ESLint config; other workspaces lack `lint` scripts |
| `npm run typecheck` | PASS | All 5 workspaces pass `tsc --noEmit` |
| `@chaintrace/shared` tests | PASS | 6/6 unit tests pass |
| `@chaintrace/contracts` tests | PASS | 9/9 unit tests pass; branch coverage is `58.4%` (below 90% critical target) |
| `apps/api` Docker build (`dist/`) | **FAIL (latent)** | `tsc` does not copy `.sql` files from `src/db/migrations/` to `dist/db/migrations/` |

---

## 3. Prioritized Findings

### Critical
1. **Plaintext Claim Secrets at Rest (`apps/api/src/services/batchService.ts`, `001_init.sql`):** `product_secrets.claim_secret` is stored unencrypted in PostgreSQL and is never retired/deleted after a product is claimed on-chain.
2. **Non-Durable In-Memory Relayer Queue (`apps/api/src/routes/relayer.ts`):** `RelayerQueueService` uses an in-memory Promise chain (`this.queue`). Process restarts lose pending jobs; multi-instance deployments collide on signer nonces; no retry/backoff or dead-letter handling exists.
3. **Production Migration Path Missing in Compiled `dist/` (`apps/api/src/db/migrate.ts`):** `tsc` omits `.sql` files from `apps/api/dist/db/migrations/`, causing Dockerized `api` startup migrations to fail with `ENOENT`.

### High
4. **SIWE Auth Domain/Chain Validation & Stale JWT Role Trust (`apps/api/src/services/authService.ts`, `middleware/auth.ts`):** `verifySiweAndCreateSession` does not enforce `siweMessage.domain === config.siweDomain` or `siweMessage.chainId === config.chainId`. Protected write routes trust roles cached in 12h JWTs without re-verifying on-chain role revocation.
5. **Hardcoded Default `JWT_SECRET` in Production (`apps/api/src/config.ts`, `docker-compose.yml`):** API starts with a known fallback secret even when `NODE_ENV=production`.
6. **Docker Security Defaults (`infra/docker/*`, `docker-compose.yml`):** Containers run as `root`; PostgreSQL (`5432`) and IPFS Admin API (`5001`) bind to `0.0.0.0` instead of `127.0.0.1`.
7. **Broken Lint & Incomplete CI Gates (`apps/web`, `.github/workflows/ci.yml`):** `npm run lint` fails non-interactively; CI lacks `lint`, `typecheck`, `contracts:coverage`, `permissions:` block, and dependency audit.

### Medium
8. **Smart Contract Coverage & Edge Cases (`ChainTraceRegistry.sol`):** Branch coverage is `58.4%`. `recallBatch`/`flagProduct` do not clear `pendingBatchCustodian`/`pendingCustodian`. `claimProduct` allows claiming at `Manufactured` without an explicit direct-to-consumer flag.
9. **Merkle & Large-Batch Memory Footprint (`batchService.ts`):** Preparing `100,000` units holds full arrays in memory and recomputes entire trees synchronously from DB for batches `> 2,000` units.
10. **IPFS & Frontend Authenticity Distinctions (`verify.ts`, `verify/page.tsx`):** Backend/UI do not explicitly distinguish `IPFS_OFFLINE`, `CID_INVALID`, `CONTENT_HASH_MISMATCH`, and physical-authenticity limitations (QR cloning vs physical packaging).

### Low
11. **Toolchain & Documentation Alignment:** Root `package.json` `engines.node` says `>=20.0.0`, CI uses Node `22`, local uses `24.18.0`; `README.md` and `docs/` need alignment with exact audited toolchain and separated benchmarks.

---

## 4. Remediation Plan

Execute Phases 2–14 sequentially:
1. Standardize toolchain, ESLint configs, and `dist` migration asset copying (`Phase 2`).
2. Harden `ChainTraceRegistry.sol` and raise branch coverage to >=90% (`Phase 3`).
3. Optimize Merkle memory/chunking and document on-chain vs DB counts (`Phase 4`).
4. Encrypt `product_secrets` at rest (AES-256-GCM + separate key), add audit logging without secret exposure, and retire secrets on claim (`Phase 5`).
5. Harden SIWE domain/chainId checks, live on-chain role verification, and fail-closed `JWT_SECRET` (`Phase 6`).
6. Replace in-memory relayer with durable PostgreSQL `FOR UPDATE SKIP LOCKED` job queue + persistent nonce manager (`Phase 7`).
7. Harden Indexer recovery, DB `EXPLAIN ANALYZE` review, and IPFS status classification (`Phases 8–9`).
8. Update Frontend authenticity states and physical-security disclaimers (`Phase 10`).
9. Harden Docker non-root images, localhost bindings, and GitHub Actions CI (`Phase 11`).
10. Run separated benchmarks and 30-step E2E acceptance test, then finalize all `docs/*.md` and `README.md` (`Phases 12–14`).
