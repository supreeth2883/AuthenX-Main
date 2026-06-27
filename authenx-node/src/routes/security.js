'use strict';
const { queryOne } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
const { sendJson } = require('../utils/json-response.js');

/**
 * GET /v1/security/stats
 * Returns security metrics for the college security dashboard.
 */
async function getSecurityStats(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const isSuper = claims.role === 'super_admin';
  const cid = claims.college_id;

  async function q(sql, params = []) {
    return (await queryOne(sql, params)) || { cnt: 0 };
  }

  const activeQ = isSuper
    ? await q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active'")
    : await q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active' AND college_id=$1", [cid]);

  const verified24h = isSuper
    ? await q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE r.result='verified' AND r.created_at >= NOW() - INTERVAL '1 day'`)
    : await q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE t.college_id=$1 AND r.result='verified' AND r.created_at >= NOW() - INTERVAL '1 day'`, [cid]);

  const verified7d = isSuper
    ? await q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE r.result='verified' AND r.created_at >= NOW() - INTERVAL '7 days'`)
    : await q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id
         WHERE t.college_id=$1 AND r.result='verified' AND r.created_at >= NOW() - INTERVAL '7 days'`, [cid]);

  const neverVerified = isSuper
    ? await q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE status='active' AND verification_count=0")
    : await q("SELECT COUNT(*) as cnt FROM verification_tokens WHERE college_id=$1 AND status='active' AND verification_count=0", [cid]);

  const avgRow = isSuper
    ? await queryOne(`SELECT AVG(EXTRACT(EPOCH FROM (r.created_at::timestamptz - t.issued_at::timestamptz))) as avg_secs
                FROM (SELECT token_id, MIN(created_at) as created_at FROM verification_requests GROUP BY token_id) r
                JOIN verification_tokens t ON t.id=r.token_id`)
    : await queryOne(`SELECT AVG(EXTRACT(EPOCH FROM (r.created_at::timestamptz - t.issued_at::timestamptz))) as avg_secs
                FROM (SELECT token_id, MIN(created_at) as created_at FROM verification_requests GROUP BY token_id) r
                JOIN verification_tokens t ON t.id=r.token_id WHERE t.college_id=$1`, [cid]);

  const sigFail = isSuper
    ? await q("SELECT COUNT(*) as cnt FROM verification_requests WHERE sig_valid=0")
    : await q(`SELECT COUNT(*) as cnt FROM verification_requests r
         JOIN verification_tokens t ON t.id=r.token_id WHERE t.college_id=$1 AND r.sig_valid=0`, [cid]);

  sendJson(res, 200, {
    stats: {
      total_active:                  Number(activeQ.cnt) || 0,
      verified_24h:                  Number(verified24h.cnt) || 0,
      verified_7d:                   Number(verified7d.cnt) || 0,
      never_verified:                Number(neverVerified.cnt) || 0,
      avg_time_to_first_verify_secs: avgRow?.avg_secs ? Number(avgRow.avg_secs) : null,
      sig_failures:                  Number(sigFail.cnt) || 0,
    }
  });
}

module.exports = { getSecurityStats };
