/**
 * AuthenX API — Database Migration Runner
 *
 * Reads all .sql files from migrations/ directory in order and runs them.
 * Run with: npm run db:migrate
 */

import fs from 'fs';
import path from 'path';
import { db } from './client.js';
import { logger } from '../utils/logger.js';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations() {
  logger.info('Running AuthenX database migrations...');

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await db.connect();

  try {
    // Ensure migration tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id     SERIAL PRIMARY KEY,
        name   VARCHAR(200) UNIQUE NOT NULL,
        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const file of files) {
      const migrationName = file.replace('.sql', '');

      // Check if already ran
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE name = $1',
        [migrationName]
      );

      if (rows.length > 0) {
        logger.info(`  ✓ Skipping ${file} (already applied)`);
        continue;
      }

      logger.info(`  → Running ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1)',
          [migrationName]
        );
        await client.query('COMMIT');
        logger.info(`  ✓ ${file} applied successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info('All migrations complete.');
  } finally {
    client.release();
    await db.end();
  }
}

runMigrations().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
