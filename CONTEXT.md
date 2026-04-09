# AuthenX — Architecture & Codebase Reference
> Last updated: 2026-04-06 | Workspace: `AuthenX-Main`

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

## 2. System Architecture

```
[College ERP] ──→ [Secure Connector] ──→ [AuthenX Proof Layer] ──→ [Employer App]
     L1                  L2                       L3                     L4
```

| Layer | Description |
|-------|-------------|
| L1: College ERP | Source of truth — fully college-controlled |
| L2: Connector | Shield between ERP and AuthenX; signs proofs |
| L3: Proof Orchestration | AuthenX cloud — stores only proofs, no student data |
| L4: Employer Verification | Employer-facing app; scans AuthenX Code |

### End-to-End Data Flow

```
STUDENT
  ↓ Receives degree, gets AuthenX Code (AES-256-GCM encrypted)
  ↓ Shares code with employers

EMPLOYER
  ↓ Pastes AuthenX Code into verification app
  POST /v1/verify/live
  ↓

AUTHENX API (Node.js, :3000)
  • Decrypts AuthenX Code → gets token_id, college_id, student_ref_token
  • Fetches token from DB (canonical_hash + issuance_signature)
  • Generates nonce, calls college connector (HMAC-signed request)
  ↓

COLLEGE CONNECTOR (:9001–9010)
  • Validates HMAC signature
  • Queries college ERP/mock SQLite DB (single record, read-only)
  • Builds canonical JSON → SHA-256 → HSM sign
  • Returns live_data + live_signature
  ↓

HSM (:9099)
  • Signs with college Ed25519 private key
  • Private key never leaves HSM
  ↓

AUTHENX API — Verification checks:
  ✓ Hash match (recompute canonical JSON, compare stored hash)
  ✓ Issuance signature (verify Ed25519 against stored public key)
  ✓ Live signature (verify nonce+hash signature — proves freshness)
  ↓

EMPLOYER sees result:
  { result: "verified", live_data: { name, degree, branch, cgpa, graduation_year } }
  (live_data shown then discarded — never stored)
```

---

## 3. What AuthenX Stores vs. Does NOT Store

| Stores | Does NOT Store |
|--------|----------------|
| `token_id`, `issuer_id` | Student name/CGPA as persistent data |
| `student_ref_token` (for lookup) | Father/mother name |
| `canonical_hash` (SHA-256) | Transcripts / mark sheets |
| `issuance_signature` (Ed25519) | Certificate PDFs |
| `issued_at`, `token_status` | ERP database copies |
| Verification event metadata | Raw personal academic history |

**Live data** (name, degree, branch, CGPA, grad year) is fetched from college ERP at verification time, shown to the employer, and immediately discarded.

---

## 4. Privacy Architecture

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
└─────────────────────────────────────────┘
```

---

## 5. Directory Structure

```
AuthenX-Main/
├── authenx-node/              ← PRIMARY ACTIVE SERVER (Node.js, pure built-ins)
│   └── src/
│       ├── server.js          ← Main server (all routes + embedded HTML SPA)
│       ├── db/                ← SQLite client + schema
│       ├── crypto/            ← Ed25519, SHA-256, AES-256-GCM, canonical JSON
│       ├── middleware/        ← auth, validation, metrics, logger, fraud-detector
│       └── routes/            ← auth.js, colleges.js, tokens.js, verify.js, audit.js, privacy.js
│
├── authenx-connector/         ← College connector service
│   ├── connector.js           ← Main connector (SQLite ERP mock, Node built-ins only)
│   ├── universal-connector.js ← Multi-DB adapter version
│   ├── core/canonicalizer.js  ← Deterministic canonical JSON fingerprinting
│   ├── adapters/              ← Pluggable adapters per college type
│   └── config.json            ← Default field mapping config
│
├── authenx-hsm/               ← Hardware Security Module (key vault)
│   ├── server.js              ← HSM API server (port 9099, localhost-only)
│   ├── key-store.js           ← Ed25519 key storage per college (AES-256-GCM encrypted)
│   └── keys/                  ← {college_id}.json — encrypted key pairs
│
├── authenx-ledger/            ← Audit ledger service
│   └── server.js
│
├── authenx/                   ← TypeScript monorepo (Fastify, in progress)
│   ├── SETUP.md               ← Setup guide for this codebase
│   └── packages/
│       ├── api/               ← Fastify API (TypeScript, NOT the active server)
│       ├── connector/         ← Connector package
│       └── web/               ← React frontend
│
├── colleges/                  ← Per-college connector configs + startup scripts
│   ├── registry.json          ← All 10 college registrations (IDs, keys, ports)
│   ├── IITB/ … DU/            ← Per-college .env files
│   └── start-all-connectors.js
│
├── ui/                        ← Standalone frontend (in progress)
│
├── docker-compose.yml         ← Full stack: main server + HSM + 10 connectors
├── Dockerfile / Dockerfile.connector
├── prd.md                     ← Full product requirements document
├── CONTEXT.md                 ← This file — architecture reference
├── SECURITY_FIXES.md          ← Security implementation record
└── README.md                  ← Project overview and quick start
```

---

## 6. Active Server: `authenx-node/src/server.js`

Production-ready. Pure Node.js 22 built-ins. Zero external dependencies.

### API Routes (all under `/v1/`)

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/auth/login` | POST | Login — returns JWT |
| `/v1/auth/refresh` | POST | Refresh JWT |
| `/v1/auth/logout` | POST | Logout (revokes token) |
| `/v1/auth/change-password` | POST | Change password (enforced on first login) |
| `/v1/auth/mfa/*` | POST | MFA enroll/verify/confirm |
| `/v1/colleges` | GET/POST | List/create colleges |
| `/v1/colleges/:id` | GET | Get college details |
| `/v1/tokens` | GET | List tokens |
| `/v1/tokens/issue` | POST | Issue credential token |
| `/v1/tokens/revoke` | POST | Revoke token |
| `/v1/tokens/analytics` | GET | Token analytics |
| `/v1/verify/code` | POST | Decode AuthenX Code |
| `/v1/verify/live` | POST | Live ERP verification |
| `/v1/verify/bulk` | POST | Bulk verify (max 50) |
| `/v1/audit` | GET | Audit log |
| `/v1/audit/stats` | GET | Stats (colleges, tokens, verifications, revoked) |
| `/v1/audit/security` | GET | Security events |
| `/v1/connectors/health` | GET | Check all connector statuses |
| `/v1/health/detailed` | GET | Server health + DB stats |
| `/v1/metrics` | GET | Prometheus/JSON metrics (admin) |
| `/v1/fraud-alerts` | GET | Fraud alert list (admin) |
| `/v1/privacy/*` | GET/POST/DELETE | DPDP privacy compliance routes |
| `/` | GET | Serves embedded HTML SPA |

