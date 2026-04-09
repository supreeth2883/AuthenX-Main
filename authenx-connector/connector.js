'use strict';
/**
 * AuthenX College Connector — SQLite Adapter
 * Simulates a college ERP connector running inside the college's network.
 *
 * - Receives:  { student_ref_token, nonce } from AuthenX
 * - Queries:   connector.db (SQLite, mirrors college's student records)
 * - Returns:   signed student data with Ed25519 live_signature
 *
 * Zero external dependencies — Node 22 built-ins only.
 */

const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { createHash, createPrivateKey, sign: cryptoSign } = require('node:crypto');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

// ─── Load .env ────────────────────────────────────────────────────────────────
function loadEnv(envPath) {
  if (!existsSync(envPath)) {
    console.error(`[connector] ERROR: .env not found at ${envPath}`);
    console.error('[connector] Run: node connector-setup.js');
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

const ENV_FILE_PATH = process.env.ENV_FILE || resolve(__dirname, '.env');
const ENV = loadEnv(ENV_FILE_PATH);
const COLLEGE_ID = ENV.COLLEGE_ID;
const COLLEGE_NAME = ENV.COLLEGE_NAME || 'IIT Bombay';
const PRIV_KEY_HEX = ENV.CONNECTOR_PRIVATE_KEY_HEX;
const PORT = parseInt(ENV.PORT || '9000', 10);
const DB_PATH = ENV.DB_PATH || resolve(__dirname, 'connector.db');
const SHARED_SECRET = ENV.SHARED_SECRET;

if (!COLLEGE_ID || !PRIV_KEY_HEX) {
  console.error('[connector] ERROR: COLLEGE_ID and CONNECTOR_PRIVATE_KEY_HEX are required in .env');
  console.error('[connector] Run: node connector-setup.js');
  process.exit(1);
}

if (!SHARED_SECRET) {
  console.error('[connector] WARNING: SHARED_SECRET not set in .env — HMAC auth will reject all requests');
}

// ─── Load field mapping config ────────────────────────────────────────────────
const configPath = ENV.CONFIG_PATH || process.env.CONFIG_PATH || resolve(__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

// ─── Ed25519 signing via HSM (multi-college) ──────────────────────────
// The connector proxies signing to the HSM. It sends the college_id
// so the HSM selects the correct private key for this college.

const HSM_PORT = parseInt(ENV.HSM_PORT || process.env.HSM_PORT || '9099', 10);

async function signEd25519(message) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({
      hostname: '127.0.0.1',
      port: HSM_PORT,
      path: '/sign',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          const sigHex = parsed.signature;
          if (!sigHex) {
            return reject(new Error(parsed.error || `HSM signing failed with status ${res.statusCode}`));
          }
          resolve(Buffer.from(sigHex, 'hex').toString('base64'));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ college_id: COLLEGE_ID, payload: message }));
    req.end();
  });
}

