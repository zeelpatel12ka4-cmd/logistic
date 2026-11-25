CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexed_blocks (
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash VARCHAR(66) NOT NULL,
  parent_hash VARCHAR(66) NOT NULL,
  timestamp_sec BIGINT NOT NULL,
  is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  chain_id INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,
  last_indexed_block BIGINT NOT NULL,
  last_indexed_hash VARCHAR(66) NOT NULL,
  last_finalized_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, contract_address)
);

CREATE TABLE IF NOT EXISTS reorg_events (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  detected_at_block BIGINT NOT NULL,
  common_ancestor_block BIGINT NOT NULL,
  orphaned_block_hashes TEXT[] NOT NULL,
  rolled_back_event_count INTEGER NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batches (
  batch_id VARCHAR(66) PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  batch_code VARCHAR(128),
  product_name VARCHAR(160),
  sku VARCHAR(64),
  category VARCHAR(64),
  manufacturer_name VARCHAR(128),
  serial_prefix VARCHAR(64),
  manufacturer_address VARCHAR(42) NOT NULL,
  batch_custodian VARCHAR(42) NOT NULL,
  pending_batch_custodian VARCHAR(42),
  merkle_root VARCHAR(66) NOT NULL,
  ipfs_cid TEXT NOT NULL,
  unit_count BIGINT NOT NULL,
  split_count BIGINT NOT NULL DEFAULT 0,
  batch_nonce BIGINT NOT NULL DEFAULT 0,
  batch_status SMALLINT NOT NULL DEFAULT 1,
  previous_batch_status SMALLINT NOT NULL DEFAULT 1,
  recalled BOOLEAN NOT NULL DEFAULT FALSE,
  onchain_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB,
  metadata_hash VARCHAR(66),
  metadata_verified BOOLEAN NOT NULL DEFAULT FALSE,
  tx_hash VARCHAR(66),
  block_number BIGINT,
  is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batches_manufacturer ON batches(manufacturer_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batches_custodian ON batches(batch_custodian, batch_status);
CREATE INDEX IF NOT EXISTS idx_batches_pending ON batches(pending_batch_custodian) WHERE pending_batch_custodian IS NOT NULL;

CREATE TABLE IF NOT EXISTS products (
  product_id VARCHAR(66) PRIMARY KEY,
  batch_id VARCHAR(66) NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
  serial_number VARCHAR(128) NOT NULL,
  leaf_index INTEGER NOT NULL,
  metadata_hash VARCHAR(66) NOT NULL,
  claim_secret_hash VARCHAR(66) NOT NULL,
  merkle_proof JSONB,
  is_materialized BOOLEAN NOT NULL DEFAULT FALSE,
  current_custodian VARCHAR(42) NOT NULL,
  pending_custodian VARCHAR(42),
  custody_status SMALLINT NOT NULL DEFAULT 1,
  previous_status SMALLINT NOT NULL DEFAULT 1,
  nonce BIGINT NOT NULL DEFAULT 0,
  claimed BOOLEAN NOT NULL DEFAULT FALSE,
  recalled BOOLEAN NOT NULL DEFAULT FALSE,
  last_tx_hash VARCHAR(66),
  last_block_number BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_secrets (
  product_id VARCHAR(66) PRIMARY KEY REFERENCES products(product_id) ON DELETE CASCADE,
  claim_secret VARCHAR(128) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_batch_serial ON products(batch_id, serial_number);
CREATE INDEX IF NOT EXISTS idx_products_custodian_status ON products(current_custodian, custody_status);
CREATE INDEX IF NOT EXISTS idx_products_pending_custodian ON products(pending_custodian) WHERE pending_custodian IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_serial_trgm ON products USING gin (serial_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_cursor ON products(created_at DESC, product_id DESC);

CREATE TABLE IF NOT EXISTS product_events (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash VARCHAR(66) NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  event_name VARCHAR(64) NOT NULL,
  batch_id VARCHAR(66),
  product_id VARCHAR(66),
  from_address VARCHAR(42),
  to_address VARCHAR(42),
  status_code SMALLINT,
  nonce BIGINT,
  payload JSONB NOT NULL,
  block_timestamp BIGINT NOT NULL,
  is_reorged BOOLEAN NOT NULL DEFAULT FALSE,
  is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, block_hash, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_product_history ON product_events(product_id, block_number DESC, log_index DESC) WHERE is_reorged = FALSE;
CREATE INDEX IF NOT EXISTS idx_events_batch_history ON product_events(batch_id, block_number DESC, log_index DESC) WHERE is_reorged = FALSE;
CREATE INDEX IF NOT EXISTS idx_events_active_block ON product_events(chain_id, block_number) WHERE is_reorged = FALSE;
CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON product_events(tx_hash);

CREATE TABLE IF NOT EXISTS failed_transactions (
  tx_hash VARCHAR(66) PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash VARCHAR(66) NOT NULL,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  method_name VARCHAR(128),
  decoded_error VARCHAR(256),
  raw_revert_data TEXT,
  product_id VARCHAR(66),
  batch_id VARCHAR(66),
  block_timestamp BIGINT NOT NULL,
  is_reorged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_txs_block ON failed_transactions(block_number DESC) WHERE is_reorged = FALSE;

CREATE TABLE IF NOT EXISTS offchain_shipments (
  id BIGSERIAL PRIMARY KEY,
  tx_hash VARCHAR(66) NOT NULL UNIQUE,
  product_id VARCHAR(66),
  batch_id VARCHAR(66),
  submitted_by VARCHAR(42) NOT NULL,
  carrier_name VARCHAR(128) NOT NULL,
  tracking_number VARCHAR(128) NOT NULL,
  origin_location VARCHAR(128) NOT NULL,
  destination_location VARCHAR(128) NOT NULL,
  temperature_range VARCHAR(64),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGSERIAL PRIMARY KEY,
  product_id VARCHAR(66) NOT NULL,
  scanner_region VARCHAR(128) NOT NULL,
  client_fingerprint VARCHAR(128),
  was_already_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspicious BOOLEAN NOT NULL DEFAULT FALSE,
  anomaly_reason TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_product ON scan_logs(product_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS users (
  wallet_address VARCHAR(42) PRIMARY KEY,
  display_name VARCHAR(128),
  role VARCHAR(32) NOT NULL DEFAULT 'CUSTOMER',
  organization_name VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce VARCHAR(128) PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS relayer_jobs (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  job_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  tx_hash VARCHAR(66),
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
