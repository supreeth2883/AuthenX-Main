'use strict';
/**
 * AuthenX — Rate Limiter Middleware
 *
 * In-memory sliding window rate limiter.
 * Protects the verification API from abuse and DoS.
 *
 * Limits (default):
 *   - /v1/verify/*  → 30 requests/minute per employer (by JWT user ID)
 *   - /v1/tokens/*  → 20 requests/minute per college admin
 *   - Global        → 200 requests/minute per IP
 *
 * Zero external dependencies — uses Node built-ins only.
 */

const WINDOW_MS = 60_000; // 1 minute sliding window

const limits = {
  verify:  30,  // employer verification requests per minute
  issue:   20,  // college token issuance per minute
  global: 200,  // global per IP
};

// Separate stores per limit type
const stores = {
  verify:  new Map(),
  issue:   new Map(),
  global:  new Map(),
};

function windowCheck(store, key, limit) {
  const now  = Date.now();
  const hits = (store.get(key) || []).filter(t => t > now - WINDOW_MS);
  if (hits.length >= limit) return { allowed: false, remaining: 0, resetAt: hits[0] + WINDOW_MS };
  hits.push(now);
  store.set(key, hits);
  return { allowed: true, remaining: limit - hits.length, resetAt: hits[0] + WINDOW_MS };
}

// Periodic cleanup to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const store of Object.values(stores)) {
    for (const [k, hits] of store) {
      const fresh = hits.filter(t => t > now - WINDOW_MS);
      if (fresh.length === 0) store.delete(k);
      else store.set(k, fresh);
    }
  }
}, 60_000);

/**
 * Express-style middleware factory.
 * Usage: const { verifyLimiter } = require('./rate-limiter');
 */
function createLimiter(type) {
  return function rateLimitMiddleware(req, res, claims) {
    const ip  = req.socket?.remoteAddress || 'unknown';
    const uid = claims?.sub || claims?.email || ip;

    // Global IP check
    const global = windowCheck(stores.global, ip, limits.global);
    if (!global.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil((global.resetAt - Date.now()) / 1000) });
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.', retry_after_seconds: Math.ceil((global.resetAt - Date.now()) / 1000) }));
      return false;
    }

    // Per-user check
    const user = windowCheck(stores[type] || stores.verify, uid, limits[type] || limits.verify);
    if (!user.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil((user.resetAt - Date.now()) / 1000) });
      res.end(JSON.stringify({ error: 'Rate limit exceeded for your account.', retry_after_seconds: Math.ceil((user.resetAt - Date.now()) / 1000) }));
      return false;
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Remaining', user.remaining);
    res.setHeader('X-RateLimit-Reset', Math.floor(user.resetAt / 1000));
    return true;
  };
}

const verifyLimiter = createLimiter('verify');
const issueLimiter  = createLimiter('issue');

/** Get current stats for monitoring */
function getStats() {
  const now = Date.now();
  return {
    verify_active_keys: stores.verify.size,
    issue_active_keys:  stores.issue.size,
    global_active_ips:  stores.global.size,
    window_ms:          WINDOW_MS,
    limits,
  };
}

module.exports = { verifyLimiter, issueLimiter, getStats };
