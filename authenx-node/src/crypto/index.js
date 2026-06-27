'use strict';
/**
 * AuthenX Crypto Layer
 * All cryptographic operations using Node built-in node:crypto only.
 *
 * - Ed25519  : issuance signing + live verification signing
 * - AES-256-GCM : AuthenX Code encryption/decryption
 * - SHA-256  : canonical fingerprint hashing
 */

const crypto = require('node:crypto');

// ─── Canonical Fingerprint ────────────────────────────────────────────────────
/**
 * Build deterministic fixed-order JSON from credential fields.
 * Field order is fixed — any tampering changes the hash.
 */
function buildCanonicalJson(fields) {
  const ordered = {
    schema_version:    String(fields.schema_version    || '1.0').trim(),
    issuer_id:         String(fields.issuer_id         || '').trim(),
    student_ref_token: String(fields.student_ref_token || '').trim(),
    name:              String(fields.name              || '').trim().toUpperCase(),
    degree:            String(fields.degree            || '').trim().toUpperCase(),
    branch:            String(fields.branch            || '').trim().toUpperCase(),
    credential_type:   String(fields.credential_type   || '').trim().toUpperCase(),
    cgpa:              String(fields.cgpa              || '').trim(),
    graduation_year:   String(fields.graduation_year   || '').trim(),
    issue_date:        String(fields.issue_date        || '').trim(),
  };
  return JSON.stringify(ordered, null, 0);
}

/** SHA-256 hex digest of a string */
function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Build canonical JSON and hash it */
function hashCredential(fields) {
  const canonical = buildCanonicalJson(fields);
  return { canonical, hash: sha256(canonical) };
}

// ─── Ed25519 ──────────────────────────────────────────────────────────────────
/**
 * Generate an Ed25519 key pair.
 * Returns { privateKeyHex, publicKeyHex }
 * Private key is the raw 32-byte seed stored as hex.
 * Public key is the raw 32-byte public key as hex.
 */
function generateEd25519KeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  // Export raw private key bytes (32-byte seed)
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
  // PKCS8 Ed25519 private key: last 32 bytes are the seed
  const privateKeyHex = privRaw.slice(-32).toString('hex');

  // Export raw public key bytes (32 bytes)
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyHex = pubRaw.slice(-32).toString('hex');

  return { privateKeyHex, publicKeyHex };
}

/** Sign a message string with Ed25519 private key (hex seed) */
function signEd25519(message, privateKeyHex) {
  // Reconstruct full PKCS8 Ed25519 private key from 32-byte seed
  // PKCS8 header for Ed25519: 302e020100300506032b657004220420 (16 bytes) + 32-byte seed
  const seed = Buffer.from(privateKeyHex, 'hex');
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Header, seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
  return sig.toString('base64');
}

/** Verify an Ed25519 signature. publicKeyHex = 32-byte raw public key as hex */
function verifyEd25519(message, signatureBase64, publicKeyHex) {
  try {
    // Reconstruct SPKI public key from raw 32-byte public key
    // SPKI header for Ed25519: 302a300506032b6570032100 (12 bytes) + 32-byte public key
    const pubBytes = Buffer.from(publicKeyHex, 'hex');
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiHeader, pubBytes]);
    const publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  } catch (err) {
    console.warn('[crypto] Ed25519 signature verification error:', err.message);
    return false;
  }
}

// ─── AES-256-GCM (AuthenX Code) ───────────────────────────────────────────────
// Persist AES key to file so AuthenX Codes survive server restarts
const AES_KEY = (() => {
  if (process.env.AES_KEY_HEX) return Buffer.from(process.env.AES_KEY_HEX, 'hex');
  const _fs = require('node:fs');
  const _path = require('node:path');
  const keyFile = _path.join(process.cwd(), 'aes_key.json');
  try {
    if (_fs.existsSync(keyFile)) {
      const data = JSON.parse(_fs.readFileSync(keyFile, 'utf8'));
      if (data.aes_key_hex) return Buffer.from(data.aes_key_hex, 'hex');
    }
  } catch (err) {
    console.warn('[crypto] Could not load AES key from file, generating new:', err.message);
  }
  const hex = crypto.randomBytes(32).toString('hex');
  try { _fs.writeFileSync(keyFile, JSON.stringify({ aes_key_hex: hex, generated: new Date().toISOString() }, null, 2)); }
  catch (err) {
    console.warn('[crypto] Could not persist AES key to file (key lives in memory only):', err.message);
  }
  return Buffer.from(hex, 'hex');
})();

/** Encrypt a JS object into an AuthenX Code string (base64url) */
function encryptCode(payload) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, nonce);
  const pt = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: nonce(12) + tag(16) + ciphertext — all base64url
  const combined = Buffer.concat([nonce, tag, ct]);
  return 'AX1.' + combined.toString('base64url');
}

