'use strict';
const crypto = require('node:crypto');
const { query, queryOne, run, transaction } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
const {
  buildCanonicalJson, sha256, verifyEd25519, encryptCode
} = require('../crypto/index.js');

/**
 * POST /v1/tokens/issue
 * Issues a verification token for a student.
 * The connector sends: credential fields + issuance_signature (Ed25519 over canonical hash)
 * AuthenX stores: hash + signature only — never raw student data
 */
function issueToken(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const {
    college_id, student_ref_token, credential_type,
    name, degree, branch, cgpa, graduation_year, issue_date,
    issuance_signature, schema_version = '1.0'
  } = body;

  // Validate required fields
  const required = { college_id, student_ref_token, credential_type, name, degree, branch, issuance_signature };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Missing fields: ${missing.join(', ')}` }));
  }

  // Fetch college to get public key for signature verification
  const college = queryOne('SELECT * FROM colleges WHERE id = ? AND active = 1', [college_id]);
  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found or inactive' }));
  }

  // college_admin can only issue for their own college
  if (claims.role === 'college_admin' && claims.college_id !== college_id) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Cannot issue tokens for another college' }));
  }

  // Build canonical JSON and hash
  const canonicalFields = {
    schema_version, issuer_id: college_id, student_ref_token,
    name, degree, branch, credential_type, cgpa: cgpa || '', graduation_year: graduation_year || '',
    issue_date: issue_date || new Date().toISOString().split('T')[0],
  };
  const canonical = buildCanonicalJson(canonicalFields);
  const canonical_hash = sha256(canonical);

  // Verify Ed25519 signature from college connector
  const sigValid = verifyEd25519(canonical_hash, issuance_signature, college.public_key_hex);
  if (!sigValid) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Issuance signature verification failed',
      hint: 'Ensure the college connector signed sha256(canonical_json) with the registered Ed25519 private key'
    }));
  }

  // Check for duplicate
  const existing = queryOne(
    'SELECT id, status FROM verification_tokens WHERE college_id = ? AND student_ref_token = ?',
    [college_id, student_ref_token]
  );
  if (existing && existing.status === 'active') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Active token already exists for this student at this college' }));
  }

  // Store — privacy-first: hash + signature only, no raw student data
  // If a revoked token exists, UPDATE it in place (preserves FK from verification_requests)
  // Otherwise INSERT a new row.
  let token_id;
  if (existing && existing.status === 'revoked') {
    token_id = existing.id;
    run(
      `UPDATE verification_tokens SET
         canonical_hash = ?, issuance_signature = ?, schema_version = ?,
         credential_type = ?, status = 'active',
         revocation_reason = NULL, revoked_at = NULL,
         issued_at = datetime('now')
       WHERE id = ?`,
      [canonical_hash, issuance_signature, schema_version, credential_type, token_id]
    );
  } else {
    token_id = crypto.randomUUID();
    run(
      `INSERT INTO verification_tokens
         (id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [token_id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type]
    );
  }

  // Generate AuthenX Code (AES-256-GCM encrypted — only decodable by AuthenX)
  const codePayload = {
    v: 1,
    token_id,
    college_id,
    student_ref_token,
    credential_type,
    issued_at: new Date().toISOString(),
  };
  const authenx_code = encryptCode(codePayload);

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Token issued successfully',
    token_id,
    canonical_hash,
    authenx_code,
    note: 'Share authenx_code with the student. AuthenX stores only the hash, never raw data.',
  }));
}

/**
 * POST /v1/tokens/revoke
 * Revoke a token (college_admin or super_admin)
 */
function revokeToken(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const { token_id, reason } = body;
  if (!token_id || !reason) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'token_id and reason are required' }));
  }

  const token = queryOne('SELECT * FROM verification_tokens WHERE id = ?', [token_id]);
  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found' }));
  }
  if (claims.role === 'college_admin' && claims.college_id !== token.college_id) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Cannot revoke tokens from another college' }));
  }
  if (token.status === 'revoked') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token is already revoked' }));
  }

  const now = new Date().toISOString();
  transaction(() => {
    run(`UPDATE verification_tokens SET status='revoked', revocation_reason=?, revoked_at=? WHERE id=?`,
      [reason, now, token_id]);
    run(`INSERT INTO revocation_events (id, token_id, reason, revoked_by) VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), token_id, reason, claims.user_id]);
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Token revoked', token_id, revoked_at: now }));
}

/** GET /v1/tokens/:id — token status */
function getToken(req, res, id) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const token = queryOne(`
    SELECT t.id, t.college_id, t.student_ref_token, t.canonical_hash,
           t.credential_type, t.status, t.revocation_reason, t.revoked_at, t.issued_at,
           c.name as college_name, c.short_code
    FROM verification_tokens t
    JOIN colleges c ON c.id = t.college_id
    WHERE t.id = ?
  `, [id]);

  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token }));
}

/** GET /v1/tokens — list tokens (filtered by college for college_admin) */
function listTokens(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  let rows;
  if (claims.role === 'super_admin') {
    rows = query(`
      SELECT t.id, t.college_id, t.student_ref_token, t.credential_type,
             t.status, t.issued_at, c.name as college_name
      FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
      ORDER BY t.issued_at DESC LIMIT 100
    `);
  } else {
    rows = query(`
      SELECT t.id, t.college_id, t.student_ref_token, t.credential_type,
             t.status, t.issued_at, c.name as college_name
      FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
      WHERE t.college_id = ?
      ORDER BY t.issued_at DESC LIMIT 100
    `, [claims.college_id]);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tokens: rows, count: rows.length }));
}

module.exports = { issueToken, revokeToken, getToken, listTokens };
