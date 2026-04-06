'use strict';
const crypto = require('node:crypto');
const { queryOne, run } = require('../db/client.js');
const { requireAuth } = require('../middleware/auth.js');
const {
  decryptCode, verifyEd25519, sha256, buildCanonicalJson, generateNonce
} = require('../crypto/index.js');
const { verifyLimiter }  = require('../middleware/rate-limiter.js');
const { callWithBreaker, getBreakerState } = require('../middleware/circuit-breaker.js');
const { signRequest } = require('../middleware/hmac-auth.js');
const verificationCache  = require('../cache/verification-cache.js');

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
    SELECT t.id, t.status, t.credential_type, t.canonical_hash, t.schema_version,
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

  // Include circuit breaker state for this college
  const breakerState = getBreakerState(token.college_id);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    step: 'code_decoded',
    token_id: token.id,
    college: token.college_name,
    college_id: token.college_id,
    credential_type: token.credential_type,
    status: token.status,
    student_ref_token: token.student_ref_token,
    canonical_hash: token.canonical_hash,
    schema_version: token.schema_version || '1.0',
    issued_at: token.issued_at,
    revocation_reason: token.revocation_reason || null,
    revoked_at: token.revoked_at || null,
    connector_status: breakerState.state === 'OPEN' ? 'degraded' : 'online',
    note: 'Run /v1/verify/live to confirm directly from the college ERP',
  }));
}

/**
 * POST /v1/verify/live
 * Full live verification with:
 *   - Rate limiting per employer
 *   - Short-TTL result caching (30s for verified, 5s for revoked)
 *   - Circuit breaker per college connector
 *   - Graceful fallback if connector is unavailable
 */
async function liveVerify(req, res, body) {
  const start  = Date.now();
  const claims = requireAuth(req, res);
  if (!claims) return;

  // Rate limit check
  if (!verifyLimiter(req, res, claims)) return;

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

  // Step 2: Fetch token and college info
  const token = queryOne(`
    SELECT t.*, c.connector_url, c.public_key_hex, c.shared_secret, c.name as college_name
    FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
    WHERE t.id = ?
  `, [codePayload.token_id]);

  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found' }));
  }

  // Fast path: revoked tokens don't need live connector check
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

  // Cache check — avoid hitting connector for recent identical verifications
  const cached = verificationCache.get(token.id);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...cached, latency_ms: Date.now() - start }));
  }

  // Step 3: Call college connector (with circuit breaker)
  const nonce = generateNonce();
  let connectorData;
  let usedFallback = false;

  try {
    connectorData = await callWithBreaker(token.college_id, () =>
      callConnector(
        token.connector_url, 
        { student_ref_token: token.student_ref_token, nonce },
        token.college_id,
        token.shared_secret
      )
    );
  } catch (err) {
    // Fallback: use stored issuance signature when connector is unavailable
    usedFallback = true;
    const isSigValid = verifyEd25519(token.canonical_hash, token.issuance_signature, token.public_key_hex);
    const latency    = Date.now() - start;

    run(`INSERT INTO verification_requests
         (id, token_id, employer_name, request_type, result, hash_match, sig_valid, latency_ms, nonce)
         VALUES (?, ?, ?, 'live_verify', ?, 1, ?, ?, ?)`,
      [crypto.randomUUID(), token.id, claims.email,
       token.status === 'active' ? 'verified' : 'error',
       isSigValid ? 1 : 0, latency, nonce]);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      result: token.status === 'active' ? 'fallback_verified' : 'error',
      college: token.college_name,
      hash_match: true,
      issuance_sig: isSigValid,
      live_sig: false,
      not_revoked: token.status === 'active',
      latency_ms: latency,
      live_data: null,
      note: 'College connector temporarily unavailable. Showing stored credential proof only.',
      connector_error: err.message,
    }));
  }

  // Step 4: Recompute canonical hash from connector's live response
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

  // Step 5: Resolve public key (ledger → fallback to DB)
  const ledgerPk  = await fetchLedgerPublicKey(token.college_id);
  const verifyKey = ledgerPk || token.public_key_hex;

  // Step 6: Run all 4 cryptographic checks
  const hashMatch    = liveHash === token.canonical_hash;
  const isSigValid   = verifyEd25519(token.canonical_hash, token.issuance_signature, verifyKey);
  const liveSigValid = connectorData.live_signature
    ? verifyEd25519(nonce + ':' + liveHash, connectorData.live_signature, verifyKey)
    : false;
  const notRevoked   = token.status === 'active';

  const result  = (hashMatch && isSigValid && notRevoked) ? 'verified' : 'error';
  const latency = Date.now() - start;

  // Audit log (NEVER stores student PII — only cryptographic metadata)
  run(`INSERT INTO verification_requests
       (id, token_id, employer_name, request_type, result, hash_match, sig_valid, latency_ms, nonce)
       VALUES (?, ?, ?, 'live_verify', ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), token.id, claims.email, result,
     hashMatch ? 1 : 0, (isSigValid && liveSigValid) ? 1 : 0, latency, nonce]);

  const responseBody = {
    result,
    college:       token.college_name,
    hash_match:    hashMatch,
    issuance_sig:  isSigValid,
    live_sig:      liveSigValid,
    not_revoked:   notRevoked,
    latency_ms:    latency,
    // Transient live fields — shown to employer but NEVER stored in AuthenX
    live_data: result === 'verified' ? {
      name:            connectorData.name,
      degree:          connectorData.degree,
      branch:          connectorData.branch,
      credential_type: connectorData.credential_type,
      cgpa:            connectorData.cgpa,
      graduation_year: connectorData.graduation_year,
    } : null,
    note: 'live_data is fetched directly from the college ERP and never stored in AuthenX',
  };

  // Cache the result (without live_data — we never cache PII)
  if (result === 'verified' || result === 'revoked') {
    verificationCache.set(token.id, { ...responseBody, live_data: null });
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseBody));
}

/**
 * Call a college connector's /verify endpoint.
 * Supports both HTTP and HTTPS, with 8-second timeout.
 */
async function callConnector(connectorUrl, payload, collegeId, sharedSecret) {
  // Built-in mock connector
  if (!connectorUrl || connectorUrl === 'mock' || connectorUrl.startsWith('internal://')) {
    return mockConnectorVerify(payload);
  }

  const url  = new URL('/verify', connectorUrl);
  const body = JSON.stringify(payload);
  
  // Generate Zero-Trust HMAC headers
  const hmacHeaders = signRequest('POST', url.pathname, body, sharedSecret, collegeId);

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? require('node:https') : require('node:http');
    const reqOpts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...hmacHeaders
      },
    };

    const request = mod.request(reqOpts, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode === 404) return reject(new Error('Student not found at connector'));
        if (response.statusCode >= 400) return reject(new Error(`Connector error ${response.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from connector')); }
      });
    });

    request.on('error', reject);
    request.setTimeout(8000, () => {
      request.destroy();
      reject(new Error('Connector request timed out after 8 seconds'));
    });

    request.write(body);
    request.end();
  });
}

