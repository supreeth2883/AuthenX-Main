'use strict';
const { query } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
const { sendJson } = require('../utils/json-response.js');
const { parsePagination } = require('../utils/pagination.js');

/** GET /v1/audit — immutable audit log of all verification events */
async function getAuditLog(req, res, urlObj) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const { limit, offset } = parsePagination(urlObj);

  let rows, totalRow;
  if (claims.role === 'super_admin') {
    rows = await query(`
      SELECT r.id, r.request_type, r.result, r.hash_match, r.sig_valid,
             r.latency_ms, r.employer_name, r.created_at,
             t.credential_type, t.student_ref_token,
             c.name as college_name, c.short_code
      FROM verification_requests r
      JOIN verification_tokens t ON t.id = r.token_id
      JOIN colleges c ON c.id = t.college_id
      ORDER BY r.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const totals = await query('SELECT COUNT(*) as cnt FROM verification_requests');
    totalRow = totals[0];
  } else {
    rows = await query(`
      SELECT r.id, r.request_type, r.result, r.hash_match, r.sig_valid,
             r.latency_ms, r.employer_name, r.created_at,
             t.credential_type, t.student_ref_token,
             c.name as college_name, c.short_code
      FROM verification_requests r
      JOIN verification_tokens t ON t.id = r.token_id
      JOIN colleges c ON c.id = t.college_id
      WHERE t.college_id = $1
      ORDER BY r.created_at DESC LIMIT $2 OFFSET $3
    `, [claims.college_id, limit, offset]);
    const totals = await query(
      'SELECT COUNT(*) as cnt FROM verification_requests r JOIN verification_tokens t ON t.id = r.token_id WHERE t.college_id = $1',
      [claims.college_id]
    );
    totalRow = totals[0];
  }

  sendJson(res, 200, {
    events:  rows,
    count:   rows.length,
    total:   totalRow ? Number(totalRow.cnt) : 0,
    limit,
    offset,
  });
}

/** GET /v1/audit/stats — dashboard summary counts */
async function getStats(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const [col, act, rev, ver, tod] = await Promise.all([
    query('SELECT COUNT(*) as cnt FROM colleges WHERE active=1'),
    query("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active'"),
    query("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='revoked'"),
    query("SELECT COUNT(*) as cnt FROM verification_requests WHERE request_type='live_verify'"),
    query(`SELECT COUNT(*) as cnt FROM verification_requests WHERE request_type='live_verify' AND created_at::date = CURRENT_DATE`),
  ]);

  const stats = {
    colleges:            Number(col[0].cnt),
    tokens_active:       Number(act[0].cnt),
    tokens_revoked:      Number(rev[0].cnt),
    verifications:       Number(ver[0].cnt),
    verifications_today: Number(tod[0].cnt),
  };

  sendJson(res, 200, { stats });
}

/**
 * GET /v1/audit/export?format=csv|json&from=&to=
 * Exports audit log as CSV or JSON for compliance.
 */
async function exportAuditLog(req, res, urlObj) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const format = urlObj.searchParams.get('format') || 'json';
  const from   = urlObj.searchParams.get('from') || null;
  const to     = urlObj.searchParams.get('to')   || null;

  let whereExtra = '';
  const params = [];
  let paramIdx = 1;

  if (claims.role === 'college_admin') {
    whereExtra += ` AND t.college_id = $${paramIdx++}`;
    params.push(claims.college_id);
  }
  if (from) { whereExtra += ` AND r.created_at >= $${paramIdx++}`; params.push(from); }
  if (to)   { whereExtra += ` AND r.created_at <= $${paramIdx++}`; params.push(to + 'T23:59:59'); }

  const rows = await query(`
    SELECT r.id, r.request_type, r.result, r.hash_match, r.sig_valid,
           r.latency_ms, r.employer_name, r.created_at,
           t.id as token_id, t.credential_type, t.student_ref_token,
           c.name as college_name, c.short_code
    FROM verification_requests r
    JOIN verification_tokens t ON t.id = r.token_id
    JOIN colleges c ON c.id = t.college_id
    WHERE 1=1 ${whereExtra}
    ORDER BY r.created_at DESC
    LIMIT 10000
  `, params);

  if (format === 'csv') {
    const headers = ['id','request_type','result','hash_match','sig_valid','latency_ms',
                     'employer_name','created_at','token_id','credential_type',
                     'student_ref_token','college_name','short_code'];
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))
    ].join('\n');

    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="authenx-audit-${Date.now()}.csv"`
    });
    return res.end(csv);
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="authenx-audit-${Date.now()}.json"`
  });
  res.end(JSON.stringify({ exported_at: new Date().toISOString(), count: rows.length, events: rows }));
}

module.exports = { getAuditLog, getStats, exportAuditLog };
