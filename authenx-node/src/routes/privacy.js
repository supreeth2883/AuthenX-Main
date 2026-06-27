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
const { sendJson, sendError } = require('../utils/json-response.js');

/** GET /v1/privacy/notice — public privacy notice */
function privacyNotice(req, res) {
  sendJson(res, 200, getPrivacyNotice());
}

/** GET /v1/privacy/consent — view user's consent records */
async function getConsent(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const consents = await getUserConsents(claims.user_id);
  sendJson(res, 200, { consents });
}

/** POST /v1/privacy/consent — grant consent for a specific purpose */
async function grantConsent(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { purpose, scope } = body;
  if (!purpose) {
    return sendError(res, 400, 'purpose is required');
  }

  const ip = req.socket?.remoteAddress || 'unknown';
  const consentId = await recordConsent(claims.user_id, purpose, scope || 'full', ip);

  sendJson(res, 200, { consent_id: consentId, purpose, status: 'granted' });
}

/** DELETE /v1/privacy/consent — revoke consent for a specific purpose */
async function deleteConsent(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { purpose } = body;
  if (!purpose) {
    return sendError(res, 400, 'purpose is required');
  }

  try {
    await revokeConsent(claims.user_id, purpose);
    sendJson(res, 200, { purpose, status: 'revoked' });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/** GET /v1/privacy/data-access — generate complete data access report (DSAR) */
async function dataAccessRequest(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const report = await generateDataAccessReport(claims.user_id);
  if (!report) {
    return sendError(res, 404, 'User not found');
  }

  sendJson(res, 200, report);
}

/** POST /v1/privacy/erasure — request data erasure (Right to be Forgotten) */
async function erasureRequest(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { reason } = body;
  const ip = req.socket?.remoteAddress || 'unknown';
  const result = await processErasureRequest(claims.user_id, reason || 'User requested', ip);

  sendJson(res, 200, {
    ...result,
    note: 'Your data has been erased. Account credentials remain for access control.',
  });
}

/** POST /v1/privacy/retention/enforce — admin only, run data retention enforcement */
async function enforceRetention(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  if (claims.role !== 'super_admin') {
    return sendError(res, 403, 'Admin access required');
  }

  const results = await enforceRetentionPolicy();
  sendJson(res, 200, { retention_enforcement: results });
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
