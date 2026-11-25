CREATE INDEX IF NOT EXISTS idx_products_serial_pattern ON products(serial_number text_pattern_ops);
