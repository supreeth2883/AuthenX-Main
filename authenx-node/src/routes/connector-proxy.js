'use strict';

const crypto = require('node:crypto');
const { queryOne, run } = require('../db/client.js');
const { requireAuth } = require('../middleware/auth.js');
const { signRequest } = require('../middleware/hmac-auth.js');
const cvrErp = require('../mock-erp/cvr-erp.js');
const { CVR_SHORT_CODE } = cvrErp;
const { lookupStudent: lookupCentralStudent } = require('../db/students.js');
const { makeJsonRequest } = require('../utils/http-client.js');
const { sendJson, sendError } = require('../utils/json-response.js');
const { isMockConnectorUrl } = require('../utils/mock-connector.js');

async function getCollegeConnector(claims) {
  if (!claims?.college_id) return null;
  return queryOne(
    'SELECT id, name, short_code, connector_url, shared_secret FROM colleges WHERE id = $1 AND active = 1',
    [claims.college_id]
  );
}

/**
 * GET /v1/connector/health
 * Server-side proxy to college connector /health.
 */
async function connectorHealth(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = await getCollegeConnector(claims);
  if (!college) {
    return sendError(res, 400, 'No college in session');
  }

  const connectorUrl = college.connector_url;
  if (isMockConnectorUrl(connectorUrl)) {
    return sendJson(res, 200, {
      status: 'mock',
      college: college.name,
      college_id: college.id,
      connector_url: connectorUrl || null,
    });
  }

  try {
    const start = Date.now();
    const r = await makeJsonRequest('GET', new URL('/health', connectorUrl).toString(), null, {}, 3000);
    const latency_ms = Date.now() - start;
    if (r.status >= 200 && r.status < 300) {
      return sendJson(res, 200, { ...r.json, connector_url: connectorUrl, latency_ms });
    }
    return sendError(res, 502, 'Connector returned non-200', { status: r.status, connector_url: connectorUrl });
  } catch (err) {
    return sendError(res, 502, 'Connector unreachable', { detail: err.message, connector_url: connectorUrl });
  }
}

/**
 * POST /v1/connector/verify
 * Body: { student_ref_token, nonce }
 * Server-side proxy to connector /verify with HMAC headers.
 */
async function connectorVerify(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = await getCollegeConnector(claims);
  if (!college) {
    return sendError(res, 400, 'No college in session');
  }

  const { student_ref_token, nonce } = body || {};
  if (!student_ref_token || !nonce) {
    return sendError(res, 400, 'student_ref_token and nonce are required');
  }

  const connectorUrl = college.connector_url;
  const isMockMode = isMockConnectorUrl(connectorUrl);

  // ── Mock ERP path (no external connector configured) ─────────────────────
  if (isMockMode) {
    if (college.short_code === CVR_SHORT_CODE) {
      return serveMockErp(res, college, student_ref_token);
    }
    return sendError(res, 503, 'No connector configured for this college', { college_id: college.id });
  }

  if (!college.shared_secret) {
    return sendError(res, 500, 'College shared_secret missing in DB');
  }

  const payload = { student_ref_token: String(student_ref_token), nonce: String(nonce) };
  const rawBody = JSON.stringify(payload);
  const headers = signRequest('POST', '/verify', rawBody, college.shared_secret, college.id);

  try {
    const start = Date.now();
    const r = await makeJsonRequest('POST', new URL('/verify', connectorUrl).toString(), rawBody, headers, 5000);
    const latency_ms = Date.now() - start;
    if (r.status >= 200 && r.status < 300) {
      return sendJson(res, 200, { ...r.json, connector_latency_ms: latency_ms });
    }
    return sendError(res, 502, 'Connector verify failed', {
      status: r.status,
      connector_url: connectorUrl,
      detail: r.json?.error || r.raw || null,
    });
  } catch (err) {
    console.warn(`[connector-proxy] ${college.id} connector unreachable (${err.message})`);
    if (college.short_code === CVR_SHORT_CODE) {
      return serveMockErp(res, college, student_ref_token);
    }
    return sendError(res, 502, 'Connector verify unreachable', { detail: err.message, connector_url: connectorUrl });
  }
}

/**
 * Serve student data from the CVR PostgreSQL mock ERP.
 */
async function serveMockErp(res, college, student_ref_token) {
  try {
    const centralStudent = await lookupCentralStudent(college.id, String(student_ref_token));
    if (!centralStudent) {
      return sendError(res, 404, `Student not found in central postgres.erp.students: ${student_ref_token}`, {
        student_ref_token,
        college_id: college.id,
      });
    }

    const student = {
      student_ref_token: centralStudent.student_id,
      name: centralStudent.full_name,
      degree: centralStudent.degree,
      branch: centralStudent.dept_name,
      cgpa: String(centralStudent.cgpa),
      graduation_year: centralStudent.grad_year,
      issue_date: centralStudent.issue_date,
      student_status: centralStudent.student_status,
      credential_type: centralStudent.credential_type,
      college_name: college.name || null,
      source: 'central_postgres_erp_students',
      source_table: 'erp.students',
    };
    return sendJson(res, 200, student);
  } catch (err) {
    return sendError(res, 500, 'Central erp.students lookup failed', { detail: err.message });
  }
}

/**
 * POST /v1/connector/rotate-key
 * Rotate the college's Ed25519 signing key pair in the HSM.
 */
async function rotateKey(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = await getCollegeConnector(claims);
  if (!college) {
    return sendError(res, 400, 'No college in session');
  }

  const hsmPort = parseInt(process.env.HSM_PORT || '9099', 10);
  const reqBody = JSON.stringify({ college_id: college.id });

  let hsmResult;
  try {
    hsmResult = await makeJsonRequest('POST', `http://127.0.0.1:${hsmPort}/rotate-key`, reqBody, {}, 8000);
  } catch (err) {
    return sendError(res, 502, 'HSM unreachable', { detail: err.message });
  }

  if (hsmResult.status !== 200 || !hsmResult.json?.public_key_hex) {
    return sendError(res, 500, 'HSM key rotation failed', {
      detail: hsmResult.json?.error || `HTTP ${hsmResult.status}`,
    });
  }

  const { public_key_hex, version } = hsmResult.json;

  // Persist new public key in both tables
  await run('UPDATE colleges SET public_key_hex = $1 WHERE id = $2', [public_key_hex, college.id]);
  await run('UPDATE college_keys SET public_key_hex = $1 WHERE college_id = $2', [public_key_hex, college.id]);

  // Immutable audit trail
  await run(
    `INSERT INTO security_events (id, event_type, actor_id, actor_email, target_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      'key_rotated',
      claims.sub || null,
      claims.email || null,
      college.id,
      req.socket?.remoteAddress || null,
      JSON.stringify({ college_id: college.id, version: version || null }),
    ]
  );

  return sendJson(res, 200, { success: true, public_key_hex, version: version || null });
}

module.exports = { connectorHealth, connectorVerify, rotateKey };