// ─── SHA-256 ──────────────────────────────────────────────────────────────────
function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ─── Canonical JSON (must match AuthenX server's buildCanonicalJson exactly) ──
function buildCanonicalJson(fields) {
  const ordered = {
    schema_version: String(fields.schema_version || '1.0').trim(),
    issuer_id: String(fields.issuer_id || '').trim(),
    student_ref_token: String(fields.student_ref_token || '').trim(),
    name: String(fields.name || '').trim().toUpperCase(),
    degree: String(fields.degree || '').trim().toUpperCase(),
    branch: String(fields.branch || '').trim().toUpperCase(),
    credential_type: String(fields.credential_type || '').trim().toUpperCase(),
    cgpa: String(fields.cgpa || '').trim(),
    graduation_year: String(fields.graduation_year || '').trim(),
    issue_date: String(fields.issue_date || '').trim(),
  };
  return JSON.stringify(ordered, null, 0);
}

// ─── Field mapping engine ──────────────────────────────────────────────────────
function applyFieldMapping(row) {
  const result = {};
  for (const [outputField, spec] of Object.entries(config.field_mapping)) {
    switch (spec.type) {
      case 'column':
        result[outputField] = row[spec.column] ?? null;
        break;
      case 'concat':
        result[outputField] = spec.columns
          .map(col => row[col] ?? '')
          .filter(Boolean)
          .join(spec.separator || ' ');
        break;
      case 'year_from_date': {
        const d = row[spec.column];
        result[outputField] = d ? new Date(d).getFullYear() : null;
        break;
      }
      case 'map_values': {
        const val = String(row[spec.column] || '').toLowerCase();
        result[outputField] = spec.active_values.map(v => v.toLowerCase()).includes(val)
          ? 'active'
          : spec.inactive_values.map(v => v.toLowerCase()).includes(val)
            ? 'inactive'
            : 'unknown';
        break;
      }
      case 'direct':
        result[outputField] = spec.value;
        break;
      default:
        result[outputField] = null;
    }
  }
  return result;
}

// ─── SQLite database ──────────────────────────────────────────────────────────
let _db = null;
function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  return _db;
}

// ─── Nonce replay prevention ──────────────────────────────────────────────────
const usedNonces = new Map(); // nonce → expiry timestamp
const NONCE_TTL = 60_000;   // 60 seconds

function checkNonce(nonce) {
  const now = Date.now();
  for (const [n, exp] of usedNonces) { if (exp < now) usedNonces.delete(n); }
  if (usedNonces.has(nonce)) return false; // already seen
  usedNonces.set(nonce, now + NONCE_TTL);
  return true;
}

