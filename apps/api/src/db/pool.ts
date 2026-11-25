import { Pool } from 'pg';

export function createDbPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 30,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 8_000,
  });
}

export async function isDbHealthy(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
