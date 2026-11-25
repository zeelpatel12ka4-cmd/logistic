CREATE INDEX IF NOT EXISTS idx_products_serial_exact ON products(serial_number);
CREATE INDEX IF NOT EXISTS idx_products_id_pattern ON products(product_id text_pattern_ops);
