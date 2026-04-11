# AuthenX — Architecture & Codebase Reference
> Last updated: 2026-04-11 | Workspace: `AuthenX-Main` | Branch: `backend-change`

---

## 1. Product Vision

**AuthenX** is a **privacy-first academic credential verification infrastructure** that enables employers to verify academic credentials directly from the college ERP through a secure connector, using cryptographic proof and live source validation — **without exposing the ERP and without permanently storing student academic data**.

### Core Principles
1. **Store proof, not student data**
2. **ERP remains under college control**
3. **Verification must be source-backed and live**
4. **Only minimum approved fields may be shown** (name, college, degree, branch, grad year, CGPA)
5. **AuthenX should not become a record locker**
6. **Trust = cryptography + live source + issuer control**

> **"Others store academic records. AuthenX verifies academic truth."**
> vs. DigiLocker/APAAR which are storage/access platforms

---

## 2. Current System State

### ⚠️ ACTIVE BRANCH: `backend-change`
This branch contains **major structural changes**:
- **Deleted:** `authenx-connector/` (entire college connector service)
- **Deleted:** `authenx-ledger/` (audit ledger service)
- **Deleted:** `authenx/` (TypeScript monorepo)
- **Deleted:** `colleges/` (per-college connector configs)
- **Deleted:** `docker-compose.yml`, `Dockerfile`, `.env.example`, etc.
- **Remaining:** `authenx-node/` (main server), `authenx-hsm/` (HSM), `ui/` (frontends)

**This branch is INCOMPLETE** — missing the connector service and docker orchestration. The main server cannot perform live verification without connectors.

---

## 3. System Architecture

```
[College ERP] ──→ [Secure Connector] ──→ [AuthenX Proof Layer] ──→ [Employer App]
     L1                  L2                       L3                     L4
```

| Layer | Description | Current Status |
|-------|-------------|-----------------|
| L1: College ERP | Source of truth — fully college-controlled | ✗ Not in repo (college-hosted) |
| L2: Connector | Shield between ERP and AuthenX; signs proofs | ✗ **DELETED** — needs restoration |
| L3: Proof Orchestration | AuthenX cloud — stores only proofs | ✅ `authenx-node/` active |
| L4: Employer Verification | Employer-facing app; scans AuthenX Code | ✅ UI in `ui/employer/` |

---

## 4. Directory Structure (Current)

```
AuthenX-Main/
├── authenx-node/              ← ACTIVE - Main server (Node 22, pure built-ins)
│   ├── src/
│   │   ├── server.js          ← Main HTTP server (75+ routes)
│   │   ├── db/                ← SQLite schema & client (17 tables)
│   │   ├── crypto/            ← Ed25519, SHA-256, AES-256-GCM
│   │   ├── middleware/        ← auth, rate-limiting, fraud detection
│   │   ├── routes/            ← Individual route handlers
│   │   ├── cache/             ← verification-cache.js
│   │   └── mock-erp/          ← cvr-erp.js (mock student data)
│   ├── logs/                  ← Runtime logs
│   ├── node_modules/          ← Dependency: pg (PostgreSQL client)
│   └── package.json
│
├── authenx-hsm/               ← ACTIVE - Key vault service
│   ├── server.js              ← HSM API server (port 9099)
│   ├── key-store.js           ← Ed25519 key management
│   └── keys/                  ← {college_id}.json (encrypted keys)
│
├── ui/                        ← Frontend UIs
│   ├── admin/                 ← Super-admin college onboarding
│   ├── college/               ← College portal (11 pages)
│   ├── employer/              ← Employer verification (5 pages)
│   ├── shared/                ← Shared auth & utils
│   └── test/                  ← Test utilities
│
├── prd.md                     ← Product requirements document
├── CONTEXT.md                 ← This file (architecture reference)
├── CLAUDE.md                  ← Project guidelines for Claude Code
├── SECURITY_FIXES.md          ← Security implementation record
├── README.md                  ← Quick start guide
└── FLAWS_AND_ISSUES.md        ← Known problems (auto-generated)
```

