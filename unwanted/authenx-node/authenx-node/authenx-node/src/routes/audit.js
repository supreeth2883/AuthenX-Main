'use strict';
const { query } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');

/** GET /v1/audit — immutable audit log of all verification events */
function getAuditLog(req, res, urlObj) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const limit  = parseInt(urlObj.searchParams.get('limit')  || '50', 10);
  const offset = parseInt(urlObj.searchParams.get('offset') || '0',  10);

  let rows, totalRow;
  if (claims.role === 'super_admin') {
    rows = query(`
      SELECT r.id, r.request_type, r.result, r.hash_match, r.sig_valid,
             r.latency_ms, r.employer_name, r.created_at,
             t.credential_type, t.student_ref_token,
             c.name as college_name, c.short_code
      FROM verification_requests r
      JOIN verification_tokens t ON t.id = r.token_id
      JOIN colleges c ON c.id = t.college_id
      ORDER BY r.created_at DESC LIMIT ? OFFSET ?
    `, [limit, offset]);
    totalRow = query('SELECT COUNT(*) as cnt FROM verification_requests')[0];
  } else {
    rows = query(`
      SELECT r.id, r.request_type, r.result, r.hash_match, r.sig_valid,
             r.latency_ms, r.employer_name, r.created_at,
             t.credential_type, t.student_ref_token,
             c.name as college_name, c.short_code
      FROM verification_requests r
      JOIN verification_tokens t ON t.id = r.token_id
      JOIN colleges c ON c.id = t.college_id
      WHERE t.college_id = ?
      ORDER BY r.created_at DESC LIMIT ? OFFSET ?
    `, [claims.college_id, limit, offset]);
    totalRow = query(
      'SELECT COUNT(*) as cnt FROM verification_requests r JOIN verification_tokens t ON t.id = r.token_id WHERE t.college_id = ?',
      [claims.college_id]
    )[0];
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    events:  rows,
    count:   rows.length,
    total:   totalRow ? totalRow.cnt : 0,
    limit,
    offset,
  }));
}

/** GET /v1/audit/stats — dashboard summary counts */
function getStats(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const stats = {
    colleges:      query('SELECT COUNT(*) as cnt FROM colleges WHERE active=1')[0].cnt,
    tokens_active: query("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active'")[0].cnt,
    tokens_revoked:query("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='revoked'")[0].cnt,
    verifications: query("SELECT COUNT(*) as cnt FROM verification_requests WHERE request_type='live_verify'")[0].cnt,
    verifications_today: query(`
      SELECT COUNT(*) as cnt FROM verification_requests
      WHERE request_type='live_verify' AND date(created_at) = date('now')
    `)[0].cnt,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ stats }));
}

module.exports = { getAuditLog, getStats };
