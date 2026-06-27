'use strict';
/**
 * AuthenX — DPDP (Digital Personal Data Protection) Compliance Layer
 *
 * India's DPDP Act 2023 compliance for credential verification:
 *   - Consent tracking & management
 *   - Right to data access (what we store about you)
 *   - Right to erasure (delete my data)
 *   - Data retention policy enforcement
 *   - Privacy-by-design audit trail
 *
 * Key principle: AuthenX already stores ZERO PII (only hashes/tokens).
 * This module formalizes that into auditable compliance artifacts.
 */

const crypto = require('node:crypto');
const { run, queryOne, query, transaction } = require('../db/client.js');

// ─── Consent Management ───────────────────────────────────────────────────────

/**
 * Record explicit consent for data processing.
 */
async function recordConsent(userId, purpose, scope, ip) {
  const id = crypto.randomUUID();
  await run(`INSERT INTO consent_records (id, user_id, purpose, scope, ip_address, granted)
       VALUES ($1, $2, $3, $4, $5, 1)`,
    [id, userId, purpose, scope, ip]);
  return id;
}

/**
 * Revoke previously granted consent.
 */
async function revokeConsent(userId, purpose) {
  await run(`UPDATE consent_records SET granted = 0, revoked_at = NOW()
       WHERE user_id = $1 AND purpose = $2 AND granted = 1`,
    [userId, purpose]);
}

/**
 * Check if a user has active consent for a specific purpose.
 */
async function hasConsent(userId, purpose) {
  const record = await queryOne(
    `SELECT id FROM consent_records WHERE user_id = $1 AND purpose = $2 AND granted = 1`,
    [userId, purpose]
  );
  return !!record;
}

/**
 * Get all consent records for a user.
 */
async function getUserConsents(userId) {
  return query(
    `SELECT id, purpose, scope, granted, created_at, revoked_at
     FROM consent_records WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
}

// ─── Data Access Request (DSAR) ───────────────────────────────────────────────

/**
 * Generate a complete data access report for a user.
 */
async function generateDataAccessReport(userId) {
  const user = await queryOne(
    'SELECT id, email, role, college_id, created_at FROM users WHERE id = $1',
    [userId]
  );
  if (!user) return null;

  const consents = await getUserConsents(userId);

  const verifications = await query(
    `SELECT vr.id, vr.request_type, vr.result, vr.created_at, vr.latency_ms
     FROM verification_requests vr WHERE vr.employer_name = $1
     ORDER BY vr.created_at DESC LIMIT 100`,
    [user.email]
  );

  const tokens = await query(
    `SELECT id, credential_type, status, issued_at, revoked_at
     FROM verification_tokens WHERE college_id = $1
     ORDER BY issued_at DESC LIMIT 100`,
    [user.college_id || 'none']
  );

  const securityEvents = await query(
    `SELECT event_type, created_at, ip_address
     FROM security_events WHERE actor_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );

  const mfaStatus = await queryOne(
    'SELECT enabled, verified_at, created_at FROM mfa_secrets WHERE user_id = $1',
    [userId]
  );

  return {
    report_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    dpdp_notice: 'Generated under Section 11 of the Digital Personal Data Protection Act, 2023',
    data_principal: {
      user_id: user.id,
      email: user.email,
      role: user.role,
      college_id: user.college_id || null,
      account_created: user.created_at,
    },
    pii_stored: {
      note: 'AuthenX stores ZERO student academic PII. Only email for login.',
      fields: ['email'],
    },
    consent_records: consents,
    verification_activity: verifications.map(v => ({
      id: v.id,
      type: v.request_type,
      result: v.result,
      date: v.created_at,
    })),
    tokens_issued: user.role === 'college_admin' ? tokens.map(t => ({
      id: t.id,
      type: t.credential_type,
      status: t.status,
      issued: t.issued_at,
    })) : [],
    security_events: securityEvents.map(e => ({
      type: e.event_type,
      date: e.created_at,
      ip: e.ip_address,
    })),
    mfa: mfaStatus ? {
      enabled: !!mfaStatus.enabled,
      verified_at: mfaStatus.verified_at,
    } : { enabled: false },
  };
}