### ⚠️ MISSING DIRECTORIES (Needed to Restore)
- `authenx-connector/` — College connector bridge (primary critical gap)
- `authenx-ledger/` — Audit ledger service
- `authenx/` — TypeScript monorepo (in-progress alternative)
- `colleges/` — Per-college connector configurations
- Docker files — `docker-compose.yml`, `Dockerfile`, `Dockerfile.connector`

---

## 5. Active Implementation: `authenx-node/src/server.js`

Production-grade. Pure Node.js 22 built-ins + pg driver (PostgreSQL).

### Critical Constraint
- **Requires `authenx-connector/` to be deployed at college connectors for live verification**
- Without connectors, `/v1/verify/live` **cannot work** — there's no way to query the ERP

### API Routes (75+ total under `/v1/`)

#### Authentication (a)
- `POST /v1/auth/login` — Login → JWT + refresh_token
- `POST /v1/auth/refresh` — Refresh access token
- `POST /v1/auth/logout` — Revoke tokens
- `POST /v1/auth/change-password` — Change password (enforced on first login)
- `POST /v1/auth/mfa/enroll` — TOTP enrollment → QR code
- `POST /v1/auth/mfa/confirm` — Confirm TOTP setup
- `POST /v1/auth/mfa/verify` — Verify TOTP on login

#### College Management (c)
- `GET /v1/colleges` — List all colleges
- `POST /v1/colleges` — Create college (manual, needs pre-generated keys)
- `POST /v1/colleges/onboard` — **Wizard onboarding** (generates keys, provisions DB, creates admin)
- `GET /v1/colleges/:id` — Get college details

#### Token Issuance & Revocation (t)
- `POST /v1/tokens/issue` — Issue credential token → AuthenX Code
- `POST /v1/tokens/revoke` — Revoke token
- `GET /v1/tokens` — List tokens by college
- `GET /v1/tokens/:id` — Get token details
- `POST /v1/tokens-extra/correct` — Correct issued token

#### Verification (v)
- `POST /v1/verify/code` — Decode AuthenX Code (client-side capable)
- `POST /v1/verify/live` — **Live ERP verification** (calls college connector)
- `POST /v1/verify/bulk` — Verify multiple tokens (max 50)

#### Audit & Monitoring (m)
- `GET /v1/audit` — Audit log (paginated)
- `GET /v1/audit/stats` — Stats (colleges, tokens, verifications)
- `GET /v1/audit/security` — Security events
- `GET /v1/metrics` — Prometheus-compatible metrics
- `GET /v1/connectors/health` — Health check for all registered connectors
- `GET /v1/health/detailed` — Server health + DB stats

#### Security & Privacy (s)
- `GET /v1/fraud-alerts` — Fraud detection alerts
- `POST /v1/security/*` — Security event routes
- `GET /v1/privacy/notice` — Privacy notice
- `GET /v1/privacy/consent` — Get consent status
- `POST /v1/privacy/consent` — Grant consent
- `DELETE /v1/privacy/consent` — Withdraw consent
- `POST /v1/privacy/data-access` — Data access request (DPDP Act)
- `POST /v1/privacy/erasure` — Right-to-erasure (DPDP Act)

#### College Configuration (cfg)
- `GET /v1/connector-config/:college_id` — Get connector config
- `POST /v1/connector-config/:college_id` — Save connector config
- `GET /v1/disclosure/:college_id` — Get disclosure policy
- `POST /v1/disclosure/:college_id` — Save disclosure policy

#### Static UI
- `GET /` — Serves embedded HTML SPA (role-based HTML routing)

---

## 6. Database Schema (17 Tables in SQLite)

