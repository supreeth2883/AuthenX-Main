# CLAUDE.md

- codex will review this file after the changes.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

AuthenX is a **privacy-first academic credential verification platform** for Indian colleges. The core design principle: student data never leaves college ERP systems. AuthenX stores only cryptographic proofs (hashes + Ed25519 signatures), never raw academic data.

## Running the Stack

### Active Production Implementation (`authenx-node/`)

```bash
# Terminal 1: Start the HSM (key vault, required first)
cd authenx-hsm && node server.js

# Terminal 2: Start the main server
cd authenx-node && node src/server.js
```

Requires **Node.js 22+** — uses `node:sqlite` built-in. Zero npm dependencies.

### Docker (Full Stack)

```bash
docker-compose up -d
# Starts: main server (:3000) + HSM (:9099)
```

### TypeScript Monorepo (`authenx/`) — In Progress

```bash
cd authenx && npm install
npm run dev          # Runs API + connector + web concurrently
npm run build        # Build all workspaces
npm run db:migrate   # Run DB migrations (PostgreSQL)
```

## Architecture

The system has three tiers communicating over HTTP:

```
Employer/College UI → Main Server (:3000) → College Connectors (external URLs) → HSM (:9099)
```

### Main Server (`authenx-node/`)

- **Zero npm dependencies** — uses only Node.js 22 built-ins (`crypto`, `http`, `sqlite`)
- SQLite database (`authenx.db`) — 17 tables; never stores student names, CGPA, or personal data
- Serves all frontend UIs from `ui/` as static files; routes under `/v1/`
- Multi-tenant: each college has its own Ed25519 keypair and HMAC shared secret

### HSM (`authenx-hsm/`)

- Localhost-only HTTP service on port 9099
- Stores one Ed25519 key pair per college in `keys/{college-id}.json`
- All private keys AES-256-GCM encrypted at rest (HSM_MASTER_KEY)
- No keys ever leave this service — callers send data to sign, receive only the signature
- Endpoints: `POST /sign`, `POST /rotate-key`, `GET /keys`, `GET /health`

### College Connectors (external)

- One HTTP service per college, running at the college's own infrastructure
- URL registered at onboarding time (`colleges.connector_url`)
- Must expose: `GET /health`, `POST /verify` (HMAC-authenticated)
- Bridges college ERP (any DB type) → canonical JSON fingerprint → HSM for signing

### Frontend UIs (`ui/`)

| Directory | Contents |
|-----------|---------|
| `ui/admin/` | `collegeonboarding.html` — 5-step super-admin onboarding wizard |
| `ui/college/` | 11 pages: login, dashboard, issue, tokens, students, audit, security, connector mgmt, disclosure policy, onboarding, code-issued |
| `ui/employer/` | 5 pages: login, verify, verified, revoked, decoding |
| `ui/shared/` | `offline-auth.js`, `authenx-code.js` |

## Cryptography

All crypto is in `authenx-node/src/crypto/index.js` using Node.js built-ins only:

| Algorithm | Use |
|-----------|-----|
| Ed25519 | Per-college credential signing and verification |
| AES-256-GCM | AuthenX Code encryption, private key storage, secret storage |
| SHA-256 | Canonical payload hashing, refresh token hashing |
| HS256 (JWT) | API authentication tokens (15-min expiry + refresh rotation) |
| Scrypt | Password hashing (salt:hash format) |
| HMAC-SHA256 | Inter-service request authentication |
| TOTP (RFC 6238) | MFA — 6-digit codes, ±1 step drift, backup codes |

**AuthenX Code format**: `AX1.<AES-256-GCM base64url>` — contains `{token_id, college_id, student_ref_token, credential_type}`.

**Canonical JSON** (deterministic field order): `schema_version`, `issuer_id`, `student_ref_token`, `name`, `degree`, `branch`, `credential_type`, `cgpa`, `graduation_year`, `issue_date`.

## Verification Flow

1. Employer decodes AuthenX Code → gets `token_id`, `college_id`, `student_ref_token`
2. Main server checks token status in DB (revoked check)
3. Main server sends HMAC-signed request with nonce to the college's connector
4. Connector queries local ERP DB using `student_ref_token`, builds canonical JSON
5. Connector calls HSM (`POST /sign`) with canonical JSON
6. HSM signs with college's Ed25519 private key, returns signature
7. Connector returns signature + minimal fields to main server
8. Main server verifies signature against stored public key → returns `VERIFIED` or `REVOKED`

## Inter-Service Authentication

- **Main Server → Connector**: HMAC-SHA256 (`X-HMAC-Signature` header) using per-college `shared_secret`
- **Connector → Main Server**: same HMAC mechanism
- **All signing**: routed through HSM; private keys never leave `authenx-hsm/`

## College Onboarding (`POST /v1/colleges/onboard`)

Super-admin-only endpoint. One call performs the full onboarding:

