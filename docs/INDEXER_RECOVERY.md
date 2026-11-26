# ChainTrace Enterprise — Indexer Recovery & Reorganization Safety

**Implementation:** [apps/indexer/src/indexer.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/indexer/src/indexer.ts)

## Guarantees
1. **Idempotent Event Ingestion:** `product_events` enforces `UNIQUE (chain_id, block_hash, tx_hash, log_index)` with `ON CONFLICT DO NOTHING`. Replaying blocks after a crash produces zero duplicate rows.
2. **Atomic Checkpoints:** `indexed_blocks`, `product_events`, `failed_transactions`, `batches`/`products` projections, and `indexer_checkpoints` all commit inside a single PostgreSQL `BEGIN ... COMMIT` transaction.
3. **Reorganization Detection & Rollback:** On each poll cycle, `findCommonAncestor` compares on-chain `blockHash` against `indexed_blocks`. On mismatch, `rollbackToAncestor` atomically marks orphaned events `is_reorged = TRUE`, logs `reorg_events`, deletes batches born in orphaned blocks, and recomputes affected `batches` and `products` strictly from canonical events `<= ancestor`.
4. **Adaptive Chunked Backfill:** Starts at `initialChunkSize` (`2000` blocks) and halves down to `100` on RPC log-range errors.
5. **Failed Transaction Separation:** Reverted calls (`receipt.status === 0`) targeting `ChainTraceRegistry` are decoded into `failed_transactions` and never mixed with emitted contract events.
6. **Secret Retirement on Claim:** When `ProductClaimed` is indexed, `product_secrets` clears `encrypted_claim_secret` and sets `retired_at = NOW()`.
