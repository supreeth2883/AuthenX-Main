# AuthenX Security Reference

**Last Updated:** 2026-04-11
**Status:** All critical and high priority issues resolved

---

## Critical Fixes (Priority 1)

### 1. Secrets Exposure Prevention
**File:** `.gitignore`

Sensitive files excluded from git:
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
**Files:** `authenx-node/src/server.js`, `authenx-hsm/server.js`

`Access-Control-Allow-Origin: *` replaced with configurable origin allowlist:

```javascript
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,...')
  .split(',').map(o => o.trim()).filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (isLocalDevOrigin(origin)) {
    // Allow localhost during development
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}
```

HSM is hardcoded to `127.0.0.1` (localhost-only service).

---

### 3. SQL Injection
**File:** `authenx-node/src/server.js`, all route files

All queries use parameterized statements. UUID format validated before use:

```javascript
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collegeId)) {
  return res.end(JSON.stringify({ error: 'Invalid college_id format' }));
}
```

---

### 4. JWT Revocation Not Enforced
**File:** `authenx-node/src/crypto/index.js`

`isJwtRevoked()` now called in `verifyJwt()` on every request. JTI-based in-memory revocation list with 10,000-entry cap and 30-minute cleanup.

---

### 5. JWT Secret Not Persistent
**File:** `authenx-node/src/crypto/index.js`

```javascript
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
  }
  // Dev: persist to aes_key.json so sessions survive server restarts
  ...
})();
```

---

## High Priority Fixes (Priority 2)

### 6. HSM Keys Stored in Plaintext
**File:** `authenx-hsm/key-store.js`

Private keys AES-256-GCM encrypted with HSM_MASTER_KEY. Key files auto-migrate from plaintext on first read.

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

### 7. College Private Keys in Main DB
**File:** `authenx-node/src/db/schema.js`, `authenx-node/src/routes/colleges.js`

Keys generated at onboarding (`POST /v1/colleges/onboard`) are stored in the `college_keys` table with the private key AES-256-GCM encrypted via `encryptSecret()`:

```javascript
const { publicKeyHex, privateKeyHex } = generateEd25519KeyPair();
const private_key_enc = encryptSecret(privateKeyHex); // AES-256-GCM, reuses AES_KEY
run(
  'INSERT INTO college_keys (college_id, public_key_hex, private_key_enc) VALUES (?,?,?)',
  [college_id, publicKeyHex, private_key_enc]
);
```

This is in addition to the HSM — the main server holds an encrypted copy for direct signing use when the HSM is unavailable.

---

### 8. Weak / Predictable Temporary Passwords
**File:** `authenx-node/src/crypto/index.js`

`generateTempPassword()` produces a 16-char cryptographically random password (uppercase + lowercase + digits + symbols, guaranteed at least one of each, Fisher-Yates shuffled). Hashed with scrypt before storage.

---

### 9. Forced Password Change on All Seeded Accounts
**Files:** `authenx-node/src/db/schema.js`, `authenx-node/src/routes/auth.js`

`must_change_password` column on `users`. All seeded accounts + college admin accounts created via onboarding have `must_change_password = 1`. Login response includes the flag; password change endpoint:
- Verifies current password
- Enforces 12+ chars, uppercase, lowercase, number, special character
- Revokes all existing refresh tokens (force re-login on other devices)
- Clears `must_change_password` flag

---

### 10. No Request Size Limit
**File:** `authenx-node/src/server.js`

1MB payload limit enforced on all routes:

```javascript
const MAX_PAYLOAD_SIZE = 1024 * 1024;
req.on('data', (c) => {
  totalLength += c.length;
  if (totalLength > MAX_PAYLOAD_SIZE) { req.destroy(); reject(new Error('Payload too large')); }
  chunks.push(c);
});
```

---

## Medium Priority Improvements (Priority 3)

### 11. Graceful Shutdown
**File:** `authenx-node/src/server.js`, `authenx-hsm/server.js`

SIGTERM/SIGINT handlers with 10-second drain window before forced exit.

---

### 12. Request Logging and Correlation IDs
**File:** `authenx-node/src/middleware/logger.js`

