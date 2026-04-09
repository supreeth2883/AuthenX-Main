# AuthenX Security Reference

**Date:** 2026-04-06
**Status:** All critical and high priority issues resolved

---

## Critical Fixes (Priority 1)

### 1. Secrets Exposure Prevention
**Files:** `.gitignore`

Sensitive files were not excluded from git. Fixed by adding to `.gitignore`:
```gitignore
aes_key.json
**/aes_key.json
**/.env
.env
**/seed_codes.json
seed_codes.json
**/connector_key.json
connector_key.json
authenx-hsm/keys/*.json
authenx-hsm/.master_key
authenx-hsm/*.jsonl
```

---

### 2. Wildcard CORS
**Files:** `authenx-node/src/server.js`, `authenx-connector/connector.js`, `authenx-hsm/server.js`

`Access-Control-Allow-Origin: *` allowed any website to make authenticated API requests. Fixed with configurable origin allowlist:

```javascript
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,...')
  .split(',').map(o => o.trim()).filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}
```

HSM hardcoded to `http://localhost:3000` (localhost-only service, no env var needed).

---

### 3. SQL Injection
**File:** `authenx-node/src/server.js:261`

String interpolation in SQL WHERE clause replaced with parameterized queries and UUID validation:

```javascript
// Before (vulnerable):
const filter = `WHERE t.college_id = '${claims.college_id}'`;

// After (secure):
const isCollegeAdmin = claims.role === 'college_admin';
const collegeId = claims.college_id;
if (isCollegeAdmin && collegeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collegeId)) {
  return res.end(JSON.stringify({ error: 'Invalid college_id format' }));
}
const monthly = isCollegeAdmin
  ? query('SELECT ... WHERE t.college_id = ?', [collegeId])
  : query('SELECT ... FROM verification_tokens t');
```

---

### 4. JWT Revocation Not Enforced
**File:** `authenx-node/src/crypto/index.js`

`isJwtRevoked()` existed but was never called. Fixed:

```javascript
function verifyJwt(token) {
  // ... signature verification ...
  if (payload.jti && isJwtRevoked(payload.jti)) {
    throw new Error('JWT has been revoked');
  }
  return payload;
}
```

---

### 5. JWT Secret Not Persistent
**File:** `authenx-node/src/crypto/index.js`

Random `JWT_SECRET` on each restart invalidated all tokens. Fixed:

```javascript
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET not set - generating random secret (dev only)');
  return crypto.randomBytes(32).toString('hex');
})();
```

---

## High Priority Fixes (Priority 2)

### 6. HSM Keys Stored in Plaintext
**Files:** `authenx-hsm/key-store.js`

Private keys were stored as plain JSON. Fixed with AES-256-GCM envelope encryption:

```javascript
const MASTER_KEY = (() => {
  if (process.env.HSM_MASTER_KEY) return Buffer.from(process.env.HSM_MASTER_KEY, 'hex');
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: HSM_MASTER_KEY required in production'); process.exit(1);
  }
  // Dev: generate and persist to .master_key file (gitignored)
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync('.master_key', JSON.stringify({ master_key_hex: newKey.toString('hex') }));
  return newKey;
})();

function encryptPrivateKey(privateKeyHex) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKeyHex, 'hex')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64');
}
```

Key files auto-migrate from plaintext to encrypted format on first read.

**Key file format (post-migration):**
```json
{
  "college_id": "uuid",
  "encrypted_private_key": "base64...",
  "public_key_hex": "hex...",
  "version": 1,
  "migrated_to_encrypted": true
}
```

---

### 7. Weak Default Passwords
**Files:** `authenx-node/src/db/schema.js`, `authenx-node/src/server.js`, `authenx-node/src/routes/auth.js`

Predictable default passwords (`Admin@123`, `College@123`, `Employer@123`) without forced change. Fixed:

- Added `must_change_password` and `last_password_change` columns to `users` table
- All seeded users have `must_change_password = 1`
- Login response includes `"must_change_password": true` when set
- New endpoint `POST /v1/auth/change-password`:
  - Verifies current password
  - Enforces: 12+ chars, uppercase, lowercase, number, special character
  - Revokes all existing refresh tokens (force re-login on other devices)
  - Clears `must_change_password` flag

---

### 8. No Request Size Limit on Connector
**File:** `authenx-connector/connector.js`

No payload size limit allowed potential DoS. Fixed with 64KB limit:

```javascript
const MAX_PAYLOAD_SIZE = 64 * 1024;
req.on('data', (c) => {
  totalLength += c.length;
  if (totalLength > MAX_PAYLOAD_SIZE) { req.destroy(); reject(new Error('Payload too large')); }
  chunks.push(c);
});
```

---

## Medium Priority Improvements (Priority 3)