// ─── Body reader ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    const MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB - connectors don't need large payloads

    req.on('data', (c) => {
      totalLength += c.length;
      if (totalLength > MAX_PAYLOAD_SIZE) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      try { resolve({ rawBody, parsed: rawBody ? JSON.parse(rawBody) : {} }); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ─── Request handler ──────────────────────────────────────────────────────────
async function handler(req, res) {
  // Generate request ID for tracing
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', requestId);

  res.setHeader('Content-Type', 'application/json');
  // Connector is internal service - restrict CORS to server-to-server calls only
  // Browser clients should never directly access connectors
  const allowedOrigin = process.env.AUTHENX_SERVER_ORIGIN || 'http://localhost:3000';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-AuthenX-Timestamp,X-AuthenX-Nonce,X-AuthenX-Signature,X-AuthenX-College-ID,X-Request-ID');

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: 'ok',
      college: COLLEGE_NAME,
      college_id: COLLEGE_ID,
      port: PORT,
      timestamp: new Date().toISOString(),
    }));
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method !== 'POST' || req.url !== '/verify') {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Use POST /verify' }));
  }

  // Parse body
  let rawBody, body;
  try { 
    const bodyRes = await readBody(req); 
    rawBody = bodyRes.rawBody;
    body = bodyRes.parsed;
  }
  catch (err) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }

  // Zero-Trust Mutual Auth: Verify HMAC signature from AuthenX server
  try {
    const timestamp = req.headers['x-authenx-timestamp'];
    const signature = req.headers['x-authenx-signature'];

    if (!timestamp || !signature) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Missing HMAC authentication headers' }));
    }

    if (!SHARED_SECRET) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: 'SHARED_SECRET not configured on connector' }));
    }

    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 60) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Timestamp drift too large (max 60s)' }));
    }

    const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
    const message = `POST:${req.url}:${timestamp}:${bodyHash}`;
    const expected = crypto.createHmac('sha256', Buffer.from(SHARED_SECRET, 'hex'))
      .update(message).digest('hex');

    let valid = false;
    try {
      valid = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch { /* length mismatch */ }

    if (!valid) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'HMAC signature mismatch' }));
    }
  } catch (hmacErr) {
    console.error('[connector] HMAC verification error:', hmacErr.message);
    res.writeHead(500);
    return res.end(JSON.stringify({ error: 'HMAC verification failed', detail: hmacErr.message }));
  }

  const { student_ref_token, nonce } = body;

  if (!student_ref_token || !nonce) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'student_ref_token and nonce are required' }));
  }

  // Replay prevention
  if (!checkNonce(nonce)) {
    res.writeHead(409);
    return res.end(JSON.stringify({ error: 'Nonce already used — replay attack detected' }));
  }

  // Query student DB
  const { table, ref_column } = config.db;
  let row;
  try {
    const stmt = getDb().prepare(`SELECT * FROM "${table}" WHERE "${ref_column}" = ? LIMIT 1`);
    row = stmt.get(student_ref_token);
  } catch (err) {
    console.error('[connector] DB error:', err.message);
    res.writeHead(500);
    return res.end(JSON.stringify({ error: 'Database error', detail: err.message }));
  }

  if (!row) {
    res.writeHead(404);
    return res.end(JSON.stringify({
      error: 'Student not found',
      student_ref_token,
      college: COLLEGE_NAME,
    }));
  }

  // Apply field mapping
  const mapped = applyFieldMapping(row);

  // Build canonical JSON — MUST match AuthenX server's buildCanonicalJson exactly
  const canonical = buildCanonicalJson({
    schema_version: '1.0',
    issuer_id: COLLEGE_ID,
    student_ref_token: student_ref_token,
    name: mapped.name,
    degree: mapped.degree,
    branch: mapped.branch,
    credential_type: mapped.credential_type || 'DEGREE_CERTIFICATE',
    cgpa: String(mapped.cgpa ?? ''),
    graduation_year: String(mapped.graduation_year ?? ''),
    issue_date: mapped.issue_date || '',
  });

  const liveHash = sha256(canonical);

  // Sign: nonce + ':' + liveHash  (for live verification — server checks this at /verify/live)
  const live_signature = await signEd25519(`${nonce}:${liveHash}`);

  // Sign: canonical_hash alone  (for issuance — server checks this at /tokens/issue)
  const issuance_signature = await signEd25519(liveHash);

  const response = {
    college_id: COLLEGE_ID,
    college_name: COLLEGE_NAME,
    student_ref_token,
    nonce,
    schema_version: '1.0',
    name: mapped.name,
    degree: mapped.degree,
    branch: mapped.branch,
    credential_type: mapped.credential_type || 'DEGREE_CERTIFICATE',
    cgpa: String(mapped.cgpa ?? ''),
    graduation_year: String(mapped.graduation_year ?? ''),
    issue_date: mapped.issue_date || '',
    status: mapped.status || 'unknown',
    live_signature,
    issuance_signature,
    signed_at: new Date().toISOString(),
  };

  console.log(`[connector] ✓ ${new Date().toISOString()} | ${student_ref_token} → ${mapped.name} | status: ${mapped.status}`);

  res.writeHead(200);
  res.end(JSON.stringify(response));
}

// ─── Start ────────────────────────────────────────────────────────────────────
const server = createServer(handler);
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       AuthenX Connector — Online            ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  College  : ${COLLEGE_NAME.padEnd(32)}║`);
  console.log(`║  Port     : ${String(PORT).padEnd(32)}║`);
  console.log(`║  DB       : ${DB_PATH.split('/').pop().padEnd(32)}║`);
  console.log(`║  Health   : GET  http://localhost:${PORT}/health  ║`);
  console.log(`║  Verify   : POST http://localhost:${PORT}/verify ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[connector] ERROR: Port ${PORT} already in use. Kill existing connector first.`);
  } else {
    console.error('[connector] Server error:', err.message);
  }
  process.exit(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[connector] ${signal} received - shutting down ${COLLEGE_NAME}...`);

  server.close(() => {
    console.log(`[connector] ${COLLEGE_NAME} shutdown complete`);
    process.exit(0);
  });

  // Force close after 5 seconds
  setTimeout(() => {
    console.error(`[connector] Forced shutdown after 5s timeout`);
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