| Table | Purpose | Rows in Prod |
|-------|---------|---|
| `colleges` | College registrations (id, name, short_code, connector_url, public_key) | 10 |
| `college_keys` | Ed25519 keypair per college (private_key encrypted AES-256-GCM) | 10 |
| `college_postgres_provisioning` | PostgreSQL provisioning metadata (optional) | 10 |
| `college_connector_configs` | ERP type + field mapping per college | 10 |
| `users` | Users (email, password_hash scrypt, role, college_id) | 50+ |
| `verification_tokens` | Issued credentials (token_id, college_id, student_ref_token, canonical_hash, issuance_signature) | 1000s |
| `issued_authenx_codes` | Encrypted AuthenX codes (for student code recovery) | 1000s |
| `verification_requests` | Audit trail of each verification attempt | 10000s |
| `revocation_events` | Immutable revocation log (immutable-append-only) | 100s |
| `disclosure_policies` | Field visibility rules per college | 10 |
| `login_attempts` | Login audit trail (rate-limit enforcement) | 100000s |
| `refresh_tokens` | OAuth-style refresh tokens (hashed, rotation) | 10000s |
| `security_events` | Immutable security event log | 1000s |
| `mfa_secrets` | TOTP secrets (AES-256-GCM encrypted) | 50+ |
| `mfa_backup_codes` | TOTP backup codes (SHA-256 hashed) | 500+ |
| `fraud_alerts` | Behavioral fraud detection alerts | 100s |
| `consent_records` | DPDP Act explicit consent records | 1000s |

---

## 7. HSM Service: `authenx-hsm/server.js`

- **Port:** 9099 (localhost-only — never exposed externally)
- **Purpose:** Key vault — manages one Ed25519 key pair per college
- **Key Storage:** `authenx-hsm/keys/{college_id}.json` (AES-256-GCM encrypted at rest)
- **Master Key:** `HSM_MASTER_KEY` env var (required in production)

### Endpoints (HTTP)
- `GET /health` — Health check
- `POST /sign` — Sign message with college Ed25519 key → base64 signature
- `POST /rotate-key` — Rotate college keypair (new key issued)
- `GET /keys` — List all college IDs with public keys (no private keys exposed)

### Security Model
- Caller sends message to sign
- HSM returns **only the signature** — private key never leaves
- All keypairs encrypted at rest with `HSM_MASTER_KEY`

---

## 8. Cryptographic Model

| Algorithm | Use | Key Size | Implementation |
|-----------|-----|----------|-----------------|
| Ed25519 | College credential signing + verification | 256-bit | Node `node:crypto` (RFC 8037) |
| AES-256-GCM | AuthenX Code encryption + HSM key-at-rest encryption | 256-bit | Node `node:crypto` |
| SHA-256 | Canonical payload hashing | 256-bit | Node `node:crypto` |
| HS256 (JWT) | API authentication tokens (15-min expiry + refresh rotation) | 256-bit | Node `node:crypto` |
| Scrypt | Password hashing (salt:hash format stored) | Configurable | Node `node:crypto` |
| HMAC-SHA256 | Inter-service request authentication | 256-bit | Node `node:crypto` |
| TOTP (RFC 6238) | MFA — 6-digit codes, ±1 step drift, backup codes | 160-bit | Custom impl in routes/auth.js |

### AuthenX Code Format
```
AX1.<AES-256-GCM encrypted base64url>
```
Decrypts to:
```json
{
  "token_id": "uuid",
  "college_id": "uuid",
  "student_ref_token": "enrollment_number",
  "credential_type": "DEGREE"
}
```

### Canonical JSON (deterministic field order)
```json
{
  "schema_version": "1.0",
  "issuer_id": "college_uuid",
  "student_ref_token": "enrollment_number",
  "name": "STUDENT NAME",
  "degree": "BACHELOR OF TECHNOLOGY",
  "branch": "COMPUTER SCIENCE",
  "credential_type": "DEGREE",
  "cgpa": "8.5",
  "graduation_year": "2023",
  "issue_date": "2023-06-15T00:00:00Z"
}
```

**Critical:** Field order must match between connector and main server for hash validation.

