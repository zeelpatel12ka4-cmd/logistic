# ChainTrace Enterprise — API Security Review

## 1. Authentication & Session Controls
- **EIP-4361 (SIWE) Verification:** [authService.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/apps/api/src/services/authService.ts) enforces exact `siweMessage.domain === config.siweDomain` and `siweMessage.chainId === config.chainId`.
- **Single-Use Nonce Consumption:** Nonces have a 5-minute TTL and are atomically consumed via `UPDATE auth_nonces SET consumed_at = NOW() WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > NOW()`.
- **Fail-Closed Secrets:** `NODE_ENV=production` rejects missing, default, or `<32`-char `JWT_SECRET` and missing `SECRET_ENCRYPTION_KEY` at boot.
- **Live On-Chain Role Enforcement:** Sensitive mutating endpoints (`POST /api/batches/prepare`, `GET /api/batches/:batchId/products/:id/qr`, `POST /api/products/shipments`) use `requireLiveRoles` to re-query `ChainTraceRegistry.hasRole` on-chain, ensuring role revocations take effect immediately without waiting for JWT expiration.

## 2. Claim Secret & QR Security
- **AES-256-GCM at Rest:** `product_secrets.encrypted_claim_secret` uses random 12-byte IVs and authenticated encryption (`secretCrypto.ts`) with a separate `SECRET_ENCRYPTION_KEY` never stored in PostgreSQL.
- **Audit Trail Without Secret Exposure:** `secret_access_logs` records `batch_id`, `product_id`, `actor_wallet`, and `action` without ever logging plaintext secrets.
- **Automatic Retirement:** Both `Indexer` (`ProductClaimed`) and `BatchService.retireClaimSecret` clear `encrypted_claim_secret` and set `retired_at` once a product is claimed on-chain.
- **Physical Limitation:** Blockchain QR verification proves the digital commitment only, not physical authenticity of packaging. Production deployments should pair this with tamper-evident scratch-off QR labels or NFC cryptographic tags.