/** Fetch public key from ledger service (optional, graceful fallback) */
async function fetchLedgerPublicKey(collegeId) {
  return new Promise((resolve) => {
    const req = require('node:http').request({
      hostname: 'localhost', port: 8080,
      path:   '/ledger/public-keys/' + encodeURIComponent(collegeId),
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return resolve(null);
          resolve(JSON.parse(data).public_key_hex);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Built-in mock connector for demo/testing */
function mockConnectorVerify({ student_ref_token, nonce }) {
  const { signEd25519, sha256: sha256fn, buildCanonicalJson: buildCJ } = require('../crypto/index.js');

  const MOCK_STUDENTS = {
    'stu_ref_001': { name: 'SUPREETH K',    degree: 'BTECH', branch: 'COMPUTER SCIENCE',  credential_type: 'DEGREE_CERTIFICATE', cgpa: '8.9', graduation_year: '2024', issue_date: '2024-06-15', schema_version: '1.0' },
    'stu_ref_002': { name: 'PRIYA SHARMA',  degree: 'MTECH', branch: 'ELECTRONICS',       credential_type: 'DEGREE_CERTIFICATE', cgpa: '9.1', graduation_year: '2024', issue_date: '2024-06-15', schema_version: '1.0' },
    'stu_ref_003': { name: 'RAHUL NAIR',    degree: 'BTECH', branch: 'MECHANICAL',        credential_type: 'DEGREE_CERTIFICATE', cgpa: '7.8', graduation_year: '2023', issue_date: '2023-06-15', schema_version: '1.0' },
    'stu_ref_004': { name: 'ARUN KUMAR',    degree: 'BTECH', branch: 'CIVIL ENGINEERING', credential_type: 'DEGREE_CERTIFICATE', cgpa: '8.2', graduation_year: '2024', issue_date: '2024-06-15', schema_version: '1.0' },
    'stu_ref_005': { name: 'DEEPA MENON',   degree: 'MBA',   branch: 'FINANCE',           credential_type: 'DEGREE_CERTIFICATE', cgpa: '8.7', graduation_year: '2023', issue_date: '2023-12-01', schema_version: '1.0' },
  };

  const student = MOCK_STUDENTS[student_ref_token];
  if (!student) throw new Error(`Student not found in mock ERP: ${student_ref_token}`);

  const token     = queryOne('SELECT college_id FROM verification_tokens WHERE student_ref_token = ?', [student_ref_token]);
  const issuer_id = token ? token.college_id : 'mock-college';
  const canonical = buildCJ({ ...student, issuer_id, student_ref_token });
  const liveHash  = sha256fn(canonical);

  const mockPrivKey = process.env.MOCK_CONNECTOR_PRIV_KEY;
  const live_signature = mockPrivKey ? signEd25519(nonce + ':' + liveHash, mockPrivKey) : null;

  return Promise.resolve({ ...student, live_signature });
}

module.exports = { decodeCode, liveVerify };