// ─── Right to Erasure ─────────────────────────────────────────────────────────

/**
 * Process a data erasure request (Right to be Forgotten).
 */
async function processErasureRequest(userId, reason, ip) {
  const requestId = crypto.randomUUID();

  return transaction(async (db) => {
    // Log the erasure request itself (must be kept for compliance)
    await db.run(`INSERT INTO erasure_requests (id, user_id, reason, ip_address, status)
         VALUES ($1, $2, $3, $4, 'processing')`,
      [requestId, userId, reason, ip]);

    // Delete user-specific data
    await db.run('DELETE FROM mfa_secrets WHERE user_id = $1', [userId]);
    await db.run('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
    await db.run('DELETE FROM consent_records WHERE user_id = $1', [userId]);
    await db.run('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);

    // Anonymize security events (keep structure, remove PII)
    await db.run(`UPDATE security_events SET actor_email = '[ERASED]', ip_address = '[ERASED]'
         WHERE actor_id = $1`, [userId]);

    // Anonymize verification requests
    await db.run(`UPDATE verification_requests SET employer_name = '[ERASED]'
         WHERE employer_name = (SELECT email FROM users WHERE id = $1)`, [userId]);

    // Mark erasure complete
    await db.run(`UPDATE erasure_requests SET status = 'completed', completed_at = NOW()
         WHERE id = $1`, [requestId]);

    return { request_id: requestId, status: 'completed' };
  });
}

// ─── Data Retention Policy ────────────────────────────────────────────────────

const RETENTION_DAYS = {
  verification_requests: 365,  // 1 year
  security_events: 180,        // 6 months
  login_attempts: 90,          // 3 months
  fraud_alerts: 365,           // 1 year
  consent_records: 1825,       // 5 years (legal requirement)
};

/**
 * Enforce data retention policy by purging expired records.
 */
async function enforceRetentionPolicy() {
  const results = {};

  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      await run(`DELETE FROM ${table} WHERE created_at < $1`, [cutoff]);
      results[table] = { purged: true, retention_days: days, cutoff };
    } catch (err) {
      results[table] = { purged: false, error: err.message };
    }
  }

  return results;
}

// ─── Privacy Notice ───────────────────────────────────────────────────────────

function getPrivacyNotice() {
  return {
    version: '1.0.0',
    last_updated: '2026-04-06',
    dpdp_act_reference: 'Digital Personal Data Protection Act, 2023 (India)',
    data_fiduciary: 'AuthenX Platform',
    purposes: [
      {
        code: 'credential_verification',
        description: 'Verify academic credentials against college ERP systems',
        data_collected: ['AuthenX Code (encrypted token)', 'Verification timestamp'],
        pii_stored: false,
        retention: '1 year',
      },
      {
        code: 'authentication',
        description: 'User login and access control',
        data_collected: ['Email address', 'Login timestamps', 'IP address (hashed)'],
        pii_stored: true,
        pii_fields: ['email'],
        retention: 'Account lifetime',
      },
      {
        code: 'security_monitoring',
        description: 'Fraud detection and security event logging',
        data_collected: ['Request patterns', 'IP addresses'],
        pii_stored: false,
        retention: '6 months',
      },
    ],
    rights: {
      access: 'GET /v1/privacy/data-access — View all data stored about you',
      erasure: 'POST /v1/privacy/erasure — Request deletion of your data',
      consent: 'GET /v1/privacy/consent — View and manage your consent records',
      portability: 'Data export available via the data access report',
    },
    contact: {
      dpo_email: 'privacy@authenx.in',
      grievance_officer: 'grievance@authenx.in',
    },
  };
}

module.exports = {
  recordConsent,
  revokeConsent,
  hasConsent,
  getUserConsents,
  generateDataAccessReport,
  processErasureRequest,
  enforceRetentionPolicy,
  getPrivacyNotice,
};
