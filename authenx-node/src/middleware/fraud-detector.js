'use strict';
/**
 * AuthenX — Behavioral Fraud Detection Engine
 *
 * Detects suspicious verification patterns without storing PII.
 * All alerts are stored with metadata only (no student data).
 *
 * Detection rules:
 *   1. RAPID_FIRE     — >10 verify requests in 60s from same employer
 *   2. SEQUENTIAL_SCAN — employer verifying sequential student refs (data harvesting)
 *   3. GEO_ANOMALY    — same account from multiple IPs in 5 min
 *   4. BRUTE_FORCE    — >5 invalid AuthenX codes from same IP in 5 min
 *   5. OFF_HOURS      — verification between 01:00–05:00 local time
 */

const crypto = require('node:crypto');

// Sliding windows — cleaned up periodically
const verifyWindow   = new Map(); // employer_id → [{ ts, student_ref, ip }]
const codeAttempts   = new Map(); // ip → [{ ts, valid }]
const ipTracker      = new Map(); // user_id → [{ ts, ip }]

const WINDOW_MS      = 60_000;    // 1 minute window
const GEO_WINDOW_MS  = 300_000;   // 5 minute window

// Alert buffer (flushed to DB by caller)
const alertBuffer = [];

function createAlert(type, severity, details) {
  const alert = {
    id: crypto.randomUUID(),
    alert_type: type,
    severity,
    actor_id:    details.actor_id || null,
    actor_email: details.actor_email || null,
    ip_address:  details.ip || null,
    details:     JSON.stringify({
      reason: details.reason,
      count:  details.count || null,
      window: details.window || null,
    }),
    created_at: new Date().toISOString(),
  };
  alertBuffer.push(alert);
  return alert;
}

/**
 * Analyze a verification event for suspicious patterns.
 * Call this after every /v1/verify/live or /v1/verify/code request.
 *
 * @param {Object} ctx - { employer_id, employer_email, ip, student_ref, result }
 * @returns {Array} - list of triggered alerts (may be empty)
 */
function analyzeVerification(ctx) {
  const { employer_id, employer_email, ip, student_ref } = ctx;
  const now = Date.now();
  const triggered = [];

  if (!employer_id) return triggered;

  // ── 1. RAPID_FIRE detection ──────────────────────────────────────────────
  const key = employer_id;
  if (!verifyWindow.has(key)) verifyWindow.set(key, []);
  const events = verifyWindow.get(key);
  events.push({ ts: now, student_ref, ip });

  // Clean old events
  while (events.length > 0 && events[0].ts < now - WINDOW_MS) events.shift();

  if (events.length > 10) {
    triggered.push(createAlert('RAPID_FIRE', 'high', {
      actor_id: employer_id,
      actor_email: employer_email,
      ip,
      reason: `${events.length} verification requests in 60 seconds`,
      count: events.length,
      window: '60s',
    }));
  }

  // ── 2. SEQUENTIAL_SCAN detection ─────────────────────────────────────────
  if (events.length >= 3) {
    const refs = events.map(e => e.student_ref).filter(Boolean);
    const numbers = refs.map(r => {
      const m = r.match(/(\d+)$/);
      return m ? parseInt(m[1]) : null;
    }).filter(n => n !== null);

    if (numbers.length >= 3) {
      let sequential = 0;
      for (let i = 1; i < numbers.length; i++) {
        if (numbers[i] === numbers[i - 1] + 1) sequential++;
      }
      if (sequential >= 2) {
        triggered.push(createAlert('SEQUENTIAL_SCAN', 'critical', {
          actor_id: employer_id,
          actor_email: employer_email,
          ip,
          reason: `Sequential student ref scan detected (${sequential + 1} consecutive refs)`,
          count: sequential + 1,
          window: '60s',
        }));
      }
    }
  }

  // ── 3. GEO_ANOMALY detection ─────────────────────────────────────────────
  if (!ipTracker.has(employer_id)) ipTracker.set(employer_id, []);
  const ips = ipTracker.get(employer_id);
  ips.push({ ts: now, ip });
  while (ips.length > 0 && ips[0].ts < now - GEO_WINDOW_MS) ips.shift();

  const uniqueIps = new Set(ips.map(e => e.ip));
  if (uniqueIps.size >= 3) {
    triggered.push(createAlert('GEO_ANOMALY', 'medium', {
      actor_id: employer_id,
      actor_email: employer_email,
      ip,
      reason: `Account used from ${uniqueIps.size} different IPs in 5 minutes`,
      count: uniqueIps.size,
      window: '5m',
    }));
  }

  // ── 5. OFF_HOURS detection ───────────────────────────────────────────────
  const hour = new Date().getHours();
  if (hour >= 1 && hour < 5) {
    triggered.push(createAlert('OFF_HOURS', 'low', {
      actor_id: employer_id,
      actor_email: employer_email,
      ip,
      reason: `Verification attempt at ${hour}:00 (off-hours)`,
    }));
  }

  return triggered;
}

/**
 * Analyze an AuthenX Code decode attempt for brute-force patterns.
 * Call after every /v1/verify/code attempt.
 *
 * @param {Object} ctx - { ip, valid (boolean) }
 * @returns {Array} - list of triggered alerts
 */
function analyzeCodeAttempt(ctx) {
  const { ip, valid } = ctx;
  const now = Date.now();
  const triggered = [];

  if (!ip) return triggered;

  if (!codeAttempts.has(ip)) codeAttempts.set(ip, []);
  const attempts = codeAttempts.get(ip);
  attempts.push({ ts: now, valid });
  while (attempts.length > 0 && attempts[0].ts < now - GEO_WINDOW_MS) attempts.shift();

  const invalid = attempts.filter(a => !a.valid).length;
  if (invalid >= 5) {
    triggered.push(createAlert('BRUTE_FORCE', 'high', {
      ip,
      reason: `${invalid} invalid AuthenX Code attempts in 5 minutes`,
      count: invalid,
      window: '5m',
    }));
  }

  return triggered;
}

/**
 * Flush alert buffer — returns all pending alerts and clears the buffer.
 * Caller is responsible for persisting to DB.
 */
function flushAlerts() {
  const copy = [...alertBuffer];
  alertBuffer.length = 0;
  return copy;
}

/** Get current alert buffer size (for monitoring) */
function pendingCount() { return alertBuffer.length; }

// ─── Periodic cleanup ─────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of verifyWindow) { if (v.length === 0) verifyWindow.delete(k); }
  for (const [k, v] of codeAttempts) { if (v.length === 0) codeAttempts.delete(k); }
  for (const [k, v] of ipTracker)    { if (v.length === 0) ipTracker.delete(k); }
}, 120_000).unref();

module.exports = { analyzeVerification, analyzeCodeAttempt, flushAlerts, pendingCount };
