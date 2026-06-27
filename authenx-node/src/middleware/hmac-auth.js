'use strict';
/**
 * AuthenX — HMAC Request Authentication
 * Zero-trust mutual authentication between AuthenX server ↔ college connectors.
 *
 * How it works:
 *   1. AuthenX server signs outgoing requests to connectors using:
 *      HMAC-SHA256(shared_secret, method + path + timestamp + body_hash)
 *   2. Connector verifies the HMAC before processing
 *   3. Timestamp must be within ±60 seconds to prevent replay
 *
 * Headers added by server:
 *   X-AuthenX-Timestamp:  Unix timestamp (seconds)
 *   X-AuthenX-Signature:  HMAC-SHA256 hex digest
 *   X-AuthenX-College-ID: Target college ID
 *
 * Zero external dependencies.
 */

const crypto = require('node:crypto');

const MAX_CLOCK_DRIFT = 60; // seconds

/**
 * Sign an outgoing request to a connector.
 * Returns headers to add to the HTTP request.
 *
 * @param {string} method - HTTP method (POST)
 * @param {string} path - Request path (/verify)
 * @param {string} body - JSON body string
 * @param {string} sharedSecret - Hex-encoded shared secret for this college
 * @param {string} collegeId - Target college ID
 */
function signRequest(method, path, body, sharedSecret, collegeId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const message = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', Buffer.from(sharedSecret, 'hex'))
    .update(message)
    .digest('hex');

  return {
    'X-AuthenX-Timestamp': String(timestamp),
    'X-AuthenX-Signature': signature,
    'X-AuthenX-College-ID': collegeId,
  };
}

/**
 * Verify an incoming request from the AuthenX server.
 * Call this in the connector to authenticate requests.
 *
 * @param {Object} req - HTTP request object
 * @param {string} body - Raw request body string
 * @param {string} sharedSecret - Hex-encoded shared secret
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyRequest(req, body, sharedSecret) {
  const timestamp = req.headers['x-authenx-timestamp'];
  const signature = req.headers['x-authenx-signature'];

  if (!timestamp || !signature) {
    return { valid: false, error: 'Missing HMAC authentication headers' };
  }

  // Check timestamp freshness (anti-replay)
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > MAX_CLOCK_DRIFT) {
    return { valid: false, error: `Timestamp drift too large: ${Math.abs(now - ts)}s (max ${MAX_CLOCK_DRIFT}s)` };
  }

  // Recompute signature
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const path = req.url || '/verify';
  const method = req.method || 'POST';
  const message = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`;
  const expected = crypto.createHmac('sha256', Buffer.from(sharedSecret, 'hex'))
    .update(message)
    .digest('hex');

  // Timing-safe comparison
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
    return valid ? { valid: true } : { valid: false, error: 'HMAC signature mismatch' };
  } catch (err) {
    return { valid: false, error: `HMAC signature verification failed: ${err.message}` };
  }
}

module.exports = { signRequest, verifyRequest };