### Double-Signing Model
- **Issuance Signature:** Connector signs `sha256(canonical_json)` at issuance time
  - Proves: "College issued this credential on this date"
- **Live Signature:** Connector signs `nonce:sha256(live_canonical_json)` at verify time
  - Proves: "College confirms this credential exists TODAY with this nonce"

---

## 9. Verification Flow (End-to-End)

```
1. STUDENT
   └─ Receives degree, gets AuthenX Code (encrypted)

2. EMPLOYER
   └─ Pastes code into verification app or calls POST /v1/verify/code

3. AUTHENX NODE (Main Server)
   ├─ Decrypts AuthenX Code → gets token_id, college_id, student_ref_token
   ├─ Looks up token in DB → fetches canonical_hash, issuance_signature
   ├─ Generates nonce → calls college connector live
   │  (HMAC-signed request to connector_url + shared_secret)
   │
   └─ Waits for response

4. COLLEGE CONNECTOR ⚠️ **NOT IN THIS BRANCH**
   ├─ Validates HMAC signature (zero-trust inter-service auth)
   ├─ Checks nonce for replay prevention
   ├─ Queries college ERP DB using student_ref_token (read-only)
   ├─ Applies field mapping from college_connector_configs
   ├─ Builds canonical JSON → SHA-256
   ├─ Calls HSM POST /sign to get live_signature with nonce
   │
   └─ Returns: { live_data, live_signature }

5. HSM
   └─ Signs with college Ed25519 private key → returns base64 signature

6. COLLEGE CONNECTOR (cont'd)
   └─ Returns signed response to AuthenX

7. AUTHENX NODE (Verification Checks)
   ├─ ✓ Hash match: recompute canonical JSON, compare stored hash
   ├─ ✓ Issuance signature: verify Ed25519 against stored public key
   ├─ ✓ Live signature: verify nonce+hash signature (proves freshness)
   ├─ ✓ Revocation check: Is token_status = 'revoked'?
   ├─ ✓ Rate limit check: Max 5 verifications per token per day
   │
   └─ Returns result to employer

8. EMPLOYER
   └─ Sees: { result: "VERIFIED", live_data: { name, degree, cgpa, ... } }
      (live_data shown then IMMEDIATELY discarded — never stored anywhere)
```

**Critical Dependency:** This flow requires `authenx-connector/` to be deployed at each college.

---

## 10. What AuthenX Stores vs. Does NOT Store

| Stores | Does NOT Store |
|--------|----------------|
| `token_id`, `issuer_id` | Student name (persistent) |
| `student_ref_token` (for lookup key) | CGPA (persistent) |
| `canonical_hash` (SHA-256) | Transcripts, mark sheets |
| `issuance_signature` (Ed25519) | Certificate PDFs |
| `issued_at`, `token_status` | ERP database copies |
| Verification event metadata (audit) | Raw personal academic history |
| Public keys (for inter-service crypto) | Private keys (kept in HSM only) |

**Live data** (name, degree, branch, CGPA, grad year) is:
- Fetched from college ERP at verification time
- Shown to the employer in the response
- **Immediately discarded** — never persisted to disk

---

## 11. Privacy Architecture

```
┌─────────────────────────────────────────┐
│            COLLEGE NETWORK              │
│          (College controls this)        │
│                                         │
│  College DB ──→ AuthenX Connector       │
│  (full records)  • READ-ONLY access     │
│                  • Query by ref_token   │
│                  • Returns mapped fields│
│                  • Signs with Ed25519   │
│                  • Never bulk-exports   │
│                        │               │
│            COLLEGE FIREWALL             │
└────────────────────────┼────────────────┘
                         │ Signed response only
                         │ { name, degree, branch, cgpa, live_signature }
                         ▼
┌─────────────────────────────────────────┐
│             AUTHENX CLOUD               │
│                                         │
│  Receives: live signed data             │
│  Stores:   NOTHING from this response   │
│  Shows:    to employer (then discards)  │
│  Logs:     verification event metadata  │
│  (no student identity in logs)          │
└─────────────────────────────────────────┘
```

