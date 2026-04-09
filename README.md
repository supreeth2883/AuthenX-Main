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

# Terminal 3: Start the IITB connector (port 9001)
cd authenx-connector && node connector.js

# OR start all 10 college connectors at once
cd colleges && node start-all-connectors.js

# Full stack (recommended)
docker-compose up -d
```

URLs:
- Main app + web UI: http://localhost:3000
- HSM: http://localhost:9099
- Connectors: http://localhost:9001–9010

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

All default accounts require a password change on first login.

---

## API Endpoints

All routes under `/v1/`:

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/auth/login` | POST | Login — returns JWT |
| `/v1/auth/logout` | POST | Logout (revokes token) |
| `/v1/auth/change-password` | POST | Change password |
| `/v1/colleges` | GET/POST | List / register colleges |
| `/v1/tokens` | GET | List issued tokens |
| `/v1/tokens/issue` | POST | Issue credential token |
| `/v1/tokens/revoke` | POST | Revoke token |
| `/v1/verify/code` | POST | Decode AuthenX Code |
| `/v1/verify/live` | POST | Live verification from college ERP |
| `/v1/verify/bulk` | POST | Bulk verify (up to 50) |
| `/v1/audit` | GET | Audit log |
| `/v1/audit/stats` | GET | Dashboard statistics |
| `/v1/connectors/health` | GET | Connector status check |
| `/v1/metrics` | GET | Server metrics (admin) |

---

## Running Tests

```bash
# End-to-end test (requires all 3 services running)
node e2e-test.js

# Critical path smoke test
node smoke-test.js
```

---

## TypeScript Monorepo (in progress)

A parallel TypeScript/Fastify/PostgreSQL implementation is in `authenx/`. See [authenx/SETUP.md](authenx/SETUP.md) for setup instructions.

```bash
cd authenx && npm install
npm run dev    # runs API + connector + web concurrently
```

---

## Documentation

| File | Purpose |
|------|---------|
| [CONTEXT.md](CONTEXT.md) | Architecture reference — system design, crypto model, data flow |
| [SECURITY_FIXES.md](SECURITY_FIXES.md) | Security fixes, env vars, production deployment checklist |
| [prd.md](prd.md) | Full product requirements document |
| [authenx/SETUP.md](authenx/SETUP.md) | TypeScript monorepo setup guide |
| [.env.example](.env.example) | Environment variable template |
| [colleges/registry.json](colleges/registry.json) | Master college config (IDs, ports, keys) |

---

## Security Highlights

| Concern | Implementation |
|---------|----------------|
| Credential signing | Ed25519 per-college key pair via HSM |
| Code encryption | AES-256-GCM (`AX1.<base64>` format) |
| Inter-service auth | HMAC-SHA256 on all server ↔ connector requests |
| Key storage | AES-256-GCM encrypted at rest in HSM (never plaintext) |
| SQL injection | Parameterized queries + UUID validation |
| JWT revocation | `isJwtRevoked()` checked on every request |
| CORS | Origin allowlist (no wildcard) |
| Replay attacks | Per-request nonce + live Ed25519 signature |
| Default passwords | Forced change on first login, 12-char complexity enforced |

See [SECURITY_FIXES.md](SECURITY_FIXES.md) for full details and the production deployment checklist.
