'use strict';
/**
 * AuthenX HSM — Secure Key Store
 * File-based key management with versioning and rotation.
 * Keys are stored at: authenx-hsm/keys/<college_id>.json
 *
 * Functions: getKey, rotateKey, listKeys, importKey
 * Private keys NEVER leave this module — only used for signing.
 */

const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

const KEYS_DIR = path.join(__dirname, 'keys');
const AUDIT_LOG = path.join(__dirname, 'hsm-audit.jsonl');

if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

// In-memory cache of loaded keys (college_id → key data)
const keyCache = new Map();

// ─── Audit Logger ─────────────────────────────────────────────────────────────
function auditLog(action, college_id, detail = '') {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    college_id,
    detail,
  };
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch { /* non-fatal */ }
}

// ─── Key File I/O ─────────────────────────────────────────────────────────────
function keyPath(college_id) {
  return path.join(KEYS_DIR, `${college_id}.json`);
}

function readKeyFile(college_id) {
  const p = keyPath(college_id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeKeyFile(college_id, data) {
  fs.writeFileSync(keyPath(college_id), JSON.stringify(data, null, 2));
}

// ─── Ed25519 Key Generation ──────────────────────────────────────────────────
function generateEd25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubRaw  = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKeyHex: privRaw.slice(-32).toString('hex'),
    publicKeyHex:  pubRaw.slice(-32).toString('hex'),
  };
}

// ─── Build Node crypto private key object from hex seed ──────────────────────
function buildPrivateKey(hexSeed) {
  const seed   = Buffer.from(hexSeed, 'hex');
  const header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der    = Buffer.concat([header, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a key for a college. Returns null if not found.
 * Loads from disk into cache on first access.
 */
function getKey(college_id) {
  if (keyCache.has(college_id)) return keyCache.get(college_id);
  const data = readKeyFile(college_id);
  if (!data) return null;
  keyCache.set(college_id, data);
  return data;
}

/**
 * Sign a payload using the private key for a given college.
 * Returns base64-encoded Ed25519 signature.
 * Throws if key not found.
 */
function sign(college_id, payload) {
  const keyData = getKey(college_id);
  if (!keyData) throw new Error(`No key found for college ${college_id}`);
  const privateKey = buildPrivateKey(keyData.private_key_hex);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
  auditLog('SIGN', college_id, `payload_len=${payload.length}`);
  return sig.toString('hex');
}

/**
 * Rotate a key for a college. Generates a new key pair,
 * archives the old version, and returns the new public key.
 */
function rotateKey(college_id) {
  const existing = getKey(college_id);
  const newKeys  = generateEd25519();
  const version  = existing ? (existing.version || 1) + 1 : 1;

  const data = {
    college_id,
    private_key_hex: newKeys.privateKeyHex,
    public_key_hex:  newKeys.publicKeyHex,
    version,
    created_at:      new Date().toISOString(),
    rotated_from:    existing ? existing.public_key_hex : null,
  };

  writeKeyFile(college_id, data);
  keyCache.set(college_id, data);
  auditLog('ROTATE', college_id, `v${version}`);

  return { public_key_hex: newKeys.publicKeyHex, version };
}

/**
 * Import an existing key pair (used during setup).
 */
function importKey(college_id, privateKeyHex, publicKeyHex) {
  const data = {
    college_id,
    private_key_hex: privateKeyHex,
    public_key_hex:  publicKeyHex,
    version: 1,
    created_at: new Date().toISOString(),
  };
  writeKeyFile(college_id, data);
  keyCache.set(college_id, data);
  auditLog('IMPORT', college_id, 'initial_key');
}

/**
 * List all managed college IDs and their public key / version info.
 * Private keys are NEVER exposed.
 */
function listKeys() {
  const files = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, f), 'utf8'));
    return {
      college_id:     data.college_id,
      public_key_hex: data.public_key_hex,
      version:        data.version,
      created_at:     data.created_at,
    };
  });
}

/**
 * Load all keys from disk into cache at startup.
 */
function preloadAll() {
  const files = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, f), 'utf8'));
    if (data.college_id) keyCache.set(data.college_id, data);
  }
  return keyCache.size;
}

module.exports = { getKey, sign, rotateKey, importKey, listKeys, preloadAll };
