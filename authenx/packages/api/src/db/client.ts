/**
 * AuthenX API — Database Client
 *
 * PostgreSQL connection pool using the 'pg' library.
 * All database queries in AuthenX go through this client.
 *
 * Usage:
 *   import { db } from '../db/client.js';
 *   const result = await db.query('SELECT * FROM colleges WHERE id = $1', [id]);
 */

import { Pool, type PoolClient } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// ─── Connection Pool ──────────────────────────────────────────────────────────

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // SECURITY: never log queries in production (could contain sensitive data)
  ...(env.NODE_ENV === 'development' && {
    log: (msg: string) => logger.debug({ msg }, 'DB query'),
  }),
});

// ─── Connection Events ────────────────────────────────────────────────────────

db.on('connect', () => {
  logger.debug('New DB connection established');
});

db.on('error', (err) => {
  logger.error({ err }, 'Unexpected DB pool error');
});

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * Tests the database connection.
 * Called on startup to verify the DB is reachable before accepting requests.
 */
export async function checkDbConnection(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT 1');
    logger.info('Database connection verified');
  } finally {
    client.release();
  }
}

// ─── Transaction Helper ───────────────────────────────────────────────────────

/**
 * Runs a set of queries inside a single transaction.
 * Automatically commits on success, rolls back on error.
 *
 * Usage:
 *   await withTransaction(async (client) => {
 *     await client.query('INSERT INTO ...', [...]);
 *     await client.query('UPDATE ...', [...]);
 *   });
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
