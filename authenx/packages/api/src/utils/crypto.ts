/**
 * AuthenX API — Cryptographic Utilities
 *
 * Handles:
 *  - Canonical fingerprint creation (deterministic JSON for hashing)
 *  - SHA-256 hashing
 *  - Ed25519 signature verification (verifying connector signatures)
 *  - AuthenX Code payload encryption/decryption (AES-256-GCM)
 *  - Nonce generation (for replay-resistance in live verification)
 *
 * This file ONLY runs on the API side.
 * The CONNECTOR has its own crypto.ts for signing with the college private key.
 */

import crypto from 'crypto';
import nacl from 'tweetnacl';
import { env } from '../config/env.js';

// ─── Canonical Fingerprint ────────────────────────────────────────────────────

export interface CanonicalCredential {
  schema_version: string;
  issuer_id: string;
  student_ref_token: string;
  name: string;
  degree: string;
  branch: string;
  credential_type: string;
  cgpa: string;
  graduation_year: string;
  issue_date: string;
}

/**
 * Builds a canonical JSON string from a credential object.
 * Field order is FIXED — must match the connector's canonicalize function exactly.
 * Any change to field order will break hash verification.
 */
export function buildCanonicalJson(credential: CanonicalCredential): string {
  const ordered: CanonicalCredential = {
    schema_version:     credential.schema_version.trim(),
    issuer_id:          credential.issuer_id.trim(),
    student_ref_token:  credential.student_ref_token.trim(),
    name:               credential.name.trim().toUpperCase(),
    degree:             credential.degree.trim().toUpperCase(),
    branch:             credential.branch.trim().toUpperCase(),
    credential_type:    credential.credential_type.trim().toUpperCase(),
    cgpa:               credential.cgpa.trim(),
    graduation_year:    credential.graduation_year.trim(),
    issue_date:         credential.issue_date.trim(),
  };
  return JSON.stringify(ordered);
}

// ─── SHA-256 Hash ─────────────────────────────────────────────────────────────

/**
 * Computes SHA-256 hash of a string.
 * Returns hex string.
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hashes a canonical credential JSON string.
 * This is the "issued_hash" stored in the proof token.
 */
export function hashCanonical(canonicalJson: string): string {
  return sha256(canonicalJson);
}

// ─── Ed25519 Signature Verification ──────────────────────────────────────────

/**
 * Verifies an Ed25519 signature from the connector.
 *
 * @param message   - The message that was signed (e.g., issued_hash or verification response JSON)
 * @param signature - Base64-encoded signature from connector
 * @param publicKey - Hex-encoded Ed25519 public key registered by college
 */
export function verifyEd25519Signature(
  message: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    const messageBytes = Buffer.from(message, 'utf8');
    const signatureBytes = Buffer.from(signature, 'base64');
    const publicKeyBytes = Buffer.from(publicKey, 'hex');

    return nacl.sign.detached.verify(
      new Uint8Array(messageBytes),
      new Uint8Array(signatureBytes),
      new Uint8Array(publicKeyBytes)
    );
  } catch {
    return false;
  }
}

// ─── Nonce Generation (Replay Resistance) ────────────────────────────────────

/**
 * Generates a secure random nonce for each verification request.
 * The connector must include this nonce in its signed response,
 * binding the response to this specific request.
 */
export function generateNonce(): string {
  return 'nonce_' + crypto.randomBytes(16).toString('hex');
}

// ─── AuthenX Code Encryption ─────────────────────────────────────────────────

const CODE_KEY = Buffer.from(env.AUTHENX_CODE_ENCRYPTION_KEY, 'hex'); // 32 bytes for AES-256

export interface AuthenXCodePayload {
  v: number;         // format version
  t: string;         // token_id (opaque)
  i: string;         // issuer_id hint
  ts: number;        // unix timestamp of issuance
}

/**
 * Encrypts the AuthenX Code payload using AES-256-GCM.
 * Returns a base64-encoded string containing: iv + authTag + ciphertext
 */
export function encryptCodePayload(payload: AuthenXCodePayload): string {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', CODE_KEY, iv);

  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Combine: iv (12 bytes) + authTag (16 bytes) + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64url');
}

/**
 * Decrypts an AuthenX Code payload.
 * Throws if decryption fails (tampered or invalid code).
 */
export function decryptCodePayload(encryptedCode: string): AuthenXCodePayload {
  const combined = Buffer.from(encryptedCode, 'base64url');
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', CODE_KEY, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8')) as AuthenXCodePayload;
}

// ─── Integrity Checksum ───────────────────────────────────────────────────────

/**
 * Generates a short checksum for the AuthenX Code payload.
 * First 8 characters of SHA-256 over the payload JSON.
 */
export function generateChecksum(payload: AuthenXCodePayload): string {
  return sha256(JSON.stringify(payload)).substring(0, 8);
}