Structured JSON logs with `X-Request-ID` correlation header on every response. Includes method, path, status code, latency. Daily log rotation.

---

### 13. Rate Limiting
**File:** `authenx-node/src/middleware/rate-limiter.js`, `authenx-node/src/server.js`

Two-layer sliding window rate limiter:
- `rate-limiter.js`: verify 30 req/min per employer user (JWT user ID), issue 20 req/min per college admin, global 200 req/min per IP
- `server.js` (inline): additional 50 req/min per IP hard cap before routes are evaluated

---

### 14. Fraud Detection
**File:** `authenx-node/src/middleware/fraud-detector.js`

Behavioral anomaly detection with 5 rules:
- `RAPID_FIRE` — burst of requests in short time window
- `SEQUENTIAL_SCAN` — systematically incrementing student references
- `GEO_ANOMALY` — IP changes mid-session
- `BRUTE_FORCE` — repeated failed verifications
- `OFF_HOURS` — access outside business hours

Alerts stored in `fraud_alerts` table with severity levels (low/medium/high/critical).

---

### 15. Circuit Breaker for Connectors
**File:** `authenx-node/src/middleware/circuit-breaker.js`

Per-college circuit breaker: CLOSED → OPEN → HALF_OPEN states with 30-second recovery timer. Prevents cascading failures when a connector is down.

---

### 16. MFA Support
**File:** `authenx-node/src/middleware/totp.js`, `authenx-node/src/routes/auth.js`

RFC 6238 TOTP implementation (built-in, no npm packages):
- 6-digit codes, ±1 step drift tolerance
- TOTP secrets AES-256-GCM encrypted in `mfa_secrets` table
- 10 one-time backup codes (SHA-256 hashed) in `mfa_backup_codes`
- Enroll → Confirm → required on subsequent logins

---

### 17. Input Sanitization & XSS Prevention
**File:** `authenx-node/src/middleware/validation.js`

`sanitizeObject()` applied to all request bodies. Strips `<script>` and event handler attributes. Validates emails, UUIDs, password complexity.

---

### 18. DPDP Act 2023 Compliance
**File:** `authenx-node/src/middleware/dpdp.js`, `authenx-node/src/routes/privacy.js`

India Digital Personal Data Protection Act built-in:
- Explicit consent collection and revocation (`consent_records`)
- Data Subject Access Requests — full data export
- Right to erasure (`erasure_requests`) with processing workflow
- Configurable data retention policy enforcement
- Privacy notice endpoint

---

### 19. XSS and Security Headers
**File:** `authenx-node/src/server.js`

Security headers on every response:
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
Referrer-Policy: strict-origin-when-cross-origin
X-Permitted-Cross-Domain-Policies: none
```

---

## Required Environment Variables

### Production (`NODE_ENV=production`)
```bash
# REQUIRED — server exits without these:
JWT_SECRET=<64-char hex>          # generate: openssl rand -hex 32
HSM_MASTER_KEY=<64-char hex>      # generate: openssl rand -hex 32

# OPTIONAL (have secure defaults):
AES_KEY_HEX=<64-char hex>         # AES key for AuthenX Codes (auto-generated if missing)
CORS_ALLOWED_ORIGINS=https://app.authenx.in,https://authenx.in
PORT=3000
HSM_PORT=9099
LOG_LEVEL=info

# Main AuthenX database (PostgreSQL):
AUTHENX_PG_HOST=postgres.internal
AUTHENX_PG_PORT=5432
AUTHENX_PG_USER=authenx
AUTHENX_PG_DATABASE=authenx

