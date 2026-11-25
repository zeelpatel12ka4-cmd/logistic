# ChainTrace Enterprise — Interview Architectural Defense (Questions 1–5)

### Question 1: Why do we need blockchain here? Why can't we simply use PostgreSQL?
In a supply chain with 5 competing legal entities (`Manufacturer`, `Distributor`, `Warehouse`, `Retailer`, `Customer`), any single PostgreSQL database is controlled by whoever holds DBA credentials or cloud IAM access. A compromised distributor or rogue insider could silently execute `UPDATE products SET current_custodian = ...` and rewrite `audit_logs` with zero cryptographic trace.
With [ChainTraceRegistry.sol](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/packages/contracts/contracts/ChainTraceRegistry.sol), ownership transitions require cryptographic signatures from the authorized custodian's private key, emit immutable event logs, and are verified by decentralized consensus. PostgreSQL in ChainTrace is strictly a fast, **rebuildable** search index.

---

### Question 2: If a manufacturer tries to modify a product's registration history, how will your architecture prevent or expose it?
1. **On-Chain Immutability:** Once `registerBatch(batchId, merkleRoot, ipfsCid, unitCount)` confirms, `_batches[batchId]` cannot be overwritten (`BatchAlreadyExists`), and `merkleRoot` + `ipfsCid` + `createdAt` (`block.timestamp`) are permanently anchored on-chain.
2. **Cryptographic Integrity Link:** Each unit leaf commits `(batchId, productId, serialNumber, metadataHash, claimSecretHash)`. Changing even one character of off-chain specifications breaks `keccak256(canonicalJson) == metadataHash` and fails `MerkleProof.verify(...)`.
3. **Live Explorer Exposure:** `GET /api/explorer/anomalies` and [explorer/page.tsx](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/web/src/app/explorer/page.tsx) run a live DB-vs-Chain integrity diff comparing PostgreSQL `merkle_root`, `batch_custodian`, and `recalled` against `ChainTraceRegistry.getBatch(...)`, surfacing any silent DB alteration immediately (`TAMPERED_MISMATCH`).

---

### Question 3: If 10,000 transactions arrive simultaneously, how will the system handle them?
1. **Read Scalability (10,000 Verification/Search Requests):** Handled horizontally by PostgreSQL connection pooling, keyset cursor pagination (`002_perf_indexes.sql` B-tree + `pg_trgm` GIN indexes), and `RpcFailoverPool` circuit breakers.
2. **Batch Registration Scalability:** Anchoring 100,000 products takes **1 on-chain transaction** (~213k gas) via Merkle-root batching rather than 100,000 separate EVM transactions.
3. **Write Concurrency & EVM Nonce Serialization:** Partners sign with their own distributed MetaMask wallets (independent EOAs = independent nonce spaces). For gasless meta-transactions routed through [relayer.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/api/src/routes/relayer.ts), `RelayerQueueService` claims an atomic Postgres `idempotency_key` (`relayer_jobs` unique constraint) and serializes signing through a strict queue so concurrent callers never trigger `NONCE_EXPIRED` collisions, while `StaleNonce` on-chain guards per-product concurrent mutations.

---

### Question 4: What happens if the blockchain transaction succeeds but the backend server crashes before updating PostgreSQL?
Because PostgreSQL is **not** updated by client `POST` trust:
- Transactions go directly from MetaMask (or relayer) to the EVM network.
- [ReorgSafeIndexer](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/indexer/src/indexer.ts) tracks `indexer_checkpoints` inside the exact same Postgres `BEGIN ... COMMIT` transaction as `product_events` and `products`/`batches` projections, with `UNIQUE (chain_id, block_hash, tx_hash, log_index)` idempotency.
- If the backend API crashes mid-flight, restarting the API or indexer simply resumes from `last_indexed_block + 1` (using adaptive chunked `eth_getLogs` backfill) and reconciles the confirmed on-chain state automatically with zero lost or duplicated records.

---

### Question 5: How will you prove that a product's ownership history is genuine without trusting your own backend server?
The Customer Verification Portal ([verify/page.tsx](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/web/src/app/verify/page.tsx)) includes a **Trustless Direct-RPC Mode** toggle (and the API also supports stateless `CHAIN_DIRECT_DB_DEGRADED` fallback when PostgreSQL is offline):
1. The QR code carries the self-contained cryptographic proof `(chainId, contractAddress, batchId, productId, serialNumber, metadataHash, claimSecretHash, merkleProof)`.
2. The customer's browser computes `computeLeaf(...)` locally, connects directly to Ethereum RPC / MetaMask (`verifyDirectlyViaRpc`), and calls `ChainTraceRegistry.verifyProductAuthenticity(...)` + checks IPFS CID hash directly — proving batch authenticity, Merkle inclusion, manufacturer address, current custodian, recall status, and claim status **with zero reliance on our backend API or PostgreSQL**.