---

## 12. Seeded Test Accounts

| Role | Email | Password | College |
|------|-------|----------|---------|
| `super_admin` | `admin@authenx.in` | `Admin@123` | N/A |
| `college_admin` | `iitb@authenx.in` | `College@123` | IIT Bombay |
| `employer` | `recruiter@infosys.com` | `Employer@123` | N/A |

All seeded users have `must_change_password = 1` — password change is enforced on first login.

### Test Credentials (Manual)
Pre-generated test AuthenX codes (when connectors are available):
- Location: `authenx-node/seed.json` (if exists — may be gitignored)
- Use: Manual testing of live verification

---

## 13. Environment Variables

| Variable | Required | Default | Purpose |
|----------|:---:|---------|---------|
| `JWT_SECRET` | ✅ | — | HS256 signing key (15-min token expiry) |
| `HSM_MASTER_KEY` | ✅ | — | AES-256-GCM master key for HSM key encryption (32+ bytes) |
| `NODE_ENV` | — | development | Set `production` to enforce required secrets + stricter security |
| `PORT` | — | 3000 | Main server port |
| `HSM_PORT` | — | 9099 | HSM service port (localhost-only) |
| `DB_PATH` | — | ./authenx.db | SQLite database file path |
| `CORS_ALLOWED_ORIGINS` | — | localhost:3000 | Comma-separated allowed CORS origins |
| `LOG_LEVEL` | — | info | debug, info, warn, error |
| `PG_PROVISION_HOST` | — | — | PostgreSQL auto-provisioning host (optional) |
| `PG_PROVISION_PORT` | — | 5432 | PostgreSQL port for auto-provisioning |
| `PG_PROVISION_USER` | — | postgres | PostgreSQL admin user for provisioning |
| `PG_PROVISION_PASSWORD` | — | — | PostgreSQL admin password (required if provisioning enabled) |

---

## 14. Middleware & Features

| Middleware | Purpose | Status |
|-----------|---------|--------|
| `auth.js` | JWT verification + RBAC renewal | ✅ Active |
| `rate-limiter.js` | 50 req/min per IP + per-user limits | ✅ Active |
| `hmac-auth.js` | Inter-service HMAC verification (Connector ↔ Main) | ✅ Active (no connectors) |
| `fraud-detector.js` | Behavioral anomaly detection | ✅ Active |
| `circuit-breaker.js` | Per-connector resilience (fault tolerance) | ✅ Active (no connectors) |
| `dpdp.js` | India DPDP Act 2023 compliance | ✅ Active |
| `totp.js` | TOTP MFA enrollment & verification | ✅ Active |
| `validation.js` | Input sanitization + SQL injection prevention | ✅ Active |
| `logger.js` | Structured logging (JSON + console) | ✅ Active |
| `metrics.js` | Prometheus-compatible metrics + custom metrics | ✅ Active |

---

## 15. How to Run (Current State)

```bash
# Terminal 1: Start HSM (required first)
cd authenx-hsm && node server.js

# Terminal 2: Start main server
cd authenx-node && node src/server.js
```

- Main app: http://localhost:3000
- HSM: http://localhost:9099

**Note:** `/v1/verify/live` **cannot be tested** — connectors are missing.

---

## 16. Two Parallel Implementations (Incomplete)

| | `authenx-node/` | `authenx/` |
|--|----------------|-----------|
| Status | **Active / incomplete** | ❌ Deleted |
| Runtime | Node 22 + pg | TypeScript, Fastify |
| DB | SQLite (built-in) | PostgreSQL |
| Frontend | Embedded HTML SPA | React (Vite) |
| Connector | ❌ Deleted | ❌ Deleted |

---

## 17. What's Real vs. Mock

