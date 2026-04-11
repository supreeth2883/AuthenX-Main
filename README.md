# AuthenX — Privacy-First Academic Credential Verification

AuthenX lets employers verify academic credentials directly from college ERP systems in real-time using cryptographic proof — **without storing any student personal data**.

> Student data never leaves the college. AuthenX stores only cryptographic hashes and Ed25519 signatures.

---

## Quick Start

```bash
# Terminal 1: Start the HSM (key vault) — required first
cd authenx-hsm && node server.js

# Terminal 2: Start the main server
cd authenx-node && node src/server.js
```

> **Requires Node.js 22+** (uses `node:sqlite` built-in). Zero npm dependencies.

URLs:
- Main app + web UI: http://localhost:3000
- HSM: http://localhost:9099

---

## How It Works

1. A college connector signs a student's canonical credential data with Ed25519
2. AuthenX stores only the hash + signature — no name, CGPA, or personal data
3. An encrypted AuthenX Code (`AX1.<base64>`) is issued to the student
4. When an employer verifies, AuthenX contacts the college connector live
5. The connector re-queries the ERP, re-signs with a fresh nonce
6. AuthenX checks 3 things: hash match, issuance signature, live signature
7. Result returned to employer; live data immediately discarded

---

## Test Credentials

| Role | Email | Password |
|------|-------|----------|
| super_admin | admin@authenx.in | Admin@123 |
| college_admin | iitb@authenx.in | College@123 |
| employer | recruiter@infosys.com | Employer@123 |

All default accounts require a password change on first login (`must_change_password = 1`).

---

## API Reference

All routes under `/v1/`. Requires `Authorization: Bearer <JWT>` on protected routes.

### Authentication

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/auth/login` | POST | Login — returns `{ token, refresh_token, user }` |
| `/v1/auth/refresh` | POST | Refresh access token using refresh_token |
| `/v1/auth/logout` | POST | Logout (revokes token + refresh_token) |
| `/v1/auth/change-password` | POST | Change password (enforces complexity rules) |
| `/v1/auth/mfa/enroll` | POST | Enroll TOTP MFA — returns QR URI + backup codes |
| `/v1/auth/mfa/confirm` | POST | Confirm MFA enrollment with first TOTP code |
| `/v1/auth/mfa/verify` | POST | Verify TOTP code on MFA-enabled login |

### College Management

| Route | Method | Access | Description |
|-------|--------|--------|-------------|
| `/v1/colleges` | GET | Any auth | List all active colleges |
| `/v1/colleges` | POST | super_admin | Register college (manual — requires pre-generated keys) |
| `/v1/colleges/onboard` | POST | super_admin | Full wizard onboarding — generates keys, provisions DB, creates admin |
| `/v1/colleges/:id` | GET | Any auth | Get single college details |

#### College Onboarding (`POST /v1/colleges/onboard`)

**Request body:**
```json
{
  "name": "IIT Bombay",
  "short_code": "IITB",
  "admin_email": "admin@iitb.ac.in",
  "connector_url": "http://connector.iitb.ac.in:9001",
  "connector_config": {
    "port": 9001,
    "db_type": "mysql",
    "field_mapping": { ... }
  }
}
```

**Response (201):**
```json
{
  "college_id": "uuid",
  "college_name": "IIT Bombay",
  "short_code": "IITB",
  "admin_email": "admin@iitb.ac.in",
  "connector_url": "...",
  "connector_port": 9001,
  "public_key_hex": "64-char hex",
  "admin_temp_password": "shown once",
  "shared_secret": "shown once — for connector HMAC auth"
}
```

### Credential Tokens

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/tokens` | GET | List tokens (filtered by college for college_admin) |
| `/v1/tokens/issue` | POST | Issue credential token → returns AuthenX Code |
| `/v1/tokens/revoke` | POST | Revoke a token |
| `/v1/tokens/correct` | POST | Supersede a token with a corrected one |
| `/v1/tokens/analytics` | GET | Issuance / verification analytics |
| `/v1/tokens/:id` | GET | Get token by ID |
| `/v1/tokens/:id/details` | GET | Get token with full verification history |

### Verification

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/verify/code` | POST | Decode AuthenX Code (AX1.…) |
| `/v1/verify/live` | POST | Live verification — re-queries college ERP in real-time |
| `/v1/verify/bulk` | POST | Verify up to 50 codes in one call |

### Audit & Monitoring

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/audit` | GET | Verification event log (filterable) |
| `/v1/audit/stats` | GET | Dashboard statistics |
| `/v1/audit/export` | GET | Export audit log (CSV or JSON) |
| `/v1/audit/security` | GET | Security event log |
| `/v1/security/stats` | GET | Security metrics |
| `/v1/metrics` | GET | Server metrics + Prometheus format (admin) |
| `/v1/fraud-alerts` | GET | Fraud detection alerts (admin) |
| `/v1/health/detailed` | GET | Detailed service health |
| `/health` | GET | Basic health check |

