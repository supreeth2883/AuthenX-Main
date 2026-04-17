# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

AuthenX is a **privacy-first academic credential verification platform** for Indian colleges. The core design principle: student data never leaves college ERP systems. AuthenX stores only cryptographic proofs (hashes + Ed25519 signatures), never raw academic data.

## Current Branch State (`backend-change`)

⚠️ **This branch has structural changes from `main`:**
- ❌ `authenx-connector/` deleted — live verification cannot work without an external connector
- ❌ `authenx-ledger/` deleted
- ❌ `authenx/` (TypeScript monorepo) deleted
- ❌ `docker-compose.yml`, `Dockerfile`, `Dockerfile.connector` deleted
- ✅ `authenx-node/` (main server) — active and production-grade
- ✅ `authenx-hsm/` (HSM key vault) — active
- ✅ `ui/` (all frontends) — active

**Without connectors, `POST /v1/verify/live` cannot work** — except for CVR College which has an in-process mock ERP (`src/mock-erp/cvr-erp.js`).

## Running the Stack

```bash
# Terminal 1: Start the HSM (key vault, required first)
cd authenx-hsm && node server.js

# Terminal 2: Start the main server
cd authenx-node && node src/server.js
```

Or use the PowerShell startup script: `start-backend-stack.ps1`

Requires **Node.js 22+**. One npm dependency: `pg` (PostgreSQL driver — main AuthenX DB, mock ERP, and college DB provisioning).

- Main app + web UI: http://localhost:3000
- HSM: http://localhost:9099
- UI files served at: http://localhost:3000/ui/...

## Architecture

```
Employer/College UI → Main Server (:3000) → College Connectors (external, DELETED) → HSM (:9099)
```

### Main Server (`authenx-node/`)

- One npm dependency: `pg` — PostgreSQL driver used by `db/client.js` (main DB), `mock-erp/cvr-erp.js` (CVR mock), and `routes/colleges.js` (provisioning)
- PostgreSQL database (`AUTHENX_PG_*` env vars) — 18 tables; never stores student names, CGPA, or personal data
- Serves all frontend UIs from `ui/` as static files under `/ui/`; API routes under `/v1/`
- Multi-tenant: each college has its own Ed25519 keypair and HMAC shared secret
- Built-in verification cache (`src/cache/verification-cache.js`): 30s TTL for verified results, 5s for revoked

### HSM (`authenx-hsm/`)

- Localhost-only HTTP service on port 9099
- Stores one Ed25519 key pair per college in `keys/{college-id}.json`
- All private keys AES-256-GCM encrypted at rest (`HSM_MASTER_KEY`)
- No keys ever leave this service — callers send data to sign, receive only the signature
- Endpoints: `POST /sign`, `POST /rotate-key`, `GET /keys`, `GET /health`

### College Connectors (external — deleted on this branch)

- One HTTP service per college, running at the college's own infrastructure
- URL registered at onboarding time (`colleges.connector_url`)
- Must expose: `GET /health`, `POST /verify` (HMAC-authenticated)
- Bridges college ERP → canonical JSON fingerprint → HSM for signing
- **CVR College exception:** has an in-process mock (`src/mock-erp/cvr-erp.js`) backed by PostgreSQL

### Frontend UIs (`ui/`)

| Directory | Contents |
|-----------|---------|
| `ui/admin/` | `collegeonboarding.html` — 5-step super-admin onboarding wizard |
| `ui/college/` | 11 pages: login, dashboard, issue, tokens, students, audit, security, connector mgmt, disclosure policy, onboarding, code-issued |
| `ui/employer/` | 5 pages: login, verify, verified, revoked, decoding |
| `ui/shared/` | `offline-auth.js`, `authenx-code.js` |
| `ui/test/` | `visual-code-test.html` |

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

