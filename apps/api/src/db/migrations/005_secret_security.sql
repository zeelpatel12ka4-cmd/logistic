ALTER TABLE product_secrets
  ALTER COLUMN claim_secret DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS encrypted_claim_secret TEXT,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_reason VARCHAR(64);

CREATE TABLE IF NOT EXISTS secret_access_logs (
  id BIGSERIAL PRIMARY KEY,
  batch_id VARCHAR(66) NOT NULL,
  product_id VARCHAR(66) NOT NULL,
  actor_wallet VARCHAR(42) NOT NULL,
  action VARCHAR(64) NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secret_access_product ON secret_access_logs(product_id, accessed_at DESC);