### 9. Graceful Shutdown
**Files:** `authenx-node/src/server.js`, `authenx-hsm/server.js`, `authenx-connector/connector.js`

No signal handlers caused requests to be interrupted during deployment. Fixed with 10-second graceful shutdown:

```javascript
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  server.close(() => { console.log('All connections closed'); process.exit(0); });
  setTimeout(() => { console.error('Forced shutdown after 10s'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
```

---

### 10. Request Logging and Correlation IDs
**Files:** `authenx-node/src/server.js`, `authenx-connector/connector.js`, `authenx-hsm/server.js`

Request logging and correlation IDs implemented across all services. Every request gets a unique `X-Request-ID` header. Logs include method, path, status code, and latency.

---

### 11. Environment Configuration Template
**File:** `.env.example` (new)

Comprehensive environment variable template with security checklist created. Covers `JWT_SECRET`, `HSM_MASTER_KEY`, `CORS_ALLOWED_ORIGINS`, DB paths, and production deployment notes.

---

## Required Environment Variables

### Production (`NODE_ENV=production`)
```bash
# REQUIRED — server exits without these:
JWT_SECRET=<64-char hex>          # generate: openssl rand -hex 32
HSM_MASTER_KEY=<64-char hex>      # generate: openssl rand -hex 32

# OPTIONAL (have defaults):
CORS_ALLOWED_ORIGINS=https://app.authenx.in,https://authenx.in
PORT=3000
HSM_PORT=9099
```

### Development (default)
```bash
# All optional — auto-generated with warnings:
JWT_SECRET            # WARNING logged
HSM_MASTER_KEY        # WARNING logged, saved to .master_key (gitignored)
CORS_ALLOWED_ORIGINS  # defaults to localhost:3000,localhost:8080
```

---

## Production Deployment Checklist

- [ ] Set `JWT_SECRET` (generate: `openssl rand -hex 32`)
- [ ] Set `HSM_MASTER_KEY` (generate: `openssl rand -hex 32`)
- [ ] Set `NODE_ENV=production`
- [ ] Configure `CORS_ALLOWED_ORIGINS` with actual domains
- [ ] Verify `.env` is in `.gitignore`
- [ ] Confirm all HSM key files show `encrypted_private_key` (not `private_key_hex`)
- [ ] Force password change for all default accounts on first login
- [ ] Enable HTTPS via reverse proxy (nginx/Caddy)
- [ ] Configure firewall: HSM port 9099 localhost-only, connectors accessible only from AuthenX server IPs
- [ ] Configure DB backups
- [ ] Set up log monitoring with correlation ID indexing
- [ ] Review and tune rate limiting thresholds
- [ ] Enable MFA for admin accounts
- [ ] Test graceful shutdown: `kill -TERM <pid>` — should drain cleanly
- [ ] Verify CORS: unauthorized origin must NOT receive `Access-Control-Allow-Origin` header

---

## Testing Security Fixes

```bash
# 1. Verify secrets are gitignored
git status  # Must NOT show .env, aes_key.json, seed_codes.json

# 2. Test CORS
curl -H "Origin: http://localhost:3000" http://localhost:3000/v1/health  # should work
curl -H "Origin: https://evil.com" http://localhost:3000/v1/health       # no CORS header

# 3. Test JWT revocation after logout
LOGIN=$(curl -s -X POST http://localhost:3000/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@authenx.in","password":"Admin@123"}')
TOKEN=$(echo $LOGIN | jq -r '.token')
REFRESH=$(echo $LOGIN | jq -r '.refresh_token')
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/colleges  # works
curl -X POST http://localhost:3000/v1/auth/logout -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH\"}"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/colleges  # must fail

# 4. Test HSM key encryption
cd authenx-hsm && node server.js
cat keys/*.json | jq .encrypted_private_key  # base64 — key is encrypted
cat keys/*.json | jq .private_key_hex        # null — plaintext gone

# 5. Test graceful shutdown
kill -TERM <server_pid>
# Should log: "SIGTERM received → connections closed → shutdown complete"
```

---

## Remaining Recommendations (Future Work)

These are not security vulnerabilities but would improve production readiness:

1. **Nonce storage** — Move from in-memory Map to Redis for multi-instance deployments
2. **Rate limiting** — Use Redis for distributed rate limiting instead of per-process in-memory
3. **Direct TLS** — Add TLS support directly rather than relying solely on reverse proxy
4. **Unit tests** — Add tests for crypto, auth, and validation modules
5. **Password reset** — Email-based password reset flow
6. **Session dashboard** — Admin view to list/revoke active sessions
7. **IP allowlist** — Optional per-route IP allowlist for admin endpoints
8. **MFA recovery** — SMS or email backup codes for TOTP
