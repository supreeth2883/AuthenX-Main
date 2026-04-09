'use strict';
/**
 * AuthenX Database Schema
 * Uses Node 22 built-in node:sqlite — zero external dependencies
 */

const SQL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS colleges (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    short_code  TEXT NOT NULL UNIQUE,
    public_key_hex TEXT NOT NULL,
    connector_url  TEXT NOT NULL,
    shared_secret  TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('super_admin','college_admin','employer')),
    college_id  TEXT REFERENCES colleges(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS verification_tokens (
    id                  TEXT PRIMARY KEY,
    college_id          TEXT NOT NULL REFERENCES colleges(id),
    student_ref_token   TEXT NOT NULL,
    canonical_hash      TEXT NOT NULL,
    issuance_signature  TEXT NOT NULL,
    schema_version      TEXT NOT NULL DEFAULT '1.0',
    credential_type     TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    revocation_reason   TEXT,
    revoked_at          TEXT,
    issued_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(college_id, student_ref_token)
  );

  CREATE TABLE IF NOT EXISTS verification_requests (
    id              TEXT PRIMARY KEY,
    token_id        TEXT NOT NULL REFERENCES verification_tokens(id),
    employer_id     TEXT,
    employer_name   TEXT,
    request_type    TEXT NOT NULL CHECK(request_type IN ('code_decode','live_verify')),
    result          TEXT NOT NULL CHECK(result IN ('verified','revoked','error')),
    hash_match      INTEGER,
    sig_valid       INTEGER,
    latency_ms      INTEGER,
    nonce           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS revocation_events (
    id          TEXT PRIMARY KEY,
    token_id    TEXT NOT NULL REFERENCES verification_tokens(id),
    reason      TEXT NOT NULL,
    revoked_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_college   ON verification_tokens(college_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_student   ON verification_tokens(student_ref_token);
  CREATE INDEX IF NOT EXISTS idx_requests_token   ON verification_requests(token_id);
  CREATE INDEX IF NOT EXISTS idx_requests_created ON verification_requests(created_at);
`;

module.exports = { SQL_SCHEMA };