# PostgreSQL college provisioning (optional feature):
PG_PROVISION_HOST=postgres.internal
PG_PROVISION_PORT=5432
PG_PROVISION_USER=postgres
PG_PROVISION_PASSWORD=<password>
```

### Development (default)
```bash
# All optional — auto-generated with warnings:
# JWT_SECRET        — WARNING logged; persisted to aes_key.json (gitignored)
# HSM_MASTER_KEY    — WARNING logged; saved to .master_key (gitignored)
# CORS_ALLOWED_ORIGINS — defaults to localhost:3000,localhost:8080,127.0.0.1:3000
```

---

## Production Deployment Checklist

- [ ] Set `JWT_SECRET` (generate: `openssl rand -hex 32`)
- [ ] Set `HSM_MASTER_KEY` (generate: `openssl rand -hex 32`)
- [ ] Set `NODE_ENV=production`
- [ ] Set `AES_KEY_HEX` and back it up (losing it invalidates all AuthenX Codes)
- [ ] Configure `CORS_ALLOWED_ORIGINS` with actual domains
- [ ] Verify `.env` and `aes_key.json` are in `.gitignore`
- [ ] Confirm all HSM key files show `encrypted_private_key` (not `private_key_hex`)
- [ ] Force password change for all default accounts on first login
- [ ] Enable HTTPS via reverse proxy (nginx/Caddy)
- [ ] Configure firewall: HSM port 9099 localhost-only; connectors accessible only from AuthenX IPs
- [ ] Configure PostgreSQL backups (pg_dump / WAL archiving for authenx database)
- [ ] Set up log monitoring with correlation ID indexing
- [ ] Review and tune rate limiting thresholds
- [ ] Enable MFA for all admin accounts (`POST /v1/auth/mfa/enroll`)
- [ ] Test graceful shutdown: `kill -TERM <pid>` — should drain cleanly
- [ ] Verify CORS: unauthorized origin must NOT receive `Access-Control-Allow-Origin` header
- [ ] Verify `/v1/metrics` and `/v1/fraud-alerts` require super_admin role

---

## Testing Security Fixes

```bash
# 1. Verify secrets are gitignored
git status  # Must NOT show .env, aes_key.json, seed_codes.json

# 2. Test CORS
curl -H "Origin: http://localhost:3000" http://localhost:3000/v1/health  # should work
curl -H "Origin: https://evil.com" http://localhost:3000/v1/health       # no CORS header returned

# 3. Test rate limiting
for i in {1..55}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health; done
# Should see 429 after 50 requests within 60 seconds

# 4. Test JWT revocation after logout
LOGIN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" -d '{"email":"admin@authenx.in","password":"Admin@123"}')
TOKEN=$(echo $LOGIN | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
REFRESH=$(echo $LOGIN | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).refresh_token))")
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/colleges   # 200 OK
curl -X POST http://localhost:3000/v1/auth/logout \
  -H "Content-Type: application/json" -d "{\"refresh_token\":\"$REFRESH\"}"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/colleges   # must return 401

# 5. Test HSM key encryption
cd authenx-hsm && node server.js &
cat keys/*.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('encrypted_private_key' in d)"
# Should print: True

# 6. Test college onboarding
curl -s -X POST http://localhost:3000/v1/colleges/onboard \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Test College","short_code":"TSTC","admin_email":"admin@test.edu","connector_url":"http://localhost:9099"}'
# Should return 201 with college_id, public_key_hex, admin_temp_password

# 7. Test password complexity enforcement
curl -X POST http://localhost:3000/v1/auth/change-password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"current_password":"Admin@123","new_password":"weak"}'
# Should return 400 with complexity error
```

---

## Remaining Recommendations (Future Work)

1. **Nonce storage** — Move from in-memory Map to Redis for multi-instance deployments
2. **Rate limiting** — Use Redis for distributed rate limiting (current implementation is per-process)
3. **JWT revocation** — Move from in-memory Set to Redis or DB for persistence across restarts
4. **Direct TLS** — Add TLS support directly rather than relying solely on reverse proxy
5. **Unit tests** — Add tests for crypto, auth, validation, and fraud-detection modules
6. **Password reset** — Email-based password reset flow (currently admin must onboard again)
7. **Session dashboard** — Admin view to list/revoke active sessions by JTI
8. **IP allowlist** — Optional per-route IP allowlist for admin endpoints
9. **MFA recovery** — Improved backup code management and account recovery flow
10. **PostgreSQL provisioning retry** — Admin endpoint to retry failed provisioning (`provisioned=0`)
