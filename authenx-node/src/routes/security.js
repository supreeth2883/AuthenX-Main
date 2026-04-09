'use strict';
const { queryOne } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');

/**
 * GET /v1/security/stats
 * Returns security metrics for the college security dashboard.
 */
function getSecurityStats(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const isSuper = claims.role === 'super_admin';
  const cid = claims.college_id;

  function q(sql, params = []) {
    return queryOne(sql, params) || { cnt: 0 };
  }

  const activeQ = isSuper
    ? q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active'")
    : q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active' AND college_id=?", [cid]);

  const verified24h = isSuper
    ? q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE r.result='verified' AND r.created_at >= datetime('now','-1 day')`)
    : q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE t.college_id=? AND r.result='verified' AND r.created_at >= datetime('now','-1 day')`, [cid]);

  const verified7d = isSuper
    ? q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE r.result='verified' AND r.created_at >= datetime('now','-7 days')`)
    : q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE t.college_id=? AND r.result='verified' AND r.created_at >= datetime('now','-7 days')`, [cid]);

  const neverVerified = isSuper
    ? q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active' AND verification_count=0")
    : q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE college_id=? AND status='active' AND verification_count=0", [cid]);

  const avgRow = isSuper
    ? queryOne(`SELECT AVG(CAST((julianday(r.created_at)-julianday(t.issued_at))*86400 AS INTEGER)) as avg_secs
                FROM (SELECT token_id, MIN(created_at) as created_at FROM verification_requests GROUP BY token_id) r
                JOIN verification_tokens t ON t.id=r.token_id`)
    : queryOne(`SELECT AVG(CAST((julianday(r.created_at)-julianday(t.issued_at))*86400 AS INTEGER)) as avg_secs
                FROM (SELECT token_id, MIN(created_at) as created_at FROM verification_requests GROUP BY token_id) r
                JOIN verification_tokens t ON t.id=r.token_id WHERE t.college_id=?`, [cid]);

  const sigFail = isSuper
    ? q("SELECT COUNT(*) as cnt FROM verification_requests WHERE sig_valid=0")
    : q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id WHERE t.college_id=? AND r.sig_valid=0`, [cid]);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    stats: {
      total_active:                  activeQ.cnt || 0,
      verified_24h:                  verified24h.cnt || 0,
      verified_7d:                   verified7d.cnt || 0,
      never_verified:                neverVerified.cnt || 0,
      avg_time_to_first_verify_secs: avgRow?.avg_secs || null,
      sig_failures:                  sigFail.cnt || 0,
    }
  }));
}

module.exports = { getSecurityStats };
