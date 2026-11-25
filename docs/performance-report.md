# ChainTrace Enterprise — Performance & Scalability Report

All measurements below were collected directly against local Docker PostgreSQL 16 and Node.js `v24.18.0` running [benchmark_scale.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/scripts/benchmark_scale.ts).

## 1. Smart Contract Gas Scaling (O(1) Batch Anchoring)

From `npm run test:gas --workspace=@chaintrace/contracts`:

| Operation | Batch Size / Scope | Gas Used (Observed) | Complexity |
| :--- | :--- | :--- | :--- |
| `registerBatch` | 100 units | ~`212,903` gas | `O(1)` |
| `registerBatch` | 1,000,000 units | ~`212,927` gas | `O(1)` (+24 gas calldata byte density) |
| `materializeAndInitiateTransfer` | 1 unit (lazy Merkle split) | `189,603` – `194,019` gas | `O(log N)` proof check |
| `initiateTransfer` | 1 already-materialized unit | `50,381` – `52,613` gas | `O(1)` |
| `acceptCustody` | 1 unit | `52,963` – `57,391` gas | `O(1)` |
| `acceptBatchCustody` | Whole batch (any size) | `50,384` gas | `O(1)` |
| `claimProduct` | 1 unit | `55,762` gas | `O(1)` |
| `recallBatch` | Whole batch (any size) | `35,812` gas | `O(1)` |

## 2. Cryptographic & PostgreSQL 1,000,000-Product Benchmarks

- **100,000-leaf Merkle Tree Generation:** `28,084.93 ms` – `30,951.81 ms` (single-threaded Node.js Keccak256)
- **PostgreSQL 1,000,000-Row Bulk Ingestion (`UNNEST` chunked 25k/batch):** `80,319.04 ms` (~12,450 rows/s)
- **Exact Serial Lookup (`SELECT * FROM products WHERE serial_number = ...`) at 1M rows:** `4.1 ms` – `5.07 ms`
- **Cursor Pagination (`ORDER BY product_id DESC LIMIT 25`) at 1M rows:** `2.31 ms` – `2.72 ms`

## 3. 10,000 Concurrent HTTP Requests Across 1,000,000 Products

Initial run using leading-wildcard `ILIKE '%BM1M-...%'` (`pg_trgm` GIN scan on common `'BM1M'` trigram prefix) measured `67.32 req/s` (`p50: 1,769.01 ms`, `p95: 2,970.31 ms`). Adding [004_serial_pattern_index.sql](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/api/src/db/migrations/004_serial_pattern_index.sql) (`text_pattern_ops` B-tree prefix index) and routing prefix queries through `LIKE 'q%'` improved throughput **19.6x**:

| Metric | Before (`ILIKE '%q%'`) | After (`text_pattern_ops` `LIKE 'q%'`) |
| :--- | :--- | :--- |
| Total Requests | `10,000` (200 concurrency window) | `10,000` (200 concurrency window) |
| Succeeded / Failed | `10,000` / `0` | `10,000` / `0` |
| Total Duration | `148,546.69 ms` | `7,564.90 ms` |
| Throughput | `67.32 req/s` | `1,321.89 req/s` |
| p50 Latency | `1,769.01 ms` | `107.85 ms` |
| p95 Latency | `2,970.31 ms` | `176.47 ms` |
| p99 Latency | `3,137.56 ms` | `421.94 ms` |
