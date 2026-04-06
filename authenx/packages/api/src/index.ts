/**
 * AuthenX API — Entry Point
 *
 * Starts the Fastify server after verifying the database connection.
 * Run: npm run dev (development) or npm start (production)
 */

import { buildApp } from './app.js';
import { checkDbConnection } from './db/client.js';
import { env } from './config/env.js';

async function start() {
  console.log('\n🔐 AuthenX API starting...\n');

  // ── 1. Verify database is reachable before accepting requests ────────────
  try {
    await checkDbConnection();
  } catch (err) {
    console.error('❌ Database connection failed. Is PostgreSQL running?');
    console.error('   Start it with: docker-compose up -d postgres');
    console.error(err);
    process.exit(1);
  }

  // ── 2. Build and start the Fastify app ───────────────────────────────────
  const app = await buildApp();

  try {
    await app.listen({ port: env.API_PORT, host: env.API_HOST });
    console.log(`\n✅ AuthenX API running at http://${env.API_HOST}:${env.API_PORT}`);
    console.log(`   Health check: http://localhost:${env.API_PORT}/health`);
    console.log(`   Environment: ${env.NODE_ENV}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT. Shutting down gracefully...');
  process.exit(0);
});

start();
