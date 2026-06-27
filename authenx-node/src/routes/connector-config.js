'use strict';
const { queryOne, run } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');

/**
 * GET /v1/connector-config
 * Returns persisted connector onboarding configuration for a college.
 */
async function getConnectorConfig(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  const url = new URL(req.url, 'http://localhost');
  const requestedCollegeId = url.searchParams.get('college_id');
  const collegeId = claims.role === 'super_admin'
    ? (requestedCollegeId || claims.college_id)
    : claims.college_id;

  if (!collegeId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'college_id required' }));
  }

  const college = await queryOne(
    'SELECT id, name, short_code, connector_url FROM colleges WHERE id = $1 AND active = 1',
    [collegeId]
  );
  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found' }));
  }

  const cfg = await queryOne(
    `SELECT onboarding_completed, erp_type, connector_url, connector_config_json, field_mapping_json, updated_at
     FROM college_connector_configs WHERE college_id = $1`,
    [collegeId]
  );

  let connector_config = null;
  let field_mapping = null;
  try { connector_config = cfg?.connector_config_json ? JSON.parse(cfg.connector_config_json) : null; } catch (err) {
    console.warn(`[connector-config] Corrupt connector_config_json for college ${collegeId}:`, err.message);
  }
  try { field_mapping = cfg?.field_mapping_json ? JSON.parse(cfg.field_mapping_json) : null; } catch (err) {
    console.warn(`[connector-config] Corrupt field_mapping_json for college ${collegeId}:`, err.message);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    college: {
      id: college.id,
      name: college.name,
      short_code: college.short_code,
      connector_url: (cfg?.connector_url || college.connector_url),
    },
    onboarding_completed: cfg?.onboarding_completed ? 1 : 0,
    erp_type: cfg?.erp_type || null,
    connector_config,
    field_mapping,
    updated_at: cfg?.updated_at || null,
  }));
}

/**
 * PUT /v1/connector-config
 * Body: {
 *   onboarding_completed?: 0|1,
 *   erp_type?: string,
 *   connector_url?: string,
 *   connector_config?: object,
 *   field_mapping?: object
 * }
 */
async function saveConnectorConfig(req, res, body) {
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

  const college = await queryOne('SELECT id FROM colleges WHERE id = $1 AND active = 1', [collegeId]);
  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found' }));
  }

  const onboarding_completed = body.onboarding_completed ? 1 : 0;
  const erp_type = body.erp_type ? String(body.erp_type) : null;
  const connector_url = body.connector_url ? String(body.connector_url) : null;
  const connector_config_json = body.connector_config ? JSON.stringify(body.connector_config) : null;
  const field_mapping_json = body.field_mapping ? JSON.stringify(body.field_mapping) : null;
  const now = new Date().toISOString();

  await run(
    `INSERT INTO college_connector_configs
      (college_id, onboarding_completed, erp_type, connector_url, connector_config_json, field_mapping_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(college_id) DO UPDATE SET
       onboarding_completed = EXCLUDED.onboarding_completed,
       erp_type = EXCLUDED.erp_type,
       connector_url = EXCLUDED.connector_url,
       connector_config_json = EXCLUDED.connector_config_json,
       field_mapping_json = EXCLUDED.field_mapping_json,
       updated_at = EXCLUDED.updated_at
    `,
    [collegeId, onboarding_completed, erp_type, connector_url, connector_config_json, field_mapping_json, now]
  );

  // Keep colleges.connector_url aligned so existing code paths remain correct.
  if (connector_url) {
    await run('UPDATE colleges SET connector_url = $1 WHERE id = $2', [connector_url, collegeId]);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Connector config saved', college_id: collegeId, onboarding_completed }));
}

module.exports = { getConnectorConfig, saveConnectorConfig };
