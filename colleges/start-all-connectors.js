'use strict';
/**
 * AuthenX — Start All College Connectors
 * Spawns one connector process per registered college.
 * Each connector runs on its own port (from registry.json).
 *
 * Usage: node colleges/start-all-connectors.js
 * Stop:  Ctrl+C (gracefully kills all child processes)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const COLLEGES_DIR = __dirname;
const REGISTRY_FILE = path.join(COLLEGES_DIR, 'registry.json');
const CONNECTOR_SCRIPT = path.join(COLLEGES_DIR, '..', 'authenx-connector', 'connector.js');

if (!fs.existsSync(REGISTRY_FILE)) {
  console.error('❌ registry.json not found. Run setup.js first.');
  process.exit(1);
}

if (!fs.existsSync(CONNECTOR_SCRIPT)) {
  console.error('❌ connector.js not found at', CONNECTOR_SCRIPT);
  process.exit(1);
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
const processes = [];
let onlineCount = 0;

console.log('\n🚀 Starting 10 College Connectors...\n');
console.log('   Code  │ Name                │ Port');
console.log('  ───────┼─────────────────────┼──────');
for (const c of registry) {
  console.log(`   ${c.short_code.padEnd(5)} │ ${c.name.padEnd(19)} │ ${c.port}`);
}
console.log('');

for (const c of registry) {
  const envFile = path.join(COLLEGES_DIR, c.short_code, '.env');
  if (!fs.existsSync(envFile)) {
    console.error(`   ❌ [${c.short_code}] No .env file found`);
    continue;
  }

  const env = { ...process.env, ENV_FILE: envFile };
  const p = spawn('node', [CONNECTOR_SCRIPT], {
    env,
    stdio: 'pipe',
    cwd: path.join(COLLEGES_DIR, c.short_code),
  });

  p.stdout.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('Online') || msg.includes('listening')) {
      onlineCount++;
      console.log(`   ✅ [${c.short_code.padEnd(5)}] Online → port ${c.port}  (${onlineCount}/${registry.length})`);
    }
  });

  p.stderr.on('data', d => {
    const msg = d.toString().trim();
    // Filter out experimental warnings
    if (msg.includes('ExperimentalWarning')) return;
    console.error(`   ⚠️  [${c.short_code}] ${msg}`);
  });

  p.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.log(`   🛑 [${c.short_code}] Exited with code ${code}`);
    }
  });

  processes.push({ proc: p, college: c });
}

// Graceful shutdown
function shutdown() {
  console.log('\n\n🛑 Shutting down all connectors...');
  for (const { proc, college } of processes) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep process alive
process.stdin.resume();
console.log('   Waiting for connectors to start...\n');
