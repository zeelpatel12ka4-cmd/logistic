# ChainTrace Enterprise — Smart Contract Security Assessment

**Target Contract:** [ChainTraceRegistry.sol](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/packages/contracts/contracts/ChainTraceRegistry.sol)
**Compiler:** Solidity `0.8.28` (`cancun` EVM target, Optimizer `200` runs, `viaIR: true`)
**Base Libraries:** OpenZeppelin Contracts v5 (`AccessControl`, `EIP712`, `ECDSA`, `MerkleProof`, `ReentrancyGuard`)

---

## 1. Threat Model & Implemented Controls

| Security Domain | Threat Scenario | Mitigation Implemented in `ChainTraceRegistry.sol` | Verification Test |
| :--- | :--- | :--- | :--- |
| **Access Control (RBAC + Ownership)** | Rogue partner with `DISTRIBUTOR_ROLE` transfers another distributor's inventory | Enforces **both** `hasRole(...)` on target and `product.custodian == msg.sender` (or `batch.batchCustodian == msg.sender`) | `ChainTraceRegistry.test.ts` — `rejects tampered Merkle proof, wrong claim secret, unauthorized custodian, and zero address` |
| **Custody Hijack / Wrong Address** | Sending product to `address(0)` or an unprivileged wallet permanently burns tracking | Rejects `address(0)`, `to == msg.sender`, enforces `_resolveB2BTargetStatus(to)`, and requires 2-step `acceptCustody` / `acceptBatchCustody` | Tested across individual & batch custody flows |
| **Concurrent Race / Front-Running** | Two parallel calls attempt to transfer the same product simultaneously | Monotonic per-product `uint64 nonce` checked via `expectedNonce` (`StaleNonce`) + `pendingCustodian != address(0)` lock (`TransferAlreadyPending`) | Tested in `prevents concurrent conflicting transfer via monotonic nonce and pending lock` |
| **Signature Replay & Cross-Chain** | Attacker replays an EIP-712 `TransferIntent` or `ClaimIntent` signature | Domain separator binds `name`, `version`, `block.chainid`, and `address(this)`; requires `expectedNonce`, `deadline`, and non-zero `ECDSA.recover` | Tested in `supports EIP-712 signed meta-transactions and rejects signature replay & expiry` |
| **Merkle Second-Preimage Attack** | Attacker supplies internal 64-byte hash node as a forged leaf | Double-hashed `abi.encode` leaf: `keccak256(bytes.concat(keccak256(abi.encode(batchId, productId, serialNumber, metadataHash, claimSecretHash))))` | Tested against tampered serials & cross-package SDK parity |
| **Cross-Batch Product Replay** | Splitting `productId` under a different `batchId` after initialization | `_ensureMaterialized` verifies `product.batchId == batchId` (`BatchMismatch`) and locks splits while `pendingBatchCustodian != address(0)` | Verified in `_ensureMaterialized` and `verifyProductAuthenticity` |
| **QR Sticker Cloning** | Counterfeiter prints 10,000 copies of one valid box QR code | Leaf commits `keccak256(claimSecret)`; physical first claim transitions state to `Claimed` and rejects duplicates (`AlreadyClaimed`); API flags repeat scans | Tested in `completes Manufacturer -> Distributor -> Warehouse -> Retailer -> Customer Claim` |
| **Reentrancy** | Reentrant callback during custody state updates | `ReentrancyGuard` (`nonReentrant`) on all external state-mutating entrypoints + Checks-Effects-Interactions ordering | Verified across all external write methods |
| **Recall Bypass** | Split unit continues transferring after manufacturer recalls defective batch | `batch.recalled || product.recalled` checked on every transfer, accept, update, and `verifyProductAuthenticity` | Tested in `propagates batch recall to both unsplit and already-split units` |

---

## 2. Backend & Web3 Integration Security Controls

- **SIWE (EIP-4361) Authentication:** Single-use cryptographic nonces stored in `auth_nonces` with 5-minute TTL and atomic `UPDATE ... WHERE consumed_at IS NULL` consumption prevent signature replay.
- **No Plaintext Key Leakage:** Supply-chain actors sign via MetaMask in browser; `.env` is gitignored; `RELAYER_PRIVATE_KEY` is optional and isolated to server-side `RelayerQueueService`.
- **Input Validation & Headers:** Zod schemas validate every API boundary (`CreateBatchRequestSchema`, `QrPayloadSchema`, `ShipmentNoteSchema`, `Bytes32Schema`, `EvmAddressSchema`), protected by `helmet`, explicit `cors` allowlists, parameterized PostgreSQL queries, and rate limiting on `/api/auth`.

---

## 3. Residual Risks & Operational Recommendations

1. **Key Compromise on `DEFAULT_ADMIN_ROLE`:** In production mainnet/testnet deployments, `initialAdmin` should be a Gnosis Safe multisig (e.g., 3-of-5) rather than a single EOA key.
2. **Metadata Availability:** Pin batch manifests to redundant IPFS pinning clusters (or Filecoin/Arweave) in addition to the local Kubo node so `ipfsCid` remains retrievable globally.
3. **Relayer Balance Monitoring:** When enabling optional gasless claims via `RELAYER_PRIVATE_KEY`, configure balance alerting and per-IP/wallet quotas on `POST /api/relayer/claim`.

---

## 4. Production Dependency Audit Triage (`npm audit --omit=dev`)

`npm audit --omit=dev` reported 3 advisories (1 moderate, 2 high) with fixes requiring breaking major upgrades (`next@16` and `zod@4`):
- `postcss <=8.5.22` (via `next`): Only invoked during Next.js build-time CSS compilation on developer/CI machines, not on untrusted runtime user CSS input (not reachable in production HTTP paths).
- `zod <4.6.6` (memory exhaustion on oversized constrained collections): Mitigated at runtime by `express.json({ limit: '10mb' })`, explicit array/string `.max(...)` bounds on schemas, and strict `unitCount` / payload caps.
- `npm` install-script gate kept non-essential postinstall scripts (`@scarf/scarf`) blocked.

