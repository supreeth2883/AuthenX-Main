'use strict';
/**
 * AuthenX — Production Metrics Collector
 *
 * Tracks request counts, latency percentiles, verification rates,
 * and connector performance per college.
 *
 * Exposes GET /v1/metrics (admin-only) in Prometheus-style text format.
 * Zero external dependencies.
 */

const crypto = require('node:crypto');

// ─── Counters ─────────────────────────────────────────────────────────────────
const counters = {
  requests_total: 0,
  requests_by_method: {},      // GET → count, POST → count
  requests_by_status: {},      // 200 → count, 401 → count
  requests_by_path: {},        // /v1/verify/live → count
  verifications_total: 0,
  verifications_success: 0,
  verifications_failed: 0,
  verifications_revoked: 0,
  tokens_issued: 0,
  tokens_revoked: 0,
  auth_failures: 0,
  fraud_alerts: 0,
};

// ─── Latency tracking (sliding window) ────────────────────────────────────────
const WINDOW_SIZE = 1000; // Keep last 1000 measurements
const latencies = {
  all: [],             // all requests
  verify: [],          // /v1/verify/* latencies
  connectors: {},      // college_id → [latencies]
};

function recordLatency(bucket, ms) {
  const arr = Array.isArray(bucket) ? bucket : (latencies.connectors[bucket] = latencies.connectors[bucket] || []);
  arr.push(ms);
  if (arr.length > WINDOW_SIZE) arr.shift();
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function latencyStats(arr) {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(arr, 50),
    p95: percentile(arr, 95),
    p99: percentile(arr, 99),
    avg: Math.round(sum / arr.length),
    count: arr.length,
  };
}

// ─── Uptime & System ──────────────────────────────────────────────────────────
const startTime = Date.now();

// ─── Public API ───────────────────────────────────────────────────────────────

/** Record an HTTP request (call at end of request lifecycle) */
function recordRequest(method, path, statusCode, latencyMs) {
  counters.requests_total++;
  counters.requests_by_method[method] = (counters.requests_by_method[method] || 0) + 1;
  counters.requests_by_status[statusCode] = (counters.requests_by_status[statusCode] || 0) + 1;

  // Normalize path for grouping (strip IDs)
  const normalized = path.replace(/\/[0-9a-f-]{36}/g, '/:id');
  counters.requests_by_path[normalized] = (counters.requests_by_path[normalized] || 0) + 1;

  latencies.all.push(latencyMs);
  if (latencies.all.length > WINDOW_SIZE) latencies.all.shift();

  if (path.startsWith('/v1/verify')) {
    latencies.verify.push(latencyMs);
    if (latencies.verify.length > WINDOW_SIZE) latencies.verify.shift();
  }
}

/** Record a verification result */
function recordVerification(result) {
  counters.verifications_total++;
  if (result === 'verified') counters.verifications_success++;
  else if (result === 'revoked') counters.verifications_revoked++;
  else counters.verifications_failed++;
}

/** Record connector latency for a specific college */
function recordConnectorLatency(college_id, ms) {
  recordLatency(college_id, ms);
}

/** Record token issuance */
function recordTokenIssued() { counters.tokens_issued++; }

/** Record token revocation */
function recordTokenRevoked() { counters.tokens_revoked++; }

/** Record an auth failure */
function recordAuthFailure() { counters.auth_failures++; }

/** Record a fraud alert */
function recordFraudAlert() { counters.fraud_alerts++; }

/** Get full metrics snapshot (for admin API) */
function getMetrics() {
  const mem = process.memoryUsage();
  return {
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    memory: {
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
      rss_mb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
    },
    counters: { ...counters },
    latency: {
      all_requests: latencyStats(latencies.all),
      verify_requests: latencyStats(latencies.verify),
    },
    connector_latency: Object.fromEntries(
      Object.entries(latencies.connectors).map(([k, v]) => [k, latencyStats(v)])
    ),
    rates: {
      verification_success_pct: counters.verifications_total > 0
        ? Math.round((counters.verifications_success / counters.verifications_total) * 10000) / 100
        : 0,
    },
    collected_at: new Date().toISOString(),
  };
}

/** Prometheus-style text format */
function getPrometheusText() {
  const m = getMetrics();
  const lines = [];
  lines.push(`# HELP authenx_uptime_seconds Server uptime in seconds`);
  lines.push(`authenx_uptime_seconds ${m.uptime_seconds}`);
  lines.push(`# HELP authenx_requests_total Total HTTP requests processed`);
  lines.push(`authenx_requests_total ${m.counters.requests_total}`);
  lines.push(`# HELP authenx_verifications_total Total verifications attempted`);
  lines.push(`authenx_verifications_total ${m.counters.verifications_total}`);
  lines.push(`authenx_verifications_success ${m.counters.verifications_success}`);
  lines.push(`authenx_verifications_failed ${m.counters.verifications_failed}`);
  lines.push(`authenx_verifications_revoked ${m.counters.verifications_revoked}`);
  lines.push(`authenx_tokens_issued ${m.counters.tokens_issued}`);
  lines.push(`authenx_tokens_revoked ${m.counters.tokens_revoked}`);
  lines.push(`authenx_auth_failures ${m.counters.auth_failures}`);
  lines.push(`authenx_fraud_alerts ${m.counters.fraud_alerts}`);
  lines.push(`# HELP authenx_latency_ms Request latency percentiles`);
  lines.push(`authenx_latency_p50_ms ${m.latency.all_requests.p50}`);
  lines.push(`authenx_latency_p95_ms ${m.latency.all_requests.p95}`);
  lines.push(`authenx_latency_p99_ms ${m.latency.all_requests.p99}`);
  lines.push(`authenx_memory_heap_mb ${m.memory.heap_used_mb}`);
  for (const [cid, stats] of Object.entries(m.connector_latency)) {
    lines.push(`authenx_connector_latency_p95_ms{college="${cid}"} ${stats.p95}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  recordRequest, recordVerification, recordConnectorLatency,
  recordTokenIssued, recordTokenRevoked, recordAuthFailure, recordFraudAlert,
  getMetrics, getPrometheusText,
};