1. Creates college record (short_code unique, admin_email unique among college_admin users)
2. Generates Ed25519 keypair — public key stored in `colleges` and `college_keys`; private key AES-encrypted in `college_keys.private_key_enc`
3. Creates `college_admin` user with hashed temp password (`must_change_password=1`)
4. Attempts PostgreSQL provisioning if `PG_PROVISION_HOST` env var is set (non-fatal if unavailable — stored with `provisioned=0`)
5. Stores connector config + field mapping in `college_connector_configs`

Response includes `admin_temp_password` and `shared_secret` — **shown only once**.

## Database Schema (17 tables)

| Table | Purpose |
|-------|---------|
| `colleges` | id, name, short_code, admin_email, public_key_hex, connector_url, connector_port, shared_secret |
| `college_keys` | Ed25519 keypair per college; private_key_enc = AES-256-GCM encrypted |
| `college_postgres_provisioning` | PostgreSQL db_name, db_user, encrypted db_password |
| `college_connector_configs` | ERP type, connector_config_json, field_mapping_json |
| `users` | email, password_hash (scrypt), role, college_id, must_change_password |
| `verification_tokens` | token_id, college_id, student_ref_token, canonical_hash, issuance_signature |
| `verification_requests` | Audit trail of every verification attempt |
| `revocation_events` | Immutable revocation log |
| `disclosure_policies` | Field visibility rules per college |
| `login_attempts` | Login audit trail (lockout enforcement) |
| `refresh_tokens` | OAuth-style refresh token hashes |
| `security_events` | Immutable security event log |
| `mfa_secrets` | TOTP secrets (AES-256-GCM encrypted) |
| `mfa_backup_codes` | TOTP backup codes (SHA-256 hashed) |
| `fraud_alerts` | Behavioral fraud detection alerts |
| `consent_records` | DPDP Act explicit consent records |
| `erasure_requests` | Right-to-erasure requests |

## Test Credentials

| Role | Email | Password |
|------|-------|----------|
| super_admin | admin@authenx.in | Admin@123 |
| college_admin | iitb@authenx.in | College@123 |
| employer | recruiter@infosys.com | Employer@123 |

## Two Parallel Implementations

| | `authenx-node/` | `authenx/` |
|--|----------------|-----------|
| Status | **Active / production** | In progress |
| Runtime | Node 22, zero deps | TypeScript, Fastify |
| DB | SQLite (built-in) | PostgreSQL |
| Frontend | Static HTML in `ui/` | React (Vite) |
| Onboarding | Full wizard backend | — |

Always confirm which implementation the user is working on before making changes.

## Key Files

| File | Purpose |
|------|---------|
| `authenx-node/src/server.js` | Main HTTP server — all route registration, 34+ routes |
| `authenx-node/src/routes/colleges.js` | College CRUD + `onboardCollege()` wizard endpoint |
| `authenx-node/src/routes/verify.js` | Live verification + code decode logic |
| `authenx-node/src/crypto/index.js` | All crypto primitives — Ed25519, AES-GCM, JWT, scrypt, TOTP helpers |
| `authenx-node/src/db/schema.js` | SQLite schema — 17 tables |
| `authenx-node/src/db/client.js` | DB client + auto-migrations |
| `authenx-node/src/middleware/auth.js` | JWT verification + RBAC |
| `authenx-node/src/middleware/hmac-auth.js` | Inter-service HMAC verification |
| `authenx-node/src/middleware/fraud-detector.js` | Behavioral anomaly detection |
| `authenx-node/src/middleware/circuit-breaker.js` | Per-connector resilience |
| `authenx-node/src/middleware/dpdp.js` | India DPDP Act 2023 compliance |
| `authenx-hsm/server.js` | Key vault HTTP service |
| `authenx-hsm/key-store.js` | Ed25519 keypair management with envelope encryption |
| `ui/admin/collegeonboarding.html` | 5-step super-admin onboarding wizard |
| `prd.md` | Full product requirements |
| `CONTEXT.md` | System architecture reference |

## Environment Variables

| Variable | Required in Prod | Description |
|----------|:---:|-------------|
| `JWT_SECRET` | ✅ | HS256 signing key |
| `HSM_MASTER_KEY` | ✅ | AES-256-GCM master key for HSM key encryption |
| `NODE_ENV` | ✅ | Set `production` to enforce required secrets |
| `AES_KEY_HEX` | — | AES key for AuthenX Codes (persisted to aes_key.json in dev) |
| `PORT` | — | Default 3000 |
| `HSM_PORT` | — | Default 9099 |
| `DB_PATH` | — | Default `./authenx.db` |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated allowed origins |
| `LOG_LEVEL` | — | debug/info/warn/error |
| `PG_PROVISION_HOST` | — | Enable PostgreSQL auto-provisioning at onboarding |
| `PG_PROVISION_PORT` | — | Default 5432 |
| `PG_PROVISION_USER` | — | Default postgres |
| `PG_PROVISION_PASSWORD` | — | PostgreSQL admin password |