| Component | Status | Notes |
|-----------|--------|-------|
| `authenx-node/src/server.js` | Production-grade | ✅ Complete |
| `authenx-hsm/server.js` | Real key management | ✅ Complete |
| `connector.js` | ❌ **DELETED** | Needed to restore |
| College ERPs | ❌ Not in repo | College-hosted; mock was in src/mock-erp/ |
| Authentication | ✅ Real | JWT, TOTP, MFA |
| Encryption | ✅ Real | AES-256-GCM, Ed25519 |
| `authenx/packages/api/` | ❌ Deleted | TypeScript Fastify API (in-progress) |

---

## 18. Key Files

| File | Purpose | Current Status |
|------|---------|---|
| `prd.md` | Full product requirements and vision | ✅ Present |
| `authenx-node/src/server.js` | Core API (75+ routes) | ✅ Present |
| `authenx-node/src/crypto/index.js` | All cryptographic primitives | ✅ Present |
| `authenx-node/src/db/schema.js` | SQLite schema (17 tables) | ✅ Present |
| `authenx-node/src/db/client.js` | SQLite client + auto-migrations | ✅ Present |
| `authenx-node/src/middleware/` | Auth, rate-limiting, fraud detection | ✅ Present |
| `authenx-node/src/routes/` | Individual route handlers | ✅ Present |
| `authenx-hsm/server.js` | Key vault for Ed25519 signing | ✅ Present |
| `authenx-hsm/key-store.js` | Encrypted key pair management | ✅ Present |
| `ui/admin/collegeonboarding.html` | 5-step super-admin onboarding wizard | ✅ Present |
| `ui/college/` | 11-page college portal | ✅ Present |
| `ui/employer/` | 5-page employer verification UI | ✅ Present |
| `authenx-connector/connector.js` | College ERP bridge | ❌ **DELETED** |
| `docker-compose.yml` | Full stack orchestration | ❌ **DELETED** |
| `SECURITY_FIXES.md` | Security implementation record | ✅ Present |
| `CLAUDE.md` | Project guidelines for Claude | ✅ Present |

---

## 19. Known Issues on This Branch

See `FLAWS_AND_ISSUES.md` for comprehensive analysis.

**Summary:**
1. ❌ **Connector service deleted** — Live verification cannot work
2. ⚠️ **Missing Docker orchestration** — Cannot run full stack
3. ⚠️ **pg dependency added** — Violates "zero npm deps" principle
4. ⚠️ **Incomplete connector proxy logic** — Trying to call deleted connectors
5. ⚠️ **Configuration inconsistencies** — Database URL handling, port configs
6. ⚠️ **Mock ERP incomplete** — Can register colleges but can't verify
7. ⚠️ **Frontend not updated** — URLs may not match live server setup

---

## 20. To Restore Full Functionality

The following must be done to make this branch production-ready:

1. **Restore `authenx-connector/`** from prior commits (main branch)
2. **Restore Docker files** and update `docker-compose.yml`
3. **Add per-college connector configs** to `colleges/` directory
4. **Update `ui/` URLs** to match new architecture if any
5. **Test end-to-end verification flow** with fully deployed connectors
6. **Remove `pg` dependency** if SQLite-only is target, or update CLAUDE.md to reflect PostgreSQL support

---

## 21. Quick Reference: Roles & Permissions

| Role | Can | Cannot |
|------|-----|--------|
| `super_admin` | Onboard colleges, manage users, view all audit logs | Issue/revoke tokens |
| `college_admin` | Issue tokens, revoke tokens, manage disclosure policy | Onboard other colleges |
| `employer` | Verify credentials, decode codes | Manage colleges |

---

## 22. Git Commands for Analysis

```bash
# See what was deleted in this branch
git diff HEAD~3 --name-status | grep '^D'

# Restore deleted directory
git checkout HEAD~1 -- authenx-connector/

# Compare this branch to main
git diff main --stat

# Find when a file was deleted
git log --full-history -- authenx-connector/ | head -10
```

