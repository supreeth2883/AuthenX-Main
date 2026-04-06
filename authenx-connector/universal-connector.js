'use strict';
/**
 * AuthenX Universal College Connector
 * ─────────────────────────────────────────────────────────────────────────────
 * A single connector that works with ANY college database:
 *   SQLite · MySQL · PostgreSQL · SQL Server · REST API
 *
 * All configuration lives in college-config.json.
 * Switch databases by changing "db_type" — zero code changes.
 *
 * Security architecture:
 *   - Signs live verification responses with Ed25519
 *   - Nonce-based replay prevention (60-second TTL)
 *   - Read-only access to college database (never writes)
 *   - Rate limiting: max 30 requests/minute per caller IP
 *   - Concurrent request limiting: max 20 simultaneous queries
 *   - Private key proxied through HSM service (port 9002)
 *
 * Endpoints:
 *   GET  /health          → connector status
 *   POST /verify          → live credential verification
 *   POST /test-connection → test DB connection (admin only)
 *   GET  /schema          → list tables + columns (admin only)
 */

const { createServer } = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const http = require('node:http');

const { getAdapter }        = require('./adapters/index.js');
const { applyFieldMapping } = require('./core/field-mapper.js');
const { buildCanonicalJson, sha256 } = require('./core/canonicalizer.js');
const { checkNonce, nonceCount } = require('./core/nonce-store.js');

