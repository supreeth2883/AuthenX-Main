/**
 * AuthenX Connector — Entry Point
 *
 * This service runs on the college's infrastructure (or approved deployment).
 * It connects to the college ERP and responds to verification requests from
 * the AuthenX API.
 */

import Fastify from 'fastify';
import dotenv from 'dotenv';
import { loadPrivateKey } from './core/crypto.js';
import { verifyRoutes } from './routes/verify.js';

dotenv.config();

const PORT = parseInt(process.env.CONNECTOR_PORT ?? '3002', 10);
const HOST = process.env.CONNECTOR_HOST ?? '0.0.0.0';

async function start() {
  console.log('\n🔌 AuthenX Connector starting...\n');

  // ── 1. Load and validate the college private key ─────────────────────────
  const privateKeyHex = process.env.COLLEGE_PRIVATE_KEY;
  if (!privateKeyHex) {
    console.error('❌ COLLEGE_PRIVATE_KEY is not set in environment');
    console.error('   Generate a key pair with: npm run keygen');
    process.exit(1);
  }

  try {
    loadPrivateKey(privateKeyHex);
  } catch (err) {
    console.error('❌ Failed to load private key:', err);
    process.exit(1);
  }

  // ── 2. Build Fastify app ─────────────────────────────────────────────────
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
    },
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    service: 'authenx-connector',
    mode: process.env.INTEGRATION_MODE ?? 'mock',
    timestamp: new Date().toISOString(),
  }));

  // Verification route
  await app.register(verifyRoutes);

  // ── 3. Start listening ───────────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n✅ AuthenX Connector running at http://${HOST}:${PORT}`);
    console.log(`   Mode: ${process.env.INTEGRATION_MODE ?? 'mock'}`);
    console.log(`   Health: http://localhost:${PORT}/health\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { console.log('Shutting down connector...'); process.exit(0); });
process.on('SIGINT', () => { console.log('Shutting down connector...'); process.exit(0); });

start();
