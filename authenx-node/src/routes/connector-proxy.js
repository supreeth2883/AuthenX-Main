'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const crypto = require('node:crypto');
const { queryOne, run } = require('../db/client.js');
const { requireAuth } = require('../middleware/auth.js');
const { signRequest } = require('../middleware/hmac-auth.js');
const cvrErp = require('../mock-erp/cvr-erp.js');
const { CVR_SHORT_CODE } = cvrErp;

function getCollegeConnector(claims) {
  if (!claims?.college_id) return null;
  return queryOne(
    'SELECT id, name, short_code, connector_url, shared_secret FROM colleges WHERE id = ? AND active = 1',
    [claims.college_id]
  );
}

function requestJson(method, urlString, bodyString, extraHeaders = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const headers = {
      'Accept': 'application/json',
      ...extraHeaders,
    };
    if (bodyString != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    const req = mod.request({
      method,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        resolve({ status: res.statusCode || 0, json: parsed, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (bodyString != null) req.write(bodyString);
    req.end();
  });
}

/**
 * GET /v1/connector/health
 * Server-side proxy to college connector /health.
 */
async function connectorHealth(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = getCollegeConnector(claims);
  if (!college) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No college in session' }));
  }

  const connectorUrl = college.connector_url;
  if (!connectorUrl || connectorUrl === 'mock' || connectorUrl.startsWith('internal://')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'mock',
      college: college.name,
      college_id: college.id,
      connector_url: connectorUrl || null,
    }));
  }

  try {
    const start = Date.now();
    const r = await requestJson('GET', new URL('/health', connectorUrl).toString(), null, {}, 3000);
    const latency_ms = Date.now() - start;
    if (r.status >= 200 && r.status < 300) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...r.json, connector_url: connectorUrl, latency_ms }));
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector returned non-200', status: r.status, connector_url: connectorUrl }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector unreachable', detail: err.message, connector_url: connectorUrl }));
  }
}

/**
 * POST /v1/connector/verify
 * Body: { student_ref_token, nonce }
 * Server-side proxy to connector /verify with HMAC headers.
 * Falls back to the PostgreSQL mock ERP for CVR when the external connector
 * is absent (mock mode) or unreachable (network error).
 */
async function connectorVerify(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = getCollegeConnector(claims);
  if (!college) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No college in session' }));
  }

  const { student_ref_token, nonce } = body || {};
  if (!student_ref_token || !nonce) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'student_ref_token and nonce are required' }));
  }

  const connectorUrl = college.connector_url;
  const isMockMode = !connectorUrl || connectorUrl === 'mock' || connectorUrl.startsWith('internal://');

  // ── Mock ERP path (no external connector configured) ─────────────────────
  // Only CVR has a local PostgreSQL mock dataset; other colleges get a clear 503.
  if (isMockMode) {
    if (college.short_code === CVR_SHORT_CODE) {
      return serveMockErp(res, college, student_ref_token);
    }
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'No connector configured for this college',
      college_id: college.id,
    }));
  }

  if (!college.shared_secret) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College shared_secret missing in DB' }));
  }

  const payload = { student_ref_token: String(student_ref_token), nonce: String(nonce) };
  const rawBody = JSON.stringify(payload);
  const headers = signRequest('POST', '/verify', rawBody, college.shared_secret, college.id);

  try {
    const start = Date.now();
    const r = await requestJson('POST', new URL('/verify', connectorUrl).toString(), rawBody, headers, 5000);
    const latency_ms = Date.now() - start;
    if (r.status >= 200 && r.status < 300) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...r.json, connector_latency_ms: latency_ms }));
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Connector verify failed',
      status: r.status,
      connector_url: connectorUrl,
      detail: r.json?.error || r.raw || null,
    }));
  } catch (err) {
    console.warn(`[connector-proxy] ${college.id} connector unreachable (${err.message})`);
    // Fall back to PostgreSQL mock ERP for CVR only.
    if (college.short_code === CVR_SHORT_CODE) {
      return serveMockErp(res, college, student_ref_token);
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector verify unreachable', detail: err.message, connector_url: connectorUrl }));
  }
}

/**
 * Serve student data from the CVR PostgreSQL mock ERP.
 * Returns fields compatible with the issue page:
 *   student_ref_token, name, degree, branch, credential_type,
 *   cgpa, graduation_year, issue_date, status, source.
 */
async function serveMockErp(res, college, student_ref_token) {
  try {
    const student = await cvrErp.lookupStudent(String(student_ref_token));
    if (!student) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: `Student not found in mock ERP: ${student_ref_token}`,
        student_ref_token,
      }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...student, college_name: college.name || student.college_name }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Mock ERP lookup failed', detail: err.message }));
  }
}

/**
 * POST /v1/connector/rotate-key
 * Rotate the college's Ed25519 signing key pair in the HSM.
 * Updates both `colleges.public_key_hex` and `college_keys.public_key_hex`
 * so new credentials are signed with the fresh key.
 * Existing verified tokens remain verifiable (HSM keeps historical keys).
 */
async function rotateKey(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = getCollegeConnector(claims);
  if (!college) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No college in session' }));
  }

  const hsmPort = parseInt(process.env.HSM_PORT || '9099', 10);
  const reqBody = JSON.stringify({ college_id: college.id });

  let hsmResult;
  try {
    hsmResult = await requestJson(
      'POST',
      `http://127.0.0.1:${hsmPort}/rotate-key`,
      reqBody,
      { 'Content-Length': String(Buffer.byteLength(reqBody)) },
      8000
    );
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'HSM unreachable', detail: err.message }));
  }

  if (hsmResult.status !== 200 || !hsmResult.json?.public_key_hex) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'HSM key rotation failed',
      detail: hsmResult.json?.error || `HTTP ${hsmResult.status}`,
    }));
  }

  const { public_key_hex, version } = hsmResult.json;

  // Persist new public key in both tables
  run('UPDATE colleges SET public_key_hex = ? WHERE id = ?', [public_key_hex, college.id]);
  run('UPDATE college_keys SET public_key_hex = ? WHERE college_id = ?', [public_key_hex, college.id]);

  // Immutable audit trail
  run(
    `INSERT INTO security_events (id, event_type, actor_id, actor_email, target_id, ip_address, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      'key_rotated',
      claims.sub || null,
      claims.email || null,
      college.id,
      req.socket?.remoteAddress || null,
      JSON.stringify({ college_id: college.id, version: version || null }),
    ]
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ success: true, public_key_hex, version: version || null }));
}

module.exports = { connectorHealth, connectorVerify, rotateKey };
