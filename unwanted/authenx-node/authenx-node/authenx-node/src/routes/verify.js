'use strict';
const crypto = require('node:crypto');
const { createHash, createHmac } = require('node:crypto');
const { queryOne, run } = require('../db/client.js');
const { requireAuth } = require('../middleware/auth.js');
const {
  decryptCode, verifyEd25519, sha256, buildCanonicalJson, generateNonce
} = require('../crypto/index.js');

/**
 * POST /v1/verify/code
 * Employer pastes an AuthenX Code — we decrypt and return token metadata.
 * Does NOT hit the college ERP — just decrypts the code and returns status.
 */
function decodeCode(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { authenx_code } = body;
  if (!authenx_code) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'authenx_code is required' }));
  }

  let payload;
  try {
    payload = decryptCode(authenx_code);
  } catch (err) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid or tampered AuthenX Code', detail: err.message }));
  }

  const token = queryOne(`
    SELECT t.id, t.status, t.credential_type, t.canonical_hash,
           t.student_ref_token, t.issued_at, t.revocation_reason, t.revoked_at,
           c.name as college_name, c.short_code, c.id as college_id
    FROM verification_tokens t
    JOIN colleges c ON c.id = t.college_id
    WHERE t.id = ?
  `, [payload.token_id]);

  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found in AuthenX registry' }));
  }

  // Log the decode event
  run(`INSERT INTO verification_requests
       (id, token_id, employer_name, request_type, result, hash_match, sig_valid)
       VALUES (?, ?, ?, 'code_decode', ?, 1, 1)`,
    [crypto.randomUUID(), token.id,
     claims.email || 'unknown',
     token.status === 'active' ? 'verified' : 'revoked']);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    step: 'code_decoded',
    token_id: token.id,
    college: { name: token.college_name, short_code: token.short_code },
    credential_type: token.credential_type,
    student_ref_token: token.student_ref_token,
    canonical_hash: token.canonical_hash,
    schema_version: '1.0',
    status: token.status,
    issued_at: token.issued_at,
    revoked_at: token.revoked_at || null,
    revocation_reason: token.revocation_reason || null,
    note: 'Run /v1/verify/live to confirm directly from the college ERP',
  }));
}

/**
 * POST /v1/verify/live
 * Full live verification:
 *   1. Decode AuthenX Code → get token_id
 *   2. Fetch token from DB → get college connector URL + public key
 *   3. Call connector /verify with nonce + student_ref_token
 *   4. Connector returns: credential fields + live signature
 *   5. We recompute canonical hash, verify both signatures
 *   6. Return result with live fields (transient — not stored)
 */