1. Creates college record (`short_code` unique, `admin_email` unique among college_admin users)
2. Generates Ed25519 keypair — public key stored in `colleges` and `college_keys`; private key AES-encrypted in `college_keys.private_key_enc`
3. Creates `college_admin` user with hashed temp password (`must_change_password=1`)
4. Attempts PostgreSQL provisioning if `PG_PROVISION_HOST` env var is set (non-fatal if unavailable — stored with `provisioned=0`)
5. Stores connector config + field mapping in `college_connector_configs`

Response includes `admin_temp_password` and `shared_secret` — **shown only once**.

## Database Schema (18 tables)

| Table | Purpose |
|-------|---------|
| `colleges` | id, name, short_code, admin_email, public_key_hex, connector_url, connector_port, shared_secret |
| `college_keys` | Ed25519 keypair per college; private_key_enc = AES-256-GCM encrypted |
| `college_postgres_provisioning` | PostgreSQL db_name, db_user, encrypted db_password |
| `college_connector_configs` | ERP type, connector_config_json, field_mapping_json, onboarding_completed |
| `users` | email, password_hash (scrypt), role, college_id, must_change_password |
| `verification_tokens` | token_id, college_id, student_ref_token, canonical_hash, issuance_signature, status |
| `issued_authenx_codes` | Encrypted AuthenX codes stored for student code re-fetch |
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

All seeded accounts have `must_change_password = 1` — password change enforced on first login.

## Key Files

| File | Purpose |
|------|---------|
| `authenx-node/src/server.js` | Main HTTP server — all route registration (~45 routes) |
| `authenx-node/src/routes/colleges.js` | College CRUD + `onboardCollege()` wizard endpoint |
| `authenx-node/src/routes/verify.js` | Live verification + code decode logic |
| `authenx-node/src/routes/connector-proxy.js` | Server-side HMAC proxy to college connectors |
| `authenx-node/src/crypto/index.js` | All crypto primitives — Ed25519, AES-GCM, JWT, scrypt, TOTP helpers |
| `authenx-node/src/db/schema.js` | PostgreSQL DDL — 18 tables |
| `authenx-node/src/db/client.js` | pg.Pool client + initDb() |
| `authenx-node/src/middleware/auth.js` | JWT verification + RBAC |
| `authenx-node/src/middleware/hmac-auth.js` | Inter-service HMAC verification |
| `authenx-node/src/middleware/fraud-detector.js` | Behavioral anomaly detection |
| `authenx-node/src/middleware/circuit-breaker.js` | Per-connector resilience |
| `authenx-node/src/middleware/rate-limiter.js` | Sliding window rate limiter (verify: 30/min/user, issue: 20/min/college) |
| `authenx-node/src/middleware/dpdp.js` | India DPDP Act 2023 compliance |
| `authenx-node/src/cache/verification-cache.js` | Short-lived in-memory verification result cache |
| `authenx-node/src/mock-erp/cvr-erp.js` | PostgreSQL-backed mock ERP for CVR College (CVRH) |
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
| `AES_KEY_HEX` | — | AES key for AuthenX Codes (persisted to `aes_key.json` in dev) |
| `PORT` | — | Default 3000 |
| `HSM_PORT` | — | Default 9099 |
| `AUTHENX_PG_HOST` | — | Default localhost |
| `AUTHENX_PG_PORT` | — | Default 5432 |
| `AUTHENX_PG_USER` | — | Default postgres |
| `AUTHENX_PG_PASSWORD` | ✅ prod | Main AuthenX DB password |
| `AUTHENX_PG_DATABASE` | — | Default postgres |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated allowed origins |
| `LOG_LEVEL` | — | debug/info/warn/error |
| `PG_PROVISION_HOST` | — | Enable PostgreSQL auto-provisioning at onboarding |
| `PG_PROVISION_PORT` | — | Default 5432 |
| `PG_PROVISION_USER` | — | Default postgres |
| `PG_PROVISION_PASSWORD` | — | PostgreSQL provisioning admin password |
| `CVR_ERP_PG_DB` | — | PostgreSQL database for CVR mock ERP (default: postgres) |
