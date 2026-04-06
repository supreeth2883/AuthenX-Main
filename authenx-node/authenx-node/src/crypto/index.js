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
  } catch {
    return false;
  }
}

// ─── AES-256-GCM (AuthenX Code) ───────────────────────────────────────────────
const AES_KEY = Buffer.from(
  process.env.AES_KEY_HEX || crypto.randomBytes(32).toString('hex'),
  'hex'
);

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

// ─── Nonce (replay resistance) ────────────────────────────────────────────────
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── JWT (built-in, no jsonwebtoken pkg) ─────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signJwt(payload, expiresInSeconds = 86400) {
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = base64urlEncode(Buffer.from(JSON.stringify({
    ...payload,
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
  if (sig !== expected) throw new Error('Invalid JWT signature');
  const payload = JSON.parse(base64urlDecode(body).toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('JWT expired');
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

module.exports = {
  buildCanonicalJson,
  sha256,
  hashCredential,
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
  encryptCode,
  decryptCode,
  generateNonce,
  signJwt,
  verifyJwt,
  hashPassword,
  verifyPassword,
};
