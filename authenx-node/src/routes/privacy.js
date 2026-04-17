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

/** GET /v1/privacy/notice — public privacy notice */
function privacyNotice(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getPrivacyNotice()));
}

/** GET /v1/privacy/consent — view user's consent records */
async function getConsent(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const consents = await getUserConsents(claims.user_id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ consents }));
}

/** POST /v1/privacy/consent — grant consent for a specific purpose */
async function grantConsent(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { purpose, scope } = body;
  if (!purpose) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'purpose is required' }));
  }

  const ip = req.socket?.remoteAddress || 'unknown';
  const consentId = await recordConsent(claims.user_id, purpose, scope || 'full', ip);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ consent_id: consentId, purpose, status: 'granted' }));
}

/** DELETE /v1/privacy/consent — revoke consent for a specific purpose */
async function deleteConsent(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { purpose } = body;
  if (!purpose) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'purpose is required' }));
  }

  try {
    await revokeConsent(claims.user_id, purpose);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ purpose, status: 'revoked' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/** GET /v1/privacy/data-access — generate complete data access report (DSAR) */
async function dataAccessRequest(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const report = await generateDataAccessReport(claims.user_id);
  if (!report) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'User not found' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(report));
}

/** POST /v1/privacy/erasure — request data erasure (Right to be Forgotten) */
async function erasureRequest(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { reason } = body;
  const ip = req.socket?.remoteAddress || 'unknown';
  const result = await processErasureRequest(claims.user_id, reason || 'User requested', ip);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...result,
    note: 'Your data has been erased. Account credentials remain for access control.',
  }));
}

/** POST /v1/privacy/retention/enforce — admin only, run data retention enforcement */
async function enforceRetention(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  if (claims.role !== 'super_admin') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Admin access required' }));
  }

  const results = await enforceRetentionPolicy();
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