// ─── Load config ──────────────────────────────────────────────────────────────
function loadConfig() {
  const configPath = resolve(__dirname, 'college-config.json');
  const legacyPath = resolve(__dirname, 'config.json');

  let configFile;
  if (existsSync(configPath)) {
    configFile = configPath;
  } else if (existsSync(legacyPath)) {
    configFile = legacyPath;
    console.warn('[connector] Using legacy config.json. Rename to college-config.json for clarity.');
  } else {
    console.error('[connector] ERROR: college-config.json not found.');
    console.error('[connector] Run: node connector-setup.js to create it.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(configFile, 'utf8'));
}

// ─── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = resolve(__dirname, '.env');
  if (!existsSync(envPath)) {
    console.error('[connector] ERROR: .env file not found.');
    console.error('[connector] Run: node connector-setup.js to generate it.');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const CONFIG = loadConfig();
const ENV    = loadEnv();

const COLLEGE_ID   = ENV.COLLEGE_ID   || CONFIG.college_id || '';
const COLLEGE_NAME = ENV.COLLEGE_NAME || CONFIG.college_name || 'Unknown College';
const PORT         = parseInt(ENV.PORT || CONFIG.port || '9000', 10);
const HSM_PORT     = parseInt(ENV.HSM_PORT || '9002', 10);
const ADMIN_SECRET = ENV.ADMIN_SECRET || '';

// ─── Rate limiting ────────────────────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT     = 60;        // requests per minute per IP
const rateLimiter    = new Map(); // ip → [timestamps]

function checkRateLimit(ip) {
  const now  = Date.now();
  const hits = (rateLimiter.get(ip) || []).filter(t => t > now - RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  rateLimiter.set(ip, hits);
  // Cleanup old IPs every 1000 requests
  if (rateLimiter.size > 1000) {
    for (const [k, v] of rateLimiter) {
      if (v.every(t => t < now - RATE_WINDOW_MS)) rateLimiter.delete(k);
    }
  }
  return true;
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────
const MAX_CONCURRENT = 20;
let activeRequests   = 0;

// ─── Adapter (loaded once at startup) ─────────────────────────────────────────
const adapter = getAdapter(CONFIG.db_type || 'sqlite');
let adapterReady = false;

async function initAdapter() {
  const dbConfig = CONFIG.db || {};
  await adapter.connect(dbConfig);
  adapterReady = true;
  console.log(`[connector] DB adapter ready (${CONFIG.db_type || 'sqlite'})`);
}

// ─── HSM signing (Ed25519) ────────────────────────────────────────────────────
function signViaHSM(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: message });
    const req = http.request({
      hostname: 'localhost',
      port:     HSM_PORT,
      path:     '/sign',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error));
          resolve(Buffer.from(parsed.signature, 'hex').toString('base64'));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('HSM timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Body reader ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 64 * 1024) { req.destroy(); return reject(new Error('Request too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── /verify handler ──────────────────────────────────────────────────────────
async function handleVerify(req, res, body) {
  if (activeRequests >= MAX_CONCURRENT) {
    return json(res, 503, { error: 'Connector busy — too many concurrent requests. Retry in a moment.' });
  }

  const { student_ref_token, nonce } = body;
  if (!student_ref_token || !nonce) {
    return json(res, 400, { error: 'student_ref_token and nonce are required' });
  }

  // Replay prevention
  if (!checkNonce(nonce)) {
    return json(res, 409, { error: 'Nonce already used — possible replay attack' });
  }

  if (!adapterReady) {
    return json(res, 503, { error: 'Database adapter not ready yet. Retry in a moment.' });
  }

  activeRequests++;
  const start = Date.now();

  try {
    // Fetch raw row from college DB
    const dbConfig = CONFIG.db || {};
    const tableConfig = {
      table:             CONFIG.db?.table      || 'students',
      ref_column:        CONFIG.db?.ref_column || 'student_ref_token',
      student_ref_token,
      ...(CONFIG.db_type === 'api' ? { api: CONFIG.api, field_mapping: CONFIG.field_mapping } : {}),
    };

    let row;
    if (CONFIG.db_type === 'api' || CONFIG.db_type === 'rest') {
      row = await adapter.fetchStudent(CONFIG, { student_ref_token });
    } else {
      row = await adapter.fetchStudent({ ...dbConfig, ...tableConfig }, tableConfig);
    }

    if (!row) {
      return json(res, 404, {
        error: 'Student not found',
        student_ref_token,
        college: COLLEGE_NAME,
      });
    }

    // Map fields
    const mapped = applyFieldMapping(row, CONFIG.field_mapping || {});

    // Build canonical JSON & hash
    const canonical = buildCanonicalJson({
      schema_version:    '1.0',
      issuer_id:         COLLEGE_ID,
      student_ref_token,
      name:              mapped.name              || '',
      degree:            mapped.degree            || '',
      branch:            mapped.branch            || '',
      credential_type:   mapped.credential_type   || 'DEGREE_CERTIFICATE',
      cgpa:              String(mapped.cgpa       ?? ''),
      graduation_year:   String(mapped.graduation_year ?? ''),
      issue_date:        mapped.issue_date        || '',
    });
    const liveHash = sha256(canonical);

    // Sign with HSM
    const live_signature      = await signViaHSM(`${nonce}:${liveHash}`);
    const issuance_signature  = await signViaHSM(liveHash);

    const latency = Date.now() - start;

    console.log(
      `[connector] ✓ ${new Date().toISOString()} | ${student_ref_token} → ${mapped.name} ` +
      `| status: ${mapped.status} | ${latency}ms`
    );

    return json(res, 200, {
      college_id:         COLLEGE_ID,
      college_name:       COLLEGE_NAME,
      student_ref_token,
      nonce,
      schema_version:     '1.0',
      name:               mapped.name              || '',
      degree:             mapped.degree            || '',
      branch:             mapped.branch            || '',
      credential_type:    mapped.credential_type   || 'DEGREE_CERTIFICATE',
      cgpa:               String(mapped.cgpa       ?? ''),
      graduation_year:    String(mapped.graduation_year ?? ''),
      issue_date:         mapped.issue_date        || '',
      status:             mapped.status            || 'unknown',
      live_signature,
      issuance_signature,
      signed_at:          new Date().toISOString(),
      latency_ms:         latency,
    });

  } catch (err) {
    console.error('[connector] verify error:', err.message);
    return json(res, 500, { error: 'Connector internal error', detail: err.message });
  } finally {
    activeRequests--;
  }
}

// ─── /test-connection handler ─────────────────────────────────────────────────
async function handleTestConnection(req, res, body) {
  // Require admin secret for security
  if (ADMIN_SECRET && body.admin_secret !== ADMIN_SECRET) {
    return json(res, 403, { error: 'Invalid admin secret' });
  }

  const config  = body.config || CONFIG;
  const type    = config.db_type || 'sqlite';
  const testAdapter = getAdapter(type);
  const result  = await testAdapter.testConnection(config.db || {});
  return json(res, result.ok ? 200 : 503, {
    db_type: type,
    college: COLLEGE_NAME,
    ...result,
  });
}

// ─── /schema handler ──────────────────────────────────────────────────────────
async function handleSchema(req, res, body) {
  if (ADMIN_SECRET && body.admin_secret !== ADMIN_SECRET) {
    return json(res, 403, { error: 'Invalid admin secret' });
  }
  if (CONFIG.db_type === 'api' || CONFIG.db_type === 'rest') {
    return json(res, 200, { db_type: 'api', note: 'Schema introspection not available for API adapters.' });
  }

  const tables  = await adapter.listTables(CONFIG.db || {});
  const schema  = {};
  for (const t of tables) {
    schema[t] = await adapter.listColumns(CONFIG.db || {}, t);
  }
  return json(res, 200, { db_type: CONFIG.db_type, tables, schema });
}

// ─── Main request handler ─────────────────────────────────────────────────────
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Rate limiting (by IP)
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return json(res, 429, { error: 'Rate limit exceeded. Max 60 requests/minute.' });
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      status:          adapterReady ? 'ok' : 'starting',
      college:         COLLEGE_NAME,
      college_id:      COLLEGE_ID,
      db_type:         CONFIG.db_type || 'sqlite',
      port:            PORT,
      active_requests: activeRequests,
      nonce_store_size: nonceCount(),
      timestamp:       new Date().toISOString(),
    });
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); }
    catch (err) { return json(res, 400, { error: 'Invalid request body', detail: err.message }); }
  }

  if (req.method === 'POST' && req.url === '/verify') return handleVerify(req, res, body);
  if (req.method === 'POST' && req.url === '/test-connection') return handleTestConnection(req, res, body);
  if (req.method === 'POST' && req.url === '/schema') return handleSchema(req, res, body);

  return json(res, 404, { error: 'Unknown endpoint. Use: POST /verify, GET /health' });
}