### Disclosure & Connector Config

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/disclosure-policy` | GET/PUT | Field visibility rules per college |
| `/v1/connector-config` | GET/PUT | ERP type, field mapping, connector metadata |
| `/v1/connector/health` | GET | Proxy check of college connector reachability |
| `/v1/connector/verify` | POST | Server-side HMAC-signed connector verify call |
| `/v1/connectors/health` | GET | Health status of all registered connectors |

### Privacy & DPDP Compliance

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/privacy/notice` | GET | Privacy notice (DPDP Act 2023) |
| `/v1/privacy/consent` | GET / POST / DELETE | Read, grant, revoke data consent |
| `/v1/privacy/data-access` | GET | DSAR — export user's own data |
| `/v1/privacy/erasure` | POST | Right-to-erasure request |
| `/v1/privacy/retention/enforce` | POST | Trigger retention policy enforcement |

---

## Environment Variables

| Variable | Required in Prod | Default | Description |
|----------|:---:|---------|-------------|
| `JWT_SECRET` | ✅ | auto-generated (dev) | HMAC-SHA256 JWT signing key |
| `HSM_MASTER_KEY` | ✅ | auto-generated (dev) | AES-256-GCM master key for HSM key encryption |
| `NODE_ENV` | ✅ | — | Set to `production` to enforce required secrets |
| `AES_KEY_HEX` | — | persisted to `aes_key.json` | AES key for AuthenX Code encryption |
| `PORT` | — | 3000 | Main server port |
| `HSM_PORT` | — | 9099 | HSM service port |
| `DB_PATH` | — | `./authenx.db` | SQLite database path |
| `CORS_ALLOWED_ORIGINS` | — | localhost:3000,localhost:8080 | Comma-separated allowed origins |
| `LOG_LEVEL` | — | info | debug / info / warn / error |
| `PG_PROVISION_HOST` | — | — | PostgreSQL host for college DB auto-provisioning |
| `PG_PROVISION_PORT` | — | 5432 | PostgreSQL port |
| `PG_PROVISION_USER` | — | postgres | PostgreSQL admin user |
| `PG_PROVISION_PASSWORD` | — | — | PostgreSQL admin password |

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `colleges` | College registry with connector URL, public key, shared secret |
| `college_keys` | Per-college Ed25519 keypair (private key AES-encrypted at rest) |
| `college_postgres_provisioning` | PostgreSQL DB/schema provisioned per college |
| `college_connector_configs` | ERP type, field mapping, onboarding state |
| `users` | User accounts: super_admin / college_admin / employer |
| `verification_tokens` | Issued credential tokens (hash + signature only — no personal data) |
| `verification_requests` | Immutable audit trail of every verification attempt |
| `revocation_events` | Immutable revocation log |
| `disclosure_policies` | Field visibility rules per college |
| `login_attempts` | Login audit trail (for lockout enforcement) |
| `refresh_tokens` | OAuth-style refresh token hashes |
| `security_events` | Immutable security event log |
| `mfa_secrets` | TOTP secrets (AES-256-GCM encrypted) |
| `mfa_backup_codes` | TOTP backup codes (SHA-256 hashed) |
| `fraud_alerts` | Behavioral fraud detection alerts |
| `consent_records` | DPDP Act explicit consent records |
| `erasure_requests` | Right-to-erasure requests |

---

## Security Highlights

| Concern | Implementation |
|---------|----------------|
| Credential signing | Ed25519 per-college keypair; private key AES-256-GCM encrypted in DB |
| Code encryption | AES-256-GCM (`AX1.<base64url>` format) |
| Inter-service auth | HMAC-SHA256 (`X-HMAC-Signature`) on all server ↔ connector requests |
| Key storage | Private keys AES-256-GCM encrypted at rest (HSM and `college_keys` table) |
| Password hashing | Scrypt with random salt (stored as `salt:hash`) |
| JWT security | HS256 + `jti` revocation list; 15-minute expiry + refresh token rotation |
| TOTP MFA | RFC 6238, ±1 step drift, SHA-1, backup codes |
| SQL injection | Parameterized queries only; UUID format validation |
| CORS | Origin allowlist enforced — no wildcard |
| Replay attacks | Per-request nonce + live Ed25519 signature |
| DoS protection | 1MB payload limit; rate limiter (50 req/min/IP); circuit breaker per connector |
| Fraud detection | Behavioral analysis: rapid-fire, sequential scan, brute force, off-hours |
| Compliance | India DPDP Act 2023 — consent, DSAR, erasure, retention |

See [SECURITY_FIXES.md](SECURITY_FIXES.md) for the full security reference and production deployment checklist.

---

## Frontend UIs (`ui/`)

| Directory | Pages |
|-----------|-------|
| `ui/admin/` | `collegeonboarding.html` — 5-step college onboarding wizard (super admin) |
| `ui/college/` | `index.html` (login), `dashboard.html`, `tokens.html`, `issue.html`, `students.html`, `audit.html`, `security.html`, `connector-management.html`, `disclosure-policy.html`, `onboarding.html`, `code-issued.html` |
| `ui/employer/` | `index.html` (login), `verify.html`, `verified.html`, `revoked.html`, `decoding.html` |
| `ui/shared/` | `offline-auth.js` (demo token helper), `authenx-code.js` |

---

## Documentation

| File | Purpose |
|------|---------|
| [CONTEXT.md](CONTEXT.md) | Architecture reference — system design, crypto model, data flow |
| [SECURITY_FIXES.md](SECURITY_FIXES.md) | Security reference, env vars, production deployment checklist |
| [prd.md](prd.md) | Full product requirements document |
| [CLAUDE.md](CLAUDE.md) | AI assistant guidance for this codebase |
