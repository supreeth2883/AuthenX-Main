'use strict';
const crypto = require('node:crypto');
const { query, queryOne, run, transaction } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
const {
  buildCanonicalJson, sha256, verifyEd25519, encryptCode
} = require('../crypto/index.js');
const verificationCache = require('../cache/verification-cache.js');
const { issueLimiter } = require('../middleware/rate-limiter.js');
const { sendJson, sendError } = require('../utils/json-response.js');
const { enforceCollegeAccess } = require('../utils/college-access.js');

/**
 * POST /v1/tokens/issue
 * Issues a verification token for a student.
 * The connector sends: credential fields + issuance_signature (Ed25519 over canonical hash)
 * AuthenX stores: hash + signature only — never raw student data
 */
async function issueToken(req, res, body) {
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
    return sendError(res, 400, `Missing fields: ${missing.join(', ')}`);
  }

  // Fetch college to get public key for signature verification
  const college = await queryOne('SELECT * FROM colleges WHERE id = $1 AND active = 1', [college_id]);
  if (!college) {
    return sendError(res, 404, 'College not found or inactive');
  }

  // college_admin can only issue for their own college
  if (!enforceCollegeAccess(claims, college_id, res)) return;

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
    return sendError(res, 422, 'Issuance signature verification failed', {
      hint: 'Ensure the college connector signed sha256(canonical_json) with the registered Ed25519 private key'
    });
  }

  // Check for duplicate
  const existing = await queryOne(
    'SELECT id, status FROM verification_tokens WHERE college_id = $1 AND student_ref_token = $2',
    [college_id, student_ref_token]
  );
  if (existing && existing.status === 'active') {
    return sendError(res, 409, 'Active token already exists for this student at this college');
  }

  // Store — privacy-first: hash + signature only, no raw student data
  let token_id;
  if (existing && existing.status === 'revoked') {
    token_id = existing.id;
    await run(`UPDATE verification_tokens SET
         canonical_hash = $1, issuance_signature = $2, schema_version = $3,
         credential_type = $4, status = 'active',
         revocation_reason = NULL, revoked_at = NULL,
         issued_at = NOW()
         WHERE id = $5`,
      [canonical_hash, issuance_signature, schema_version, credential_type, token_id]);
  } else {
    token_id = crypto.randomUUID();
    await run(`INSERT INTO verification_tokens
         (id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
      [token_id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type]);
  }

  // Generate AuthenX Code v2 (AES-256-GCM encrypted — only decodable by AuthenX)
  const { sha256: codeSha } = require('../crypto/index.js');
  const codePayload = {
    v: 2,
    token_id,
    college_id,
    student_ref_token,
    credential_type,
    issued_at: new Date().toISOString(),
    expires_at: null,
    checksum: codeSha(`${token_id}:${college_id}:${student_ref_token}:${credential_type}`),
  };
  const authenx_code = encryptCode(codePayload);

  // Persist the latest issued AuthenX code for this token.
  await run(
    `INSERT INTO issued_authenx_codes (token_id, authenx_code, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT(token_id) DO UPDATE SET
       authenx_code = EXCLUDED.authenx_code,
       updated_at = NOW()`,
    [token_id, authenx_code]
  );

  sendJson(res, 201, {
    message: 'Token issued successfully',
    token_id,
    canonical_hash,
    authenx_code,
    note: 'Share authenx_code with the student. AuthenX stores only the hash, never raw data.',
  });
}

/**
 * POST /v1/tokens/revoke
 * Revoke a token (college_admin or super_admin)
 */
async function revokeToken(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const { token_id, reason } = body;
  if (!token_id || !reason) {
    return sendError(res, 400, 'token_id and reason are required');
  }

  const token = await queryOne('SELECT * FROM verification_tokens WHERE id = $1', [token_id]);
  if (!token) {
    return sendError(res, 404, 'Token not found');
  }
  if (!enforceCollegeAccess(claims, token.college_id, res)) return;
  if (token.status === 'revoked') {
    return sendError(res, 409, 'Token is already revoked');
  }

  const now = new Date().toISOString();
  await transaction(async (db) => {
    await db.run(`UPDATE verification_tokens SET status='revoked', revocation_reason=$1, revoked_at=$2 WHERE id=$3`,
      [reason, now, token_id]);
    // Immediately invalidate cache so next verification reflects revocation
    verificationCache.invalidate(token_id);
    await db.run(`INSERT INTO revocation_events (id, token_id, reason, revoked_by) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), token_id, reason, claims.user_id]);
    await db.run(`INSERT INTO security_events (id, event_type, actor_id, actor_email, target_id, details)
         VALUES ($1, 'token_revoked', $2, $3, $4, $5)`,
      [crypto.randomUUID(), claims.user_id, claims.email, token_id, `Reason: ${reason}`]);
  });

  sendJson(res, 200, { message: 'Token revoked', token_id, revoked_at: now });
}

/** GET /v1/tokens/:id — token status */
async function getToken(req, res, id) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const token = await queryOne(`
    SELECT t.id, t.college_id, t.student_ref_token, t.canonical_hash,
           t.credential_type, t.status, t.revocation_reason, t.revoked_at, t.issued_at,
           c.name as college_name, c.short_code
    FROM verification_tokens t
    JOIN colleges c ON c.id = t.college_id
    WHERE t.id = $1
  `, [id]);

  if (!token) {
    return sendError(res, 404, 'Token not found');
  }

  sendJson(res, 200, { token });
}

/** GET /v1/tokens — list tokens (filtered by college for college_admin) */
async function listTokens(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  let rows;
  if (claims.role === 'super_admin') {
    rows = await query(`
      SELECT t.id, t.college_id, t.student_ref_token, t.credential_type,
             t.status, t.issued_at, c.name as college_name
      FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
      ORDER BY t.issued_at DESC LIMIT 100
    `);
  } else {
    rows = await query(`
      SELECT t.id, t.college_id, t.student_ref_token, t.credential_type,
             t.status, t.issued_at, c.name as college_name
      FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
      WHERE t.college_id = $1
      ORDER BY t.issued_at DESC LIMIT 100
    `, [claims.college_id]);
  }

  sendJson(res, 200, { tokens: rows, count: rows.length });
}

module.exports = { issueToken, revokeToken, getToken, listTokens };