### Database (SQLite via `node:sqlite`)
Tables: `colleges`, `users`, `verification_tokens`, `verification_requests`, `revocation_events`, `security_events`, `login_attempts`, `fraud_alerts`

### Security Features
- JWT auth with revocation support
- Rate limiting: 50 req/min per IP
- Origin-based CORS (configurable via `CORS_ALLOWED_ORIGINS`)
- Security headers (HSTS, X-Frame-Options, etc.)
- HMAC request signing (AuthenX → Connector)
- Fraud detection middleware
- MFA support (TOTP)
- Nonce-based replay prevention
- Graceful shutdown (SIGTERM/SIGINT)
- Request correlation IDs (`X-Request-ID`)

---

## 7. Connector: `authenx-connector/connector.js`

Per-college service running on the college's network. Bridges ERP to AuthenX.

### Endpoints
- `GET /health` — Health check
- `POST /verify` — Verify student (HMAC protected)

### Verify flow
1. Validates HMAC signature from AuthenX (zero-trust inter-service auth)
2. Checks nonce for replay prevention
3. Queries local SQLite (or real ERP via universal-connector)
4. Applies field mapping from `config.json`
5. Builds canonical JSON, computes SHA-256
6. Calls HSM (`POST /sign`) for Ed25519 signing
7. Returns signed response

### Connector Adapter Interface ("Plug & Play")

Every adapter implements the same contract, allowing any college database type:

```
Input:  { student_ref_token, nonce }
Output: { name, degree, branch, cgpa, graduation_year, live_signature }
```

Supported adapters:
- **SQLite** — active default (mock ERP)
- **MySQL / PostgreSQL / SQL Server** — via `universal-connector.js`
- **REST API** — via ERP API adapter

### College Onboarding Steps

1. College IT provides their DB schema
2. AuthenX creates a `config.json` field mapping:
   ```json
   {
     "college_id": "iitb",
     "db": { "table": "students", "ref_column": "enrollment_number" },
     "field_mapping": {
       "name":            { "type": "concat", "columns": ["first_name", "last_name"] },
       "degree":          { "type": "column", "column": "program_name" },
       "cgpa":            { "type": "column", "column": "final_cgpa" },
       "graduation_year": { "type": "year_from_date", "column": "graduation_date" },
       "status":          { "type": "map_values", "column": "enrollment_status",
                            "active_values": ["ACTIVE", "GRADUATED", "ALUMNI"] }
     }
   }
   ```
3. AuthenX generates college Ed25519 keypair via HSM; public key registered in `registry.json`
4. Private key provisioned securely to college IT; stored in connector `.env`
5. Connector deployed on college network → AuthenX validates with test request → college goes live

---

## 8. HSM: `authenx-hsm/server.js`

