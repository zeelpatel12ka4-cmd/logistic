# ChainTrace Enterprise — Database Review & Query Analysis

**Migrations:** `apps/api/src/db/migrations/001_init.sql` through `006_durable_relayer.sql`

## Schema Integrity Controls
- **Primary & Foreign Keys:** `products.batch_id -> batches(batch_id)`, `product_secrets.product_id -> products(product_id)` (`ON DELETE CASCADE`).
- **Unique Constraints:** `product_events(chain_id, block_hash, tx_hash, log_index)`, `offchain_shipments(tx_hash)`, `relayer_jobs(idempotency_key)`.
- **Keyset Cursor Pagination:** Zero `OFFSET` queries; all list routes paginate by `(created_at DESC, batch_id DESC)`, `product_id DESC`, or `id < beforeId`.
- **Connection Pool & Isolation:** `pg` pool bounded (`max: 30`, `connectionTimeoutMillis: 3000`, `statement_timeout: 8000`). Multi-row state updates use `BEGIN ... COMMIT`, and relayer worker claiming uses `FOR UPDATE SKIP LOCKED`.
- **Rebuildable Projection:** All `batches`, `products`, and `product_events` rows can be truncated and rebuilt from canonical EVM logs + IPFS manifests.
