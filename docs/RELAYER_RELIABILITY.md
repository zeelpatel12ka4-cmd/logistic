# ChainTrace Enterprise — Durable Relayer Reliability

**Implementation:** [relayer.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/api/src/routes/relayer.ts) & [006_durable_relayer.sql](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/api/src/db/migrations/006_durable_relayer.sql)

## Architecture
- **PostgreSQL Job Queue (`relayer_jobs`):** Replaces the single-process in-memory Promise queue with `SELECT ... FOR UPDATE SKIP LOCKED`, allowing safe horizontal scaling across multiple API/worker instances.
- **Idempotency:** Unique constraint on `idempotency_key` deduplicates concurrent or retried client submissions.
- **Persistent Nonce Manager (`relayer_signer_nonces`):** Row-locks `signer_address` (`FOR UPDATE`) and reconciles `Math.max(dbNonce, eth_getTransactionCount('pending'))` so concurrent workers never collide on nonces.
- **Crash Recovery & Gas Bump Replacement (RBF):** Stale `PROCESSING`/`SUBMITTED` locks (`>30s`) are automatically reclaimed on worker recovery, existing `tx_hash` receipts are checked before re-sending, and retries apply a `+15%` fee bump per attempt with exponential backoff.
- **Dead-Letter Handling & Balance Monitoring:** Permanent EVM reverts (`CALL_EXCEPTION`) or exhausted retries (`max_attempts = 5`) transition to `DEAD_LETTER`. `GET /api/relayer/status` exposes signer ETH balance and `lowBalanceWarning` (`< 0.05 ETH`).
