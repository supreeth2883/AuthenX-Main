'use strict';
/**
 * AuthenX — Privacy & DPDP Routes
 * Implements data subject rights under India's DPDP Act 2023.
 */

const { requireAuth } = require('../middleware/auth.js');
const {
  recordConsent, revokeConsent, getUserConsents,
  generateDataAccessReport, processErasureRequest,
  enforceRetentionPolicy, getPrivacyNotice,
} = require('../middleware/dpdp.js');

/**
 * GET /v1/privacy/notice
 * Public — serve the privacy notice / data processing policy.
 */
function privacyNotice(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getPrivacyNotice()));
}

/**
 * GET /v1/privacy/consent
 * Authenticated — view user's consent records.
 */
function getConsent(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const consents = getUserConsents(claims.user_id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ consents }));
}

/**
 * POST /v1/privacy/consent
 * Authenticated — grant consent for a specific purpose.
 */
function grantConsent(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { purpose, scope } = body;
  if (!purpose) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'purpose is required' }));
  }

  const ip = req.socket?.remoteAddress || 'unknown';
  const consentId = recordConsent(claims.user_id, purpose, scope || 'full', ip);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ consent_id: consentId, purpose, status: 'granted' }));
}

/**
 * DELETE /v1/privacy/consent
 * Authenticated — revoke consent for a specific purpose.
 */
function deleteConsent(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { purpose } = body;
  if (!purpose) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'purpose is required' }));
  }

  try {
    revokeConsent(claims.user_id, purpose);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ purpose, status: 'revoked' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * GET /v1/privacy/data-access
 * Authenticated — generate complete data access report (DSAR).
 */
function dataAccessRequest(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const report = generateDataAccessReport(claims.user_id);
  if (!report) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'User not found' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(report));
}

/**
 * POST /v1/privacy/erasure
 * Authenticated — request data erasure (Right to be Forgotten).
 */
function erasureRequest(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { reason } = body;
  const ip = req.socket?.remoteAddress || 'unknown';
  const result = processErasureRequest(claims.user_id, reason || 'User requested', ip);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...result,
    note: 'Your data has been erased. Account credentials remain for access control.',
  }));
}

/**
 * POST /v1/privacy/retention/enforce
 * Admin only — run data retention enforcement.
 */
function enforceRetention(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  if (claims.role !== 'super_admin') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Admin access required' }));
  }

  const results = enforceRetentionPolicy();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ retention_enforcement: results }));
}

module.exports = {
  privacyNotice,
  getConsent,
  grantConsent,
  deleteConsent,
  dataAccessRequest,
  erasureRequest,
  enforceRetention,
};