async function liveVerify(req, res, body) {
  const start = Date.now();
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { authenx_code } = body;
  if (!authenx_code) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'authenx_code is required' }));
  }

  // Step 1: Decode code
  let codePayload;
  try {
    codePayload = decryptCode(authenx_code);
  } catch (err) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid AuthenX Code' }));
  }

  // Step 2: Fetch token and college
  const token = queryOne(`
    SELECT t.*, c.connector_url, c.public_key_hex, c.shared_secret, c.name as college_name
    FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
    WHERE t.id = ?
  `, [codePayload.token_id]);

  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found' }));
  }

  if (token.status === 'revoked') {
    const latency = Date.now() - start;
    run(`INSERT INTO verification_requests
         (id, token_id, employer_name, request_type, result, latency_ms)
         VALUES (?, ?, ?, 'live_verify', 'revoked', ?)`,
      [crypto.randomUUID(), token.id, claims.email, latency]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      result: 'revoked',
      college: token.college_name,
      reason: token.revocation_reason,
      revoked_at: token.revoked_at,
      latency_ms: latency,
    }));
  }

  // Step 3: Call college connector
  const nonce = generateNonce();
  let connectorData;
  try {
    connectorData = await callConnector(token.connector_url, {
      student_ref_token: token.student_ref_token,
      nonce,
      shared_secret: token.shared_secret,
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'College connector unreachable',
      college: token.college_name,
      detail: err.message,
    }));
  }

  // Step 4: Recompute canonical hash from connector's live data
  const liveCanonical = buildCanonicalJson({
    schema_version:    connectorData.schema_version || '1.0',
    issuer_id:         token.college_id,
    student_ref_token: token.student_ref_token,
    name:              connectorData.name,
    degree:            connectorData.degree,
    branch:            connectorData.branch,
    credential_type:   connectorData.credential_type,
    cgpa:              connectorData.cgpa || '',
    graduation_year:   connectorData.graduation_year || '',
    issue_date:        connectorData.issue_date || '',
  });
  const liveHash = sha256(liveCanonical);

  // Step 5: Verify both signatures
  const hashMatch   = liveHash === token.canonical_hash;
  const isSigValid  = verifyEd25519(token.canonical_hash, token.issuance_signature, token.public_key_hex);
  const liveSigValid = connectorData.live_signature
    ? verifyEd25519(nonce + ':' + liveHash, connectorData.live_signature, token.public_key_hex)
    : false;

  const result = (hashMatch && isSigValid) ? 'verified' : 'error';
  const latency = Date.now() - start;

  // Log (never store raw credential fields)
  run(`INSERT INTO verification_requests
       (id, token_id, employer_name, request_type, result, hash_match, sig_valid, latency_ms, nonce)
       VALUES (?, ?, ?, 'live_verify', ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), token.id, claims.email, result,
     hashMatch ? 1 : 0, (isSigValid && liveSigValid) ? 1 : 0, latency, nonce]);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    result,
    college: token.college_name,
    hash_match:     hashMatch,
    issuance_sig:   isSigValid,
    live_sig:       liveSigValid,
    latency_ms:     latency,
    not_revoked:    token.status === 'active',
    // Transient live fields — shown to employer but never stored in AuthenX
    live_data: result === 'verified' ? {
      name:            connectorData.name,
      degree:          connectorData.degree,
      branch:          connectorData.branch,
      credential_type: connectorData.credential_type,
      cgpa:            connectorData.cgpa,
      graduation_year: connectorData.graduation_year,
      issue_date:      connectorData.issue_date || null,
    } : null,
    note: 'live_data is fetched directly from the college ERP and never stored in AuthenX',
  }));
}

/**
 * Call a college connector's /verify endpoint.
 * In production this is an HTTPS call to the college's connector service.
 * Here we support both real HTTP connectors and the built-in mock connector.
 */
async function callConnector(connectorUrl, payload) {
  // Mock connector — used when connector_url is 'mock' or 'internal://mock'
  if (!connectorUrl || connectorUrl === 'mock' || connectorUrl.startsWith('internal://')) {
    return mockConnectorVerify(payload);
  }

  // Real HTTP connector call
  const url = new URL('/verify', connectorUrl);
  const { shared_secret, ...connectorPayload } = payload;
  const body = JSON.stringify(connectorPayload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `POST:${url.pathname}:${timestamp}:${bodyHash}`;
  const signature = shared_secret
    ? createHmac('sha256', Buffer.from(shared_secret, 'hex')).update(message).digest('hex')
    : '';

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? require('node:https') : require('node:http');
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AuthenX-Timestamp': timestamp,
        'X-AuthenX-Signature': signature,
      },
    };
    const request = mod.request(reqOpts, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { return reject(new Error('Invalid JSON from connector')); }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(parsed.error || `Connector HTTP ${response.statusCode}`));
        }

        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => { request.destroy(); reject(new Error('Connector timeout')); });
    request.write(body);
    request.end();
  });
}

/**
 * Built-in mock connector — simulates a college ERP
 * Returns signed live data for known test students
 */
function mockConnectorVerify({ student_ref_token, nonce }) {
  const { signEd25519, sha256, buildCanonicalJson } = require('../crypto/index.js');
  const { queryOne } = require('../db/client.js');

  const MOCK_STUDENTS = {
    'stu_ref_001': {
      name: 'SUPREETH K', degree: 'BTECH', branch: 'COMPUTER SCIENCE',
      credential_type: 'DEGREE_CERTIFICATE', cgpa: '8.9',
      graduation_year: '2024', issue_date: '2024-06-15', schema_version: '1.0',
    },
    'stu_ref_002': {
      name: 'PRIYA SHARMA', degree: 'MTECH', branch: 'ELECTRONICS',
      credential_type: 'DEGREE_CERTIFICATE', cgpa: '9.1',
      graduation_year: '2024', issue_date: '2024-06-15', schema_version: '1.0',
    },
    'stu_ref_003': {
      name: 'RAHUL NAIR', degree: 'BTECH', branch: 'MECHANICAL',
      credential_type: 'DEGREE_CERTIFICATE', cgpa: '7.8',
      graduation_year: '2023', issue_date: '2023-06-15', schema_version: '1.0',
    },
  };

  const student = MOCK_STUDENTS[student_ref_token];
  if (!student) throw new Error(`Student not found in mock ERP: ${student_ref_token}`);

  // Mock connector needs college_id to build canonical — look it up from token table
  const token = queryOne('SELECT college_id FROM verification_tokens WHERE student_ref_token = ?', [student_ref_token]);
  const issuer_id = token ? token.college_id : 'mock-college';

  const canonical = buildCanonicalJson({ ...student, issuer_id, student_ref_token });
  const liveHash  = sha256(canonical);

  // Mock connector private key — stored in colleges.shared_secret in real life
  // For mock, we derive a stable key from the secret for signing
  // In production, each college connector has its own Ed25519 key pair
  // Here we sign with the same key that was registered during seed
  const mockPrivKey = process.env.MOCK_CONNECTOR_PRIV_KEY;
  const live_signature = mockPrivKey
    ? signEd25519(nonce + ':' + liveHash, mockPrivKey)
    : null;

  return Promise.resolve({ ...student, live_signature });
}

module.exports = { decodeCode, liveVerify };