- Port: **9099** (localhost-only — never exposed externally)
- Manages one Ed25519 key pair per college
- Key files: `authenx-hsm/keys/{college_id}.json` (AES-256-GCM encrypted at rest)
- Master key via `HSM_MASTER_KEY` env var (required in production)
- Callers send data to sign → receive only the signature; private key never leaves HSM

---

## 9. Cryptographic Model

| Algorithm | Use |
|-----------|-----|
| Ed25519 | College credential signing and verification |
| AES-256-GCM | AuthenX Code encryption + HSM key-at-rest encryption |
| SHA-256 | Canonical payload hashing |
| HS256 (JWT) | API authentication tokens |
| Scrypt | Password hashing |
| HMAC-SHA256 | Inter-service request authentication |

### AuthenX Code Format
`AX1.<AES-256-GCM encrypted base64>` — contains `{ token_id, college_id, student_ref_token, credential_type }`.

### Canonical JSON (deterministic field order)
`schema_version`, `issuer_id`, `student_ref_token`, `name`, `degree`, `branch`, `credential_type`, `cgpa`, `graduation_year`, `issue_date`

**Critical:** Field order must be identical between connector and main server for hash matching to pass.

### Double-Signing Model
- **Issuance Signature**: connector signs `sha256(canonical)` at issuance — "We issued this."
- **Live Signature**: connector signs `nonce:sha256(live_canonical)` at verify time — "We confirm it now."

---

## 10. Seeded Test Accounts

| Role | Email | Password |
|------|-------|----------|
| `super_admin` | `admin@authenx.in` | `Admin@123` |
| `college_admin` | `iitb@authenx.in` | `College@123` |
| `employer` | `recruiter@infosys.com` | `Employer@123` |

All seeded users have `must_change_password = 1` — password change is enforced on first login.
Pre-generated test AuthenX codes are in `seed_codes.json` (gitignored).

---

## 11. Registered Colleges (10 Mock Connectors)

| College | Short Code | Port |
|---------|------------|------|
| IIT Bombay | IITB | 9001 |
| IIT Delhi | IITD | 9002 |
| IIT Madras | IITM | 9003 |
| NIT Trichy | NITT | 9004 |
| NIT Warangal | NITW | 9005 |
| BITS Pilani | BITS | 9006 |
| VIT Vellore | VIT | 9007 |
| SRM Chennai | SRM | 9008 |
| Anna University | ANNA | 9009 |
| Delhi University | DU | 9010 |

---

## 12. How to Run (Local)

```bash
# Terminal 1: Start HSM (required first)
cd authenx-hsm && node server.js

# Terminal 2: Start main server
cd authenx-node && node src/server.js

# Terminal 3: Start IITB connector (port 9001)
cd authenx-connector && node connector.js

# OR start all 10 college connectors
cd colleges && node start-all-connectors.js

# Full stack via Docker
docker-compose up -d
```

- Main app: http://localhost:3000
- HSM: http://localhost:9099
- Connectors: http://localhost:9001–9010

### End-to-End Test
```bash
node e2e-test.js    # Full flow (requires all 3 services)
node smoke-test.js  # Critical path only
```

---

## 13. Two Parallel Implementations

| | `authenx-node/` | `authenx/` |
|--|----------------|-----------|
| Status | **Active / production** | In progress |
| Runtime | Node 22, zero deps | TypeScript, Fastify |
| DB | SQLite (built-in) | PostgreSQL |
| Frontend | Embedded HTML SPA | React (Vite) |
| Setup guide | This file (section 12) | `authenx/SETUP.md` |

---

## 14. What's Real vs. Mock

| Component | Status |
|-----------|--------|
| `authenx-node/src/server.js` | Production-grade |
| `connector.js` | Real connector code; uses mock SQLite DB as ERP |
| `authenx-hsm/server.js` | Real key management (software HSM) |
| College ERPs | Mock SQLite DBs — production would use real ERP |
| `authenx/packages/api/` | TypeScript Fastify API (in progress, not active) |
| OCR cross-check module | Designed but not implemented |

---

## 15. Key Files

| File | Purpose |
|------|---------|
| `prd.md` | Full product requirements and vision |
| `authenx-node/src/server.js` | Core API (all routes, embedded HTML SPA, seed logic) |
| `authenx-node/src/crypto/index.js` | All cryptographic primitives |
| `authenx-connector/connector.js` | College ERP bridge (SQLite mock) |
| `authenx-connector/core/canonicalizer.js` | Deterministic canonical JSON |
| `authenx-hsm/server.js` | Key vault for Ed25519 signing |
| `authenx-hsm/key-store.js` | Encrypted key pair management |
| `colleges/registry.json` | Master list of all 10 colleges + keys + ports |
| `docker-compose.yml` | Full stack container orchestration |
| `SECURITY_FIXES.md` | Security implementation record |
| `.env.example` | Environment variable template |
