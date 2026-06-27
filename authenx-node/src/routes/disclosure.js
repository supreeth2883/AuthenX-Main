'use strict';
const crypto = require('node:crypto');
const { query, queryOne, run } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');

const FIELDS = ['name', 'degree', 'branch', 'cgpa', 'graduation_year', 'issue_date'];

/**
 * GET /v1/disclosure-policy
 * Returns current disclosure policy for the authenticated college.
 */
async function getDisclosurePolicy(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const collegeId = claims.role === 'super_admin'
    ? new URL(req.url, 'http://localhost').searchParams.get('college_id') || claims.college_id
    : claims.college_id;

  if (!collegeId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'college_id required' }));
  }

  const rows = await query(
    'SELECT field_name, visibility, role_filter, require_approval FROM disclosure_policies WHERE college_id = $1',
    [collegeId]
  );

  // Fill in defaults for any missing fields
  const policyMap = {};
  for (const row of rows) policyMap[row.field_name] = row;

  const policy = FIELDS.map(f => policyMap[f] || {
    field_name: f,
    visibility: 'always_show',
    role_filter: 'all',
    require_approval: 0
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ college_id: collegeId, policy }));
}

/**
 * PUT /v1/disclosure-policy
 * Saves disclosure policy for the college.
 * Body: { policy: [{ field_name, visibility, role_filter, require_approval }] }
 */
async function saveDisclosurePolicy(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const collegeId = claims.role === 'super_admin'
    ? (body.college_id || claims.college_id)
    : claims.college_id;

  if (!collegeId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'college_id required' }));
  }

  const { policy } = body;
  if (!Array.isArray(policy) || policy.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'policy array is required' }));
  }

  const validVisibilities = ['always_show', 'always_hide', 'admin_decision'];
  const now = new Date().toISOString();

  for (const item of policy) {
    if (!FIELDS.includes(item.field_name)) continue;
    if (!validVisibilities.includes(item.visibility)) continue;

    await run(`
      INSERT INTO disclosure_policies (id, college_id, field_name, visibility, role_filter, require_approval, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(college_id, field_name) DO UPDATE SET
        visibility = EXCLUDED.visibility,
        role_filter = EXCLUDED.role_filter,
        require_approval = EXCLUDED.require_approval,
        updated_at = EXCLUDED.updated_at
    `, [
      crypto.randomUUID(), collegeId, item.field_name,
      item.visibility, item.role_filter || 'all',
      item.require_approval ? 1 : 0, now
    ]);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Disclosure policy saved', college_id: collegeId }));
}

module.exports = { getDisclosurePolicy, saveDisclosurePolicy };
