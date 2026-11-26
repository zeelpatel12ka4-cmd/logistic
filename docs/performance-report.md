# ChainTrace Enterprise — Performance & Scalability Report

**Environment:** Windows, Node.js `v24.18.0`, PostgreSQL 16 (Docker), Local Hardhat EVM (`chainId 31337`).
**Benchmark Script:** [benchmark_scale.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/scripts/benchmark_scale.ts)

## 1. Smart Contract Gas Scaling (Local Hardhat)

| Operation | Scope | Gas Used (Observed) | Complexity |
| :--- | :--- | :--- | :--- |
| `registerBatch` | 100 units vs 1,000,000 units | ~`212,903` vs ~`212,927` gas | `O(1)` |
| `materializeAndInitiateTransfer` | 1 unit (lazy Merkle split) | `189,603` – `194,019` gas | `O(log N)` |
| `initiateTransfer` / `acceptCustody` | 1 materialized unit | ~`50,381` – `57,391` gas | `O(1)` |
| `claimProduct` | 1 unit | ~`55,762` gas | `O(1)` |
| `recallBatch` | Whole batch | ~`35,812` gas | `O(1)` |

## 2. Cryptographic & PostgreSQL 1,000,000-Row Benchmarks (Latest Verified Run)

- **100,000-leaf Merkle Tree Generation:** `52,973.76 ms` (single-threaded Node.js Keccak256)
- **Exact Serial Lookup (`WHERE serial_number = ...`) at 1M rows:** `11.74 ms`
- **Cursor Pagination (`ORDER BY product_id DESC LIMIT 25`) at 1M rows:** `8.20 ms`

## 3. 10,000 Concurrent HTTP API Queries Across 1,000,000 Products

- **Total Requests:** `10,000` (concurrency window `200`)
- **Succeeded / Failed:** `10,000` / `0`
- **Total Duration:** `8,460.40 ms`
- **Throughput:** `1,181.98 req/s`
- **p50 / p95 / p99 Latency:** `122.99 ms` / `179.94 ms` / `522.45 ms`
