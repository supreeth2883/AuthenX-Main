-- ═══════════════════════════════════════════════════════════════════════════
-- AuthenX Initial Database Schema — Migration 001
-- Run this first. Creates all core tables.
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── colleges ────────────────────────────────────────────────────────────────
-- Registered issuer institutions (colleges / universities)
-- AuthenX never stores student academic data here — only issuer metadata.

CREATE TABLE IF NOT EXISTS colleges (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    issuer_code         VARCHAR(20) UNIQUE NOT NULL,     -- Short code, e.g. 'CVR001'
    connector_type      VARCHAR(20) NOT NULL              -- 'db' | 'api' | 'view' | 'event'
                            CHECK (connector_type IN ('db', 'api', 'view', 'event')),
    connector_endpoint  TEXT NOT NULL,                   -- URL or internal endpoint of connector
    public_key          TEXT NOT NULL,                   -- Ed25519 public key (hex-encoded)
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'suspended')),
    onboarded_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_colleges_issuer_code ON colleges(issuer_code);
CREATE INDEX idx_colleges_status ON colleges(status);

-- ─── users ───────────────────────────────────────────────────────────────────
-- All platform users: admins, college operators, employers, auditors

CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               VARCHAR(200) UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    full_name           VARCHAR(200),
    role                VARCHAR(30) NOT NULL
                            CHECK (role IN ('super_admin', 'college_admin', 'issuer_operator', 'employer', 'auditor')),
    linked_entity_id    UUID,                            -- college id or employer org id
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'suspended', 'pending_verification')),
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_linked_entity ON users(linked_entity_id);

-- ─── verification_tokens ──────────────────────────────────────────────────────
-- Cryptographic proof tokens issued for each credential.
-- IMPORTANT: This table stores PROOF, not student academic data.
-- No student name, CGPA, or academic fields stored here permanently.

CREATE TABLE IF NOT EXISTS verification_tokens (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id                    VARCHAR(64) UNIQUE NOT NULL,  -- Opaque, random — this goes in the AuthenX Code
    issuer_id                   UUID NOT NULL REFERENCES colleges(id),
    credential_reference_token  TEXT NOT NULL,                -- Opaque reference to student in ERP (not student ID directly)
    issued_hash                 TEXT NOT NULL,                -- SHA-256 of canonical fingerprint
    issuance_signature          TEXT NOT NULL,                -- Ed25519 signature from connector (base64)
    schema_version              VARCHAR(10) NOT NULL DEFAULT '1.0',
    credential_type             VARCHAR(50) NOT NULL,         -- 'FINAL_DEGREE' | 'PROVISIONAL' | etc.
    issued_at                   TIMESTAMPTZ NOT NULL,
    token_status                VARCHAR(20) NOT NULL DEFAULT 'active'
                                    CHECK (token_status IN ('active', 'revoked', 'superseded', 'suspended')),
    revocation_status           BOOLEAN NOT NULL DEFAULT FALSE,
    authenx_code_ref            TEXT,                         -- Encrypted AuthenX Code string
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vtokens_token_id ON verification_tokens(token_id);
CREATE INDEX idx_vtokens_issuer_id ON verification_tokens(issuer_id);
CREATE INDEX idx_vtokens_status ON verification_tokens(token_status);
CREATE INDEX idx_vtokens_credential_ref ON verification_tokens(credential_reference_token);

-- ─── verification_requests ───────────────────────────────────────────────────
-- Audit log of every employer verification request.
-- Provides full traceability without storing student data.

CREATE TABLE IF NOT EXISTS verification_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id              VARCHAR(64) UNIQUE NOT NULL,
    token_id                UUID NOT NULL REFERENCES verification_tokens(id),
    employer_id             UUID NOT NULL REFERENCES users(id),
    nonce                   TEXT NOT NULL,                    -- Challenge nonce sent to connector
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at            TIMESTAMPTZ,
    result_status           VARCHAR(20)
                                CHECK (result_status IN ('verified', 'revoked', 'mismatch', 'unavailable', 'pending')),
    latency_ms              INTEGER,
    live_check_performed    BOOLEAN NOT NULL DEFAULT TRUE,
    connector_signature     TEXT,                             -- Live verification signature from connector
    audit_meta              JSONB DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vrequests_token_id ON verification_requests(token_id);
CREATE INDEX idx_vrequests_employer_id ON verification_requests(employer_id);
CREATE INDEX idx_vrequests_result_status ON verification_requests(result_status);
CREATE INDEX idx_vrequests_requested_at ON verification_requests(requested_at DESC);

-- ─── revocation_events ────────────────────────────────────────────────────────
-- Immutable log of all revocations and replacements.

CREATE TABLE IF NOT EXISTS revocation_events (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id                UUID NOT NULL REFERENCES verification_tokens(id),
    issuer_id               UUID NOT NULL REFERENCES colleges(id),
    reason                  TEXT,
    revoked_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replacement_token_id    UUID REFERENCES verification_tokens(id),
    created_by              UUID REFERENCES users(id)
);

CREATE INDEX idx_revocations_token_id ON revocation_events(token_id);
CREATE INDEX idx_revocations_issuer_id ON revocation_events(issuer_id);

-- ─── migrations tracker ───────────────────────────────────────────────────────
-- Tracks which migrations have run (simple migration system)

CREATE TABLE IF NOT EXISTS _migrations (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) UNIQUE NOT NULL,
    run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO _migrations (name) VALUES ('001_initial_schema') ON CONFLICT DO NOTHING;

-- ─── Updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_colleges_updated_at
    BEFORE UPDATE ON colleges
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vtokens_updated_at
    BEFORE UPDATE ON verification_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