/** Decrypt an AuthenX Code string back to JS object */
function decryptCode(code) {
  if (!code.startsWith('AX1.')) throw new Error('Invalid AuthenX Code prefix');
  const combined = Buffer.from(code.slice(4), 'base64url');
  const nonce = combined.slice(0, 12);
  const tag   = combined.slice(12, 28);
  const ct    = combined.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ─── Generic Secret Encryption (for private keys, DB passwords, etc.) ────────
/** Encrypt an arbitrary plaintext string using AES-256-GCM. Returns base64. */
function encryptSecret(plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, nonce);
  const pt = Buffer.from(plaintext, 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString('base64');
}

/** Decrypt a base64 string produced by encryptSecret. */
function decryptSecret(encrypted) {
  const combined = Buffer.from(encrypted, 'base64');
  const nonce = combined.slice(0, 12);
  const tag   = combined.slice(12, 28);
  const ct    = combined.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Generate a secure random temporary password (16 chars, mixed case + symbols). */
function generateTempPassword() {
  const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower  = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const syms   = '!@#$%';
  const all    = upper + lower + digits + syms;
  // Guarantee at least one of each character class
  let pwd = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    syms[crypto.randomInt(syms.length)],
  ];
  for (let i = 4; i < 16; i++) pwd.push(all[crypto.randomInt(all.length)]);
  // Fisher-Yates shuffle
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join('');
}

// ─── Nonce (replay resistance) ────────────────────────────────────────────────
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── JWT (built-in, no jsonwebtoken pkg) ─────────────────────────────────────
// JWT_SECRET must be set in production. In development it is persisted to
// aes_key.json so sessions survive server restarts.
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
  }

  // Development: persist alongside AES key so JWTs survive restarts
  const _fs   = require('node:fs');
  const _path = require('node:path');
  const keyFile = _path.join(process.cwd(), 'aes_key.json');
  try {
    if (_fs.existsSync(keyFile)) {
      const data = JSON.parse(_fs.readFileSync(keyFile, 'utf8'));
      if (data.jwt_secret) return data.jwt_secret;
    }
  } catch (err) {
    console.warn('[crypto] Could not load JWT secret from file, generating new:', err.message);
  }

  const secret = crypto.randomBytes(64).toString('hex');
  try {
    const existing = _fs.existsSync(keyFile)
      ? JSON.parse(_fs.readFileSync(keyFile, 'utf8'))
      : {};
    existing.jwt_secret = secret;
    existing.generated  = new Date().toISOString();
    _fs.writeFileSync(keyFile, JSON.stringify(existing, null, 2));
  } catch (err) {
    console.warn('[crypto] Could not persist JWT secret to file:', err.message);
  }
  console.warn('[auth] JWT_SECRET generated and persisted to aes_key.json (dev only)');
  return secret;
})();

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signJwt(payload, expiresInSeconds = 900) { // 15 minutes (short-lived)
  const jti = crypto.randomUUID(); // unique JWT ID for revocation support
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = base64urlEncode(Buffer.from(JSON.stringify({
    ...payload,
    jti,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })));
  const sig = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const [header, body, sig] = parts;
  
  const expected = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid JWT signature');
  }
  
  const payload = JSON.parse(base64urlDecode(body).toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('JWT expired');
  // Check if this JWT has been revoked
  if (payload.jti && isJwtRevoked(payload.jti)) {
    throw new Error('JWT has been revoked');
  }
  return payload;
}

// ─── bcrypt-style password hashing using built-in scrypt ─────────────────────
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex') === hash);
    });
  });
}

// ─── Refresh Token ────────────────────────────────────────────────────────────
function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── JWT Revocation List (in-memory) ──────────────────────────────────────────
const revokedJwtIds = new Set();

function revokeJwtId(jti) {
  revokedJwtIds.add(jti);
}

function isJwtRevoked(jti) {
  return revokedJwtIds.has(jti);
}

// Cleanup old revoked JTIs every 30 minutes to prevent memory leak
setInterval(() => {
  // In production, you'd check expiry. For now, just cap at 10000 entries.
  if (revokedJwtIds.size > 10000) revokedJwtIds.clear();
}, 1800000).unref();

module.exports = {
  buildCanonicalJson,
  sha256,
  hashCredential,
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
  encryptCode,
  decryptCode,
  encryptSecret,
  decryptSecret,
  generateTempPassword,
  generateNonce,
  signJwt,
  verifyJwt,
  hashPassword,
  verifyPassword,
  generateRefreshToken,
  hashRefreshToken,
  revokeJwtId,
  isJwtRevoked,
};
