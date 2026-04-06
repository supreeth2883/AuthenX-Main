'use strict';
/**
 * AuthenX — Verification Result Cache
 *
 * Short-lived in-memory cache for live verification results.
 * Reduces repeated identical verification requests hitting the college connector.
 *
 * Design rules:
 *   - NEVER cache raw student data (name, CGPA, etc.)
 *   - Cache only: result status, crypto check booleans, latency, timestamp
 *   - Default TTL: 30 seconds (connector responses are inherently live)
 *   - Max 500 entries (memory safety)
 *   - Revoked tokens → 5-second TTL (fast propagation of revocation)
 *   - Error results → NOT cached (always retry)
 */

const DEFAULT_TTL_MS = 30_000;   // 30 seconds for verified
const REVOKED_TTL_MS =  5_000;   // 5 seconds for revoked (fast propagation)
const MAX_ENTRIES    =    500;   // safety cap

const cache = new Map(); // key → { result, expires_at }

function makeKey(token_id) {
  // Key per token only — nonces are always fresh, so we key on stable token identity
  return `v:${token_id}`;
}

/**
 * Try to get a cached verification result.
 * Returns null if not found or expired.
 */
function get(token_id) {
  const key  = makeKey(token_id);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires_at) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

/**
 * Store a verification result.
 * Only stores verified/revoked — never stores error results.
 */
function set(token_id, result) {
  if (!result || result.result === 'error' || result.result === 'fallback_verified') return;

  // Evict oldest if at cap
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }

  const ttl = result.result === 'revoked' ? REVOKED_TTL_MS : DEFAULT_TTL_MS;
  cache.set(makeKey(token_id), {
    result: {
      ...result,
      cached:      true,
      cached_at:   new Date().toISOString(),
      live_data:   null, // NEVER cache live student data
    },
    expires_at: Date.now() + ttl,
  });
}

/** Immediately invalidate a token (e.g. after revocation) */
function invalidate(token_id) {
  cache.delete(makeKey(token_id));
}

/** Current cache size (for monitoring) */
function size() { return cache.size; }

/** Clear entire cache (for testing/admin) */
function clear() { cache.clear(); }

module.exports = { get, set, invalidate, size, clear };
