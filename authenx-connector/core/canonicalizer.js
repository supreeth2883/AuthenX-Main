'use strict';
/**
 * AuthenX Connector — Canonicalizer
 * Builds the canonical JSON string that gets hashed and signed.
 * MUST match exactly the buildCanonicalJson() in authenx-node/src/crypto/index.js
 *
 * Rules:
 *  - Fixed field order (schema guarantees determinism)
 *  - All fields are strings (numbers converted)
 *  - All string values are trimmed
 *  - name, degree, branch, credential_type → UPPERCASE
 *  - No pretty-print (no spaces/newlines in output)
 */
const { createHash } = require('node:crypto');

const FIELD_ORDER = [
  'schema_version',
  'issuer_id',
  'student_ref_token',
  'name',
  'degree',
  'branch',
  'credential_type',
  'cgpa',
  'graduation_year',
  'issue_date',
];

const UPPERCASE_FIELDS = new Set(['name', 'degree', 'branch', 'credential_type']);

function buildCanonicalJson(fields) {
  const ordered = {};
  for (const key of FIELD_ORDER) {
    let val = String(fields[key] ?? '').trim();
    if (UPPERCASE_FIELDS.has(key)) val = val.toUpperCase();
    ordered[key] = val;
  }
  return JSON.stringify(ordered);
}

function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function buildAndHash(fields) {
  const canonical = buildCanonicalJson(fields);
  return { canonical, hash: sha256(canonical) };
}

module.exports = { buildCanonicalJson, sha256, buildAndHash };
