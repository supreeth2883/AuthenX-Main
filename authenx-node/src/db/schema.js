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
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_password_change TEXT,
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
    status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','superseded','corrected')),
    revocation_reason   TEXT,
    revoked_at          TEXT,
    issued_at           TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by       TEXT REFERENCES verification_tokens(id),
    correction_token_id TEXT REFERENCES verification_tokens(id),
    verification_count  INTEGER NOT NULL DEFAULT 0,
    last_verified_at    TEXT,
    last_result         TEXT
  );

  CREATE TABLE IF NOT EXISTS disclosure_policies (
    id          TEXT PRIMARY KEY,
    college_id  TEXT NOT NULL REFERENCES colleges(id),
    field_name  TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'always_show' CHECK(visibility IN ('always_show','always_hide','admin_decision')),
    role_filter TEXT NOT NULL DEFAULT 'all',
    require_approval INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(college_id, field_name)
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

  CREATE TABLE IF NOT EXISTS login_attempts (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    ip_address  TEXT,
    success     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS security_events (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    actor_id    TEXT,
    actor_email TEXT,
    target_id   TEXT,
    ip_address  TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mfa_secrets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL UNIQUE REFERENCES users(id),
    secret_enc  TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    code_hash   TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    used_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mfa_user ON mfa_secrets(user_id);
  CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON mfa_backup_codes(user_id);

  CREATE TABLE IF NOT EXISTS fraud_alerts (
    id          TEXT PRIMARY KEY,
    alert_type  TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
    actor_id    TEXT,
    actor_email TEXT,
    ip_address  TEXT,
    details     TEXT,
    resolved    INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_fraud_type      ON fraud_alerts(alert_type);
  CREATE INDEX IF NOT EXISTS idx_fraud_severity  ON fraud_alerts(severity);
  CREATE INDEX IF NOT EXISTS idx_fraud_created   ON fraud_alerts(created_at);

  CREATE INDEX IF NOT EXISTS idx_tokens_college   ON verification_tokens(college_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_student   ON verification_tokens(student_ref_token);
  CREATE INDEX IF NOT EXISTS idx_tokens_status    ON verification_tokens(status);
  CREATE INDEX IF NOT EXISTS idx_disclosure_college ON disclosure_policies(college_id);
  CREATE INDEX IF NOT EXISTS idx_requests_token   ON verification_requests(token_id);
  CREATE INDEX IF NOT EXISTS idx_requests_created ON verification_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_login_email      ON login_attempts(email);
  CREATE INDEX IF NOT EXISTS idx_login_created    ON login_attempts(created_at);
  CREATE INDEX IF NOT EXISTS idx_refresh_user     ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_security_type    ON security_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_security_created ON security_events(created_at);

  CREATE TABLE IF NOT EXISTS consent_records (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    purpose     TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'full',
    granted     INTEGER NOT NULL DEFAULT 1,
    ip_address  TEXT,
    revoked_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS erasure_requests (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    reason       TEXT,
    ip_address   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','rejected')),
    completed_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_consent_user    ON consent_records(user_id);
  CREATE INDEX IF NOT EXISTS idx_consent_purpose ON consent_records(purpose);
  CREATE INDEX IF NOT EXISTS idx_erasure_user    ON erasure_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_erasure_status  ON erasure_requests(status);
`;

module.exports = { SQL_SCHEMA };
