# ChainTrace Enterprise — Scalability & Million-Product Architecture

## 1. Critical Distinction: On-Chain vs. Merkle vs. PostgreSQL

To avoid misleading claims, ChainTrace explicitly distinguishes five separate unit counts:

| Concept | Where It Exists | Cost / Scaling Characteristic |
| :--- | :--- | :--- |
| **Registered Batch Units (`unitCount`)** | On-chain `Batch.unitCount` in `ChainTraceRegistry.sol` | `O(1)` gas (~213k gas) regardless of whether `unitCount` is `100` or `1,000,000` |
| **Merkle-Committed Products** | Leaves of `Batch.merkleRoot` + IPFS batch manifest | Off-chain Keccak256 tree; verifiable on-chain via `O(log2 N)` proof (~20 hashes for 1M units) |
| **Database Product Records** | `products` table in PostgreSQL 16 | Fast relational search projection; rebuildable from batch manifests + chain events |
| **Individually Materialized On-Chain Products** | `products[productId].initialized == true` (`Batch.splitCount`) | Created lazily on-chain only when a single unit splits from a batch or is claimed (~190k gas first split) |
| **Transferred / Claimed On-Chain Products** | `CustodyAccepted` / `ProductClaimed` events | ~53k–56k gas per hop |

## 2. Large-Batch Processing Safeguards

- **Bounded API Request Caps:** `CreateBatchRequestSchema` caps single-request batch preparation at `100,000` units to prevent HTTP timeout and unbounded memory allocation. Larger runs (e.g., 1,000,000 units) are split into 10 batches of 100,000 units each.
- **Chunked Database Ingestion:** `BatchService.prepareBatch` inserts `products` and encrypted `product_secrets` in atomic `UNNEST` chunks of `2,500` rows inside a single `BEGIN ... COMMIT` transaction (rolling back cleanly on any failure).
- **Proof Storage vs. Bounded LRU Tree Cache:** Batches `<= 2,000` units store `merkle_proof` inline in `JSONB`. Larger batches (`> 2,000`) cache the reconstructed `MerkleTreeInstance` in a bounded LRU cache (max 4 trees) so repeated QR/product lookups avoid reloading 100k rows from PostgreSQL on every request.
- **Duplicate Serial & ID Collision Prevention:** Within a batch, serials are deterministically indexed (`serialPrefix-000001`..`N`), and `productId = keccak256(abi.encode(manufacturer, batchId, serialNumber))` binds `manufacturer` + `batchCode` + `serialNumber` to eliminate cross-batch collisions.
