# CLAUDE.md

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

# Terminal 3: Start the dev connector (IITB, port 9001)
cd authenx-connector && node connector.js

# OR start all 10 college-specific connectors
cd colleges && node start-all-connectors.js

# Run e2e tests (requires all 3 services above)
node e2e-test.js

# Run CI smoke test (critical path only)
node smoke-test.js
```

### Docker (Full Stack)

```bash
docker-compose up -d
# Starts: main server (:3000) + HSM (:9099) + 10 connectors (:9001–9010)
```

### TypeScript Monorepo (`authenx/`) — In Progress

```bash
cd authenx && npm install
npm run dev          # Runs API + connector + web concurrently
npm run build        # Build all workspaces
npm run db:migrate   # Run DB migrations (PostgreSQL)
```

## Architecture

The system has four tiers communicating over HTTP:

```
Employer App → Main Server (:3000) → College Connectors (:9001–9010) → HSM (:9099)
```

### Main Server (`authenx-node/`)

- Zero npm dependencies — uses only Node.js 22 built-ins (`crypto`, `http`, `sqlite`)
- SQLite database (`authenx.db`) stores only: `token_id`, `college_id`, `student_ref_token`, hash, signature, status — **never names, CGPA, or personal data**
- Serves an embedded HTML SPA at `/` via `src/server.js`
- All routes under `/v1/` — see `src/routes/` for auth, tokens, verify, colleges, audit, privacy

### HSM (`authenx-hsm/`)

- Localhost-only HTTP service on port 9099
- Stores one Ed25519 key pair per college in `keys/{college-id}.json`
- No keys ever leave this service — callers send data to sign, receive only the signature

### College Connectors (`authenx-connector/`, instantiated in `colleges/`)

- 10 instances, one per college, ports 9001–9010
- Each has its own `.env` (college ID, port, DB path, private key hex, HMAC shared secret)
- Bridges college ERP (SQLite mock, or real MySQL/Postgres/MSSQL via adapters) to AuthenX
- Builds a deterministic canonical JSON fingerprint → sends to HSM for signing
- Returns only signature + minimal fields (name, degree, branch, CGPA, grad year)
- `connector.js` = SQLite-only (active); `universal-connector.js` = multi-DB adapter

### College Registry (`colleges/registry.json`)

Master list of 10 colleges with their UUIDs, ports, Ed25519 public keys, and HMAC shared secrets. This file is the source of truth for college configuration.

## Cryptography

All crypto is in `authenx-node/src/crypto/index.js` using Node.js built-ins only:

| Algorithm | Use |
|-----------|-----|
| Ed25519 | College credential signing and verification |
| AES-256-GCM | AuthenX Code encryption (`AX1.<base64>` format) |
| SHA-256 | Canonical payload hashing |
| HS256 (JWT) | API authentication tokens |
| Scrypt | Password hashing |
| HMAC-SHA256 | Inter-service request authentication |

**AuthenX Code format**: `AX1.<AES-256-GCM encrypted base64>` — contains `{token_id, college_id, student_ref_token, credential_type}`.

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

- **Connector → Main Server**: HMAC-SHA256 (`X-HMAC-Signature` header) using per-college `shared_secret`
- **Main Server → Connector**: same HMAC mechanism
- **All signing**: routed through HSM; private keys never leave `authenx-hsm/`

## Test Credentials

| Role | Email | Password |
|------|-------|----------|
| super_admin | admin@authenx.in | Admin@123 |
| college_admin | iitb@authenx.in | College@123 |
| employer | recruiter@infosys.com | Employer@123 |

Pre-generated test AuthenX codes are in `seed_codes.json`.

## Two Parallel Implementations

| | `authenx-node/` | `authenx/` |
|--|----------------|-----------|
| Status | **Active / production** | In progress |
| Runtime | Node 22, zero deps | TypeScript, Fastify |
| DB | SQLite (built-in) | PostgreSQL |
| Frontend | Embedded HTML SPA | React (Vite) |
| Connector | `authenx-connector/` | `packages/connector/` |

Always confirm which implementation the user is working on before making changes.

## Key Files

| File | Purpose |
|------|---------|
| `authenx-node/src/server.js` | Main HTTP server, all route registration, embedded SPA |
| `authenx-node/src/routes/verify.js` | Live verification + code decode logic |
| `authenx-node/src/crypto/index.js` | All cryptographic primitives |
| `authenx-node/src/middleware/hmac-auth.js` | Inter-service HMAC verification |
| `authenx-connector/connector.js` | SQLite ERP bridge (active) |
| `authenx-connector/universal-connector.js` | Multi-DB connector |
| `authenx-connector/core/canonicalizer.js` | Deterministic JSON fingerprinting |
| `authenx-hsm/server.js` | Key vault service |
| `authenx-hsm/key-store.js` | Ed25519 key pair management |
| `colleges/registry.json` | Master college config (IDs, ports, keys) |
| `prd.md` | Full product requirements |
| `CONTEXT.md` | System architecture reference |
