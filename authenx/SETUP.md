# AuthenX TypeScript Monorepo — Setup Guide

This guide covers the TypeScript/Fastify/PostgreSQL implementation in `authenx/`. For the active production Node.js server see the root [README.md](../README.md) and [CONTEXT.md](../CONTEXT.md).

---

## Prerequisites — Install These First

Before anything else, install these on your machine:

1. **Node.js 18+** — https://nodejs.org (download the LTS version)
2. **Docker Desktop** — https://docker.com/products/docker-desktop
3. **Git** — https://git-scm.com
4. **VS Code** — https://code.visualstudio.com (recommended editor)

Verify installations:
```bash
node --version    # should show v18 or higher
npm --version     # should show 9 or higher
docker --version  # any recent version
```

---

## Step 1: Set Up Environment Variables

### API
```bash
cd packages/api
cp .env.example .env
```

Open `packages/api/.env` and fill in:
- `JWT_SECRET` — generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `CONNECTOR_SECRET` — generate the same way
- `AUTHENX_CODE_ENCRYPTION_KEY` — generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Leave `DATABASE_URL` as-is for local development (matches Docker compose).

### Connector
```bash
cd packages/connector
cp .env.example .env
```

Open `packages/connector/.env` and fill in:
- `CONNECTOR_SECRET` — use the SAME value as API's `CONNECTOR_SECRET`
- `COLLEGE_ISSUER_ID` — use any UUID for now (e.g., `550e8400-e29b-41d4-a716-446655440000`)
- `COLLEGE_PRIVATE_KEY` — generate in the next step

---

## Step 2: Generate a College Key Pair

```bash
cd packages/connector
npm install
npm run keygen
```

This prints:
- A **private key** (128 hex chars) → paste into `COLLEGE_PRIVATE_KEY` in connector `.env`
- A **public key** (64 hex chars) → save this; you'll register it with AuthenX when onboarding a college

---

## Step 3: Start the Database

```bash
# From the project root (where docker-compose.yml is)
docker-compose up -d
```

Wait about 10 seconds, then verify it's running:
```bash
docker-compose ps
# Should show: authenx-postgres  running
```

---

## Step 4: Install All Dependencies

```bash
# From the project root
npm install
```

This installs dependencies for all packages (api, connector, web) at once.

---

## Step 5: Run Database Migrations

```bash
cd packages/api
npm run db:migrate
```

This creates all the tables in PostgreSQL. You should see:
```
Running AuthenX database migrations...
  → Running 001_initial_schema.sql...
  ✓ 001_initial_schema.sql applied successfully
All migrations complete.
```

---

## Step 6: Start the Services

Open **3 separate terminal windows**:

**Terminal 1 — API**
```bash
cd packages/api
npm run dev
```
✅ Should print: `AuthenX API running at http://0.0.0.0:3001`

**Terminal 2 — Connector**
```bash
cd packages/connector
npm run dev
```
✅ Should print: `AuthenX Connector running at http://0.0.0.0:3002`

**Terminal 3 — Web App**
```bash
cd packages/web
npm run dev
```
✅ Should print: `Local: http://localhost:5173`

---

## Step 7: Verify Everything Works

### Health checks
```bash
curl http://localhost:3001/health   # API
curl http://localhost:3002/health   # Connector
```

Both should return: `{"status":"ok",...}`

---

## Step 8: Create Your First Admin User

Run this SQL in your PostgreSQL database. Use pgAdmin (http://localhost:5050) or psql:

```sql
-- First install bcrypt to hash the password, or use this pre-hashed 'admin123':
INSERT INTO users (email, password_hash, full_name, role, status)
VALUES (
  'admin@authenx.in',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiGQTf/A1frCm.HeSLEf2F2WfHK2',  -- password: admin123
  'AuthenX Admin',
  'super_admin',
  'active'
);
```

Then test login:
```bash
curl -X POST http://localhost:3001/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@authenx.in","password":"admin123"}'
```

You should receive a JWT token. You're in.

---

## Project Structure

```
authenx/
├── packages/
│   ├── api/           ← AuthenX API (Fastify + TypeScript)
│   │   ├── src/
│   │   │   ├── config/env.ts          ← All env vars validated here
│   │   │   ├── db/client.ts           ← PostgreSQL connection
│   │   │   ├── db/migrations/         ← SQL migration files
│   │   │   ├── utils/crypto.ts        ← SHA-256, Ed25519, AES-256 code encryption
│   │   │   ├── middleware/auth.ts     ← JWT + RBAC middleware
│   │   │   └── modules/
│   │   │       ├── auth/              ← Login, me
│   │   │       ├── tokens/            ← Issue, revoke, get token
│   │   │       └── verify/            ← Decode code, live verification
│   │
│   ├── connector/     ← AuthenX Connector (crypto engine + adapter)
│   │   ├── src/
│   │   │   ├── core/canonicalize.ts   ← Deterministic canonical fingerprint
│   │   │   ├── core/crypto.ts         ← Ed25519 sign engine (private key lives here)
│   │   │   ├── adapters/
│   │   │   │   ├── mock.adapter.ts    ← Test data adapter (use this first)
│   │   │   │   ├── db.adapter.ts      ← Real DB adapter (Phase 3)
│   │   │   │   └── api.adapter.ts     ← ERP API adapter (Phase 3)
│   │   │   └── routes/verify.ts       ← Handles live verification requests
│   │
│   └── web/           ← Employer Web App (React + TypeScript)
│       └── src/
│           ├── api/client.ts          ← Axios API client
│           └── pages/Verify.tsx       ← Main verification UI
│
├── docker-compose.yml ← PostgreSQL + Redis for local dev
├── .env.example       ← Root environment template
└── SETUP.md           ← This file
```

---

## Common Issues

**Database connection refused**
→ Make sure Docker is running: `docker-compose up -d`

**JWT_SECRET too short**
→ Generate a proper 32-byte secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Connector COLLEGE_PRIVATE_KEY error**
→ Run `npm run keygen` in packages/connector and copy the private key

**Port already in use**
→ Change `API_PORT` or `CONNECTOR_PORT` in the relevant `.env` file
