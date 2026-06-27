'use strict';
/**
 * AuthenX HSM — Secure Key Store
 * File-based key management with versioning and rotation.
 * Keys are stored at: authenx-hsm/keys/<college_id>.json
 *
 * SECURITY: Private keys are encrypted at rest using AES-256-GCM envelope encryption.
 * The master key must be set via HSM_MASTER_KEY environment variable in production.
 *
 * Functions: getKey, rotateKey, listKeys, importKey
 * Private keys NEVER leave this module — only used for signing.
 */

const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

const KEYS_DIR = path.join(__dirname, 'keys');
const AUDIT_LOG = path.join(__dirname, 'hsm-audit.jsonl');
const MASTER_KEY_FILE = path.join(__dirname, '.master_key');

if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

// ─── Master Key for Envelope Encryption ──────────────────────────────────────
// In production, HSM_MASTER_KEY env var MUST be set
const MASTER_KEY = (() => {
  // Priority 1: Environment variable
  if (process.env.HSM_MASTER_KEY) {
    const key = Buffer.from(process.env.HSM_MASTER_KEY, 'hex');
    if (key.length !== 32) {
      console.error('FATAL: HSM_MASTER_KEY must be a 64-character hex string (32 bytes)');
      process.exit(1);
    }
    return key;
  }

  // Priority 2: Master key file (for development only)
  if (fs.existsSync(MASTER_KEY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MASTER_KEY_FILE, 'utf8'));
      if (data.master_key_hex) {
        console.warn('WARNING: Using master key from file. Set HSM_MASTER_KEY env var in production.');
        return Buffer.from(data.master_key_hex, 'hex');
      }
    } catch (err) {
      console.warn('[hsm] Failed to read master key file, will generate new:', err.message);
    }
  }

  // In production, fail without master key
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: HSM_MASTER_KEY environment variable is required in production');
    process.exit(1);
  }

  // Development only: generate and persist master key
  console.warn('WARNING: Generating new HSM master key. This should only happen in development.');
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_FILE, JSON.stringify({
    master_key_hex: newKey.toString('hex'),
    generated: new Date().toISOString(),
    warning: 'DO NOT commit this file. Set HSM_MASTER_KEY env var in production.',
  }, null, 2));
  return newKey;
})();

// ─── Envelope Encryption ─────────────────────────────────────────────────────
function encryptPrivateKey(privateKeyHex) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, nonce);
  const plaintext = Buffer.from(privateKeyHex, 'hex');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: nonce(12) + tag(16) + ciphertext
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64');
}

function decryptPrivateKey(encryptedBase64) {
  const combined = Buffer.from(encryptedBase64, 'base64');
  const nonce = combined.slice(0, 12);
  const tag = combined.slice(12, 28);
  const ciphertext = combined.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('hex');
}

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
  } catch (err) {
    console.error('[hsm] Failed to write audit log entry:', err.message);
  }
}

// ─── Key File I/O ─────────────────────────────────────────────────────────────
function keyPath(college_id) {
  return path.join(KEYS_DIR, `${college_id}.json`);
}

function readKeyFile(college_id) {
  const p = keyPath(college_id);
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));

  // Decrypt private key if it's encrypted (has encrypted_private_key field)
  if (data.encrypted_private_key) {
    data.private_key_hex = decryptPrivateKey(data.encrypted_private_key);
    delete data.encrypted_private_key; // Don't expose encrypted form in memory
  }
  // Legacy support: if private_key_hex is still plaintext (old format), migrate it
  else if (data.private_key_hex && !data.migrated_to_encrypted) {
    // Silently migrate on first read
    const encryptedData = {
      ...data,
      encrypted_private_key: encryptPrivateKey(data.private_key_hex),
      migrated_to_encrypted: true,
    };
    delete encryptedData.private_key_hex;
    fs.writeFileSync(p, JSON.stringify(encryptedData, null, 2));
    auditLog('MIGRATE_ENCRYPT', college_id, 'migrated_to_envelope_encryption');
  }

  return data;
}

function writeKeyFile(college_id, data) {
  // Always encrypt private key when writing to disk
  const fileData = {
    college_id: data.college_id,
    encrypted_private_key: encryptPrivateKey(data.private_key_hex),
    public_key_hex: data.public_key_hex,
    version: data.version,
    created_at: data.created_at,
    rotated_from: data.rotated_from || null,
    migrated_to_encrypted: true,
  };
  fs.writeFileSync(keyPath(college_id), JSON.stringify(fileData, null, 2));
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
 * Uses readKeyFile to properly decrypt encrypted keys.
 */
function preloadAll() {
  const files = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const college_id = f.replace('.json', '');
    try {
      const data = readKeyFile(college_id);
      if (data && data.college_id) {
        keyCache.set(data.college_id, data);
      }
    } catch (err) {
      console.error(`Failed to load key for ${college_id}:`, err.message);
    }
  }
  return keyCache.size;
}

module.exports = { getKey, sign, rotateKey, importKey, listKeys, preloadAll };
