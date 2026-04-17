'use strict';
const crypto = require('node:crypto');
const { queryOne, query, run, transaction } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');

/**
 * GET /v1/tokens/:id/details
 * Returns extended token info including verification stats.
 */
async function getTokenDetails(req, res, tokenId) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const token = await queryOne(`
    SELECT t.id, t.college_id, t.student_ref_token, t.canonical_hash,
           t.issuance_signature, t.schema_version, t.credential_type,
           t.status, t.revocation_reason, t.revoked_at, t.issued_at,
           t.superseded_by, t.correction_token_id, t.verification_count,
           t.last_verified_at, t.last_result,
           c.name as college_name, c.short_code
    FROM verification_tokens t
    JOIN colleges c ON c.id = t.college_id
    WHERE t.id = $1
  `, [tokenId]);

  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found' }));
  }

  if (claims.role === 'college_admin' && claims.college_id !== token.college_id) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Access denied' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token }));
}

/**
 * POST /v1/tokens/correct
 * Creates a correction token: marks old token as 'superseded', issues a replacement.
 * Body: { token_id, reason }
 */
async function correctToken(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const { token_id, reason } = body;
  if (!token_id || !reason) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'token_id and reason are required' }));
  }

  const original = await queryOne(`
    SELECT * FROM verification_tokens WHERE id = $1
  `, [token_id]);

  if (!original) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Token not found' }));
  }

  if (claims.role === 'college_admin' && claims.college_id !== original.college_id) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Access denied' }));
  }

  if (original.status !== 'active') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Token is ${original.status} — only active tokens can be corrected` }));
  }

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await transaction(async (db) => {
      // Mark old as superseded
      await db.run(`
        UPDATE verification_tokens
        SET status = 'superseded', superseded_by = $1, revocation_reason = $2, revoked_at = $3
        WHERE id = $4
      `, [newId, reason, now, token_id]);

      // Insert new token as a copy with 'corrected' marker pointing back
      await db.run(`
        INSERT INTO verification_tokens
          (id, college_id, student_ref_token, canonical_hash, issuance_signature,
           schema_version, credential_type, status, correction_token_id, issued_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
      `, [
        newId, original.college_id, original.student_ref_token,
        original.canonical_hash, original.issuance_signature,
        original.schema_version, original.credential_type,
        token_id, now
      ]);
    });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Correction failed', detail: err.message }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Correction token created',
    original_token_id: token_id,
    new_token_id: newId,
    reason
  }));
}

module.exports = { getTokenDetails, correctToken };
