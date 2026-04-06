'use strict';
/**
 * AuthenX — TOTP (Time-based One-Time Password)
 * RFC 6238 implementation using only Node built-in crypto.
 *
 * Features:
 *   - 6-digit TOTP codes with 30-second time steps
 *   - Base32 encoding/decoding for secret sharing
 *   - otpauth:// URI generation for authenticator apps
 *   - Drift tolerance (±1 time step = ±30s)
 *
 * Zero external dependencies.
 */

const crypto = require('node:crypto');

const TOTP_PERIOD = 30;   // seconds per time step
const TOTP_DIGITS = 6;    // output length
const DRIFT_STEPS = 1;    // allow ±1 step for clock drift

// ─── Base32 ───────────────────────────────────────────────────────────────────
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    result += BASE32_CHARS[parseInt(chunk, 2)];
  }
  return result;
}

function base32Decode(str) {
  const cleaned = str.replace(/[=\s]/g, '').toUpperCase();
  let bits = '';
  for (const c of cleaned) {
    const idx = BASE32_CHARS.indexOf(c);
    if (idx < 0) throw new Error('Invalid base32 character');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// ─── HOTP (RFC 4226) ──────────────────────────────────────────────────────────
function generateHOTP(secret, counter) {
  // Counter as 8-byte big-endian
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  // HMAC-SHA1(secret, counter)
  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, TOTP_DIGITS);

  return String(code).padStart(TOTP_DIGITS, '0');
}

// ─── TOTP (RFC 6238) ─────────────────────────────────────────────────────────
/**
 * Generate a TOTP code for the current time.
 * @param {Buffer} secret - HMAC key (raw bytes)
 * @param {number} [time] - Unix timestamp (defaults to now)
 */
function generateTOTP(secret, time = Math.floor(Date.now() / 1000)) {
  const counter = Math.floor(time / TOTP_PERIOD);
  return generateHOTP(secret, counter);
}

/**
 * Verify a TOTP code with drift tolerance.
 * @param {string} code - User-submitted 6-digit code
 * @param {Buffer} secret - HMAC key (raw bytes)
 * @param {number} [time] - Unix timestamp (defaults to now)
 * @returns {boolean}
 */
function verifyTOTP(code, secret, time = Math.floor(Date.now() / 1000)) {
  const counter = Math.floor(time / TOTP_PERIOD);
  for (let i = -DRIFT_STEPS; i <= DRIFT_STEPS; i++) {
    const expected = generateHOTP(secret, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

// ─── Secret Generation ────────────────────────────────────────────────────────
/**
 * Generate a new TOTP secret.
 * Returns { secret (Buffer), base32 (string for QR/manual entry) }
 */
function generateSecret() {
  const secret = crypto.randomBytes(20); // 160-bit key per RFC 4226 recommendation
  return {
    secret,
    base32: base32Encode(secret),
  };
}

/**
 * Generate an otpauth:// URI for authenticator apps (Google Authenticator, Authy, etc.)
 * @param {string} email - User email
 * @param {string} base32Secret - Base32-encoded secret
 * @param {string} [issuer] - Application name
 */
function generateOtpAuthUri(email, base32Secret, issuer = 'AuthenX') {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedEmail = encodeURIComponent(email);
  return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${base32Secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// ─── Backup Codes ─────────────────────────────────────────────────────────────
/**
 * Generate a set of single-use backup codes.
 * Each code is 8 hex characters (32 bits of entropy).
 */
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

/** Hash a backup code for safe storage */
function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
}

module.exports = {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  generateOtpAuthUri,
  generateBackupCodes,
  hashBackupCode,
  base32Encode,
  base32Decode,
};
