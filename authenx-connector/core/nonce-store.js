'use strict';
/**
 * AuthenX Connector — Nonce Store
 * Prevents replay attacks by tracking used nonces with TTL expiry.
 * Thread-safe for single-process Node.js.
 */

const NONCE_TTL_MS  = 60_000;   // 60 seconds
const CLEANUP_EVERY = 500;       // cleanup every N operations to avoid memory leak

let _opCount = 0;
const usedNonces = new Map(); // nonce → expiry timestamp

function cleanExpired() {
  const now = Date.now();
  for (const [n, exp] of usedNonces) {
    if (exp < now) usedNonces.delete(n);
  }
}

/**
 * Check if nonce is fresh (not seen before).
 * Returns true  → nonce is valid, registers it
 * Returns false → nonce was already used (replay attack)
 */
function checkNonce(nonce) {
  if (++_opCount % CLEANUP_EVERY === 0) cleanExpired();
  const now = Date.now();
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

/** Current nonce count (for monitoring) */
function nonceCount() { return usedNonces.size; }

module.exports = { checkNonce, nonceCount };