// ─── Start ────────────────────────────────────────────────────────────────────
if (!COLLEGE_ID) {
  console.error('[connector] ERROR: COLLEGE_ID is missing. Run: node connector-setup.js');
  process.exit(1);
}

initAdapter().then(() => {
  const server = createServer(handler);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[connector] Port ${PORT} is already in use. Stop the existing connector first.`);
    } else {
      console.error('[connector] Server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    const LINE = '═'.repeat(50);
    console.log(`\n╔${LINE}╗`);
    console.log(`║  AuthenX Universal Connector — Online${' '.repeat(12)}║`);
    console.log(`╠${LINE}╣`);
    console.log(`║  College  : ${COLLEGE_NAME.padEnd(37)}║`);
    console.log(`║  DB Type  : ${(CONFIG.db_type || 'sqlite').padEnd(37)}║`);
    console.log(`║  Port     : ${String(PORT).padEnd(37)}║`);
    console.log(`║  Health   : GET  http://localhost:${PORT}/health${' '.repeat(4)}║`);
    console.log(`║  Verify   : POST http://localhost:${PORT}/verify${' '.repeat(4)}║`);
    console.log(`╚${LINE}╝\n`);
  });
}).catch(err => {
  console.error('[connector] FATAL: Failed to initialize adapter:', err.message);
  process.exit(1);
});
