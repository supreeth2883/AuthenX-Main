# AuthenX Codebase — Flaws, Issues & Technical Debt

**Last Updated:** 2026-04-11 | Branch: `backend-change` | Severity Levels: 🔴 CRITICAL | 🟠 HIGH | 🟡 MEDIUM | 🟢 LOW

---

## 1. Critical System-Level Issues

### 🔴 CRITICAL: Connector Service Deleted
**File(s):** `authenx-connector/` (entire directory gone)
**Severity:** BLOCKER — System cannot function
**Impact:**
- `/v1/verify/live` endpoint is unreachable — calls `connectorVerify()` which tries to fetch from undefined connector URLs
- College verification flow is **completely non-functional**
- `POST /v1/colleges/onboard` succeeds but connector deployment is impossible
- `GET /v1/connectors/health` will always return failures (empty college list or 404 errors)

**Root Cause:** Commit `e0fa551` deleted the entire connector directory during "security hardening" cleanup.

**To Fix:** Restore from prior commits:
```bash
git checkout HEAD~1 -- authenx-connector/
git restore --staged authenx-connector/
git commit -m "Restore deleted connector service"
```

**Related Files:**
- `authenx-node/src/routes/connector-proxy.js` — Expects connector service to exist
- `authenx-node/src/routes/verify.js` (liveVerify function) — Calls connector via HTTP

---

### ✅ RESOLVED: NPM Dependency `pg` — Decision Made
**File(s):** `authenx-node/package.json`
**Status:** Resolved — `pg` is the only npm dependency and it is required.

`pg` is now used as the main AuthenX database driver (`db/client.js`), mock ERP, and college DB provisioning. The "zero npm dependencies" original design goal is superseded by the PostgreSQL migration.

---

### 🔴 CRITICAL: Missing Docker Orchestration
**File(s):** `docker-compose.yml` (deleted), `Dockerfile`, `Dockerfile.connector`
**Severity:** Cannot deploy or test locally
**Impact:**
- Full stack cannot be started via docker-compose (single command)
- CI/CD pipelines broken — no containerization
- Production deployment path unclear
- 10 college connectors cannot be orchestrated

**To Fix:** Restore from prior commits:
```bash
git checkout HEAD~1 -- docker-compose.yml Dockerfile Dockerfile.connector
```

Or generate new ones:
```dockerfile
# Dockerfile (main server)
FROM node:22-alpine
WORKDIR /app
COPY authenx-node ./authenx-node
COPY authenx-hsm ./authenx-hsm
ENV JWT_SECRET=dev HSM_MASTER_KEY=dev
EXPOSE 3000 9099
CMD ["node", "authenx-node/src/server.js"]
```

---

## 2. High-Priority Bugs & Flaws

### 🟠 HIGH: Connector Proxy Routes Reference Non-Existent Service
**File(s):** `authenx-node/src/routes/connector-proxy.js`
**Severity:** Runtime errors on every college verification
**Issue:**
```javascript
async function connectorVerify(college, studentRefToken, nonce) {
  const url = `http://${college.connector_url}:${college.connector_port}/verify`;
  // Will ALWAYS fail: connector service doesn't exist
  // Will timeout after connecting to non-existent host
}
```

**Impact:**
- `POST /v1/verify/live` → hangs for 30+ seconds → timeout
- No graceful error message — client sees generic 500
- No circuit breaker protection (circuit breaker exists but connector never responds)

**To Fix:** 
1. Restore connector service (see 🔴 CRITICAL issue above)
2. Add timeout + error handling:
```javascript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
try {
  const res = await fetch(url, { signal: controller.signal });
  // ...
} catch (err) {
  if (err.name === 'AbortError') {
    return { error: 'Connector timeout', status: 'UNAVAILABLE' };
  }
  throw err;
} finally {
  clearTimeout(timeout);
}
```

---

### 🟠 HIGH: Mock ERP Cannot Issue Tokens
**File(s):** `authenx-node/src/mock-erp/cvr-erp.js`
**Severity:** Test data cannot be generated
**Issue:**
```javascript
// Token issuance in routes/tokens.js calls:
const canonicalHash = hashCredential(fields);
// But there's no way to populate test data into the ERP mock

// When employer tries to verify, connector queries mock ERP
// but the student record doesn't exist
```

**Impact:**
- Test end-to-end flow requires manual database manipulation
- No seed script to generate test credentials
- New developers cannot run verification tests

**To Fix:** Create `authenx-node/seed.js`:
```javascript
const { run } = require('./src/db/client.js');

// Seed 5 test students with issued tokens
async function seedTestData() {
  const collegeId = 'iitb-uuid';
  
  // Insert test students
  run(`INSERT INTO verification_tokens 
      (id, college_id, student_ref_token, canonical_hash, issuance_signature, ...)
      VALUES (?, ?, ?, ?, ?, ...)`, 
      [genUUID(), collegeId, 'ENR001', 'hash...', 'sig...']);
}

node seed.js  // Generate test data once
```

---

### ✅ RESOLVED: Main DB Migrated to PostgreSQL
**File(s):** `authenx-node/src/db/client.js`, `authenx-node/src/db/schema.js`
**Status:** Fixed — entire main AuthenX database migrated from `node:sqlite` to `pg` Pool.

`db/client.js` now uses a `pg.Pool` with `AUTHENX_PG_*` environment variables.
All 18 tables use PostgreSQL DDL. All routes and middleware use async `run`/`query`/`queryOne`.

---

### 🟠 HIGH: Connector URL Validation Missing
**File(s):** `authenx-node/src/routes/colleges.js` (onboardCollege function)
**Severity:** Configuration errors not caught early
**Issue:**
```javascript
async function onboardCollege(req, body) {
  // No validation that connector_url is:
  // ✗ A valid URL format
  // ✗ Reachable (health check not performed)
  // ✗ Matches expected port
  // ✗ Supports the required /verify endpoint
  
  const collegeId = genUUID();
  run(`INSERT INTO colleges (connector_url, connector_port, ...)
       VALUES (?, ?, ...)`, [body.connector_url, body.connector_port]);
  // College created even if connector is unreachable
}
```

**Impact:**
- Invalid connectors registered silently
- Errors only discovered during first verification attempt (24h+ later)
- Hard to debug which colleges have bad connectors

**Test Case:**
```json
POST /v1/colleges/onboard
{
  "name": "Bad College",
  "connector_url": "not-a-valid-url",
  "connector_port": 9001
}
// Response: 201 Created (successful, but connector is unreachable)
```

**To Fix:** Add validation + health check:
```javascript
async function onboardCollege(req, body) {
  // Validate URL format
  try {
    new URL(`http://${body.connector_url}:${body.connector_port}`);
  } catch (err) {
    return res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid connector URL' }));
  }
  
  // Health check
  try {
    const response = await fetch(
      `http://${body.connector_url}:${body.connector_port}/health`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) throw new Error('Health check failed');
  } catch (err) {
    return res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Connector unreachable' }));
  }
  
  // ... proceed with onboarding
}
```

---

### 🟠 HIGH: No Retry Logic for Connector Failures
**File(s):** `authenx-node/src/routes/connector-proxy.js`, `authenx-node/src/routes/verify.js`
**Severity:** Single network blip breaks verification
**Issue:**
```javascript
async function liveVerify(token) {
  const response = await fetch(connectorUrl); // Single attempt
  if (!response.ok) throw new Error('Connector error');
  // No retry, no fallback
}
```

**Impact:**
- Network latency or connector restart = verification failure
- No exponential backoff
- Poor user experience ("try again later" never provided)

**To Fix:** Add retry logic:
```javascript
async function callConnectorWithRetry(url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 100)); // exponential backoff
    }
  }
}
```

---

## 3. Medium-Priority Issues

### 🟡 MEDIUM: Canonical JSON Field Order Not Validated
**File(s):** `authenx-node/src/crypto/index.js`
**Severity:** Silent hash mismatches
**Issue:**
```javascript
function buildCanonicalJson(fields) {
  const ordered = {
    schema_version: ...,
    issuer_id: ...,
    student_ref_token: ...,
    // ... But if a NEW field is added, order might drift
  };
  return JSON.stringify(ordered);
}
```

**Impact:**
- If connector and main server diverge on field order, hashes won't match
- Verification fails silently with "hash mismatch"
- Schema evolution is error-prone (no versioning check)

**To Fix:** Add field order validation:
```javascript
const CANONICAL_FIELD_ORDER = [
  'schema_version', 'issuer_id', 'student_ref_token',
  'name', 'degree', 'branch', 'credential_type',
  'cgpa', 'graduation_year', 'issue_date'
];

function buildCanonicalJson(fields) {
  const ordered = {};
  for (const field of CANONICAL_FIELD_ORDER) {
    ordered[field] = String(fields[field] || '').trim();
  }
  // Verify no fields are missing from input
  const missingFields = CANONICAL_FIELD_ORDER.filter(f => !(f in fields));
  if (missingFields.length > 0) {
    throw new Error(`Missing canonical fields: ${missingFields.join(', ')}`);
  }
  return JSON.stringify(ordered);
}
```

---

### 🟡 MEDIUM: HMAC Signature Algorithm Not Documented
**File(s):** `authenx-node/src/middleware/hmac-auth.js`
**Severity:** Integration difficulty
**Issue:**
```javascript
// No documentation on HMAC signature format:
// - What is signed? (full request body? specific fields?)
// - Header name? (X-HMAC-Signature? Authorization?)
// - How is signature computed? (HMAC-SHA256? With what key?)
// - What's the nonce format?
```

**Impact:**
- College connector developers cannot implement compatible HMAC logic
- Leads to "signature verification failed" without clear fix
- Takes hours of debugging to find mismatch

**To Fix:** Add detailed comment block:
```javascript
/**
 * Inter-Service HMAC Authentication
 * 
 * Used for: AuthenX Main ↔ College Connector communication
 * 
 * Request Format:
 * - Header: X-HMAC-Signature: <signature>
 * - Key: college.shared_secret (hex)
 * - Message: {
 *     "nonce": "uuid or timestamp",
 *     "timestamp": unix_timestamp_ms,
 *     "body": request_body_json
 *   }
 * - Algorithm: HMAC-SHA256
 * - Signature Format: base64url (no padding)
 * 
 * Example:
 * const message = JSON.stringify({ nonce, timestamp, body });
 * const sig = crypto
 *   .createHmac('sha256', secretKey)
 *   .update(message)
 *   .digest('base64url');
 * fetch(url, {
 *   headers: { 'X-HMAC-Signature': sig }
 * });
 */
```

---

### 🟡 MEDIUM: No Circuit Breaker for HSM
**File(s):** `authenx-node/src/middleware/circuit-breaker.js`
**Severity:** HSM outage cascades to all verifications
**Issue:**
```javascript
// Circuit breaker exists for connectors but NOT for HSM
// If HSM is down, ALL token issuance fails (no fallback)
```

**Impact:**
- HSM restart during business hours = all credential issuance blocked
- No "open circuit" mode (e.g., use cached/pre-signed tokens)
- Single point of failure

**To Fix:** Add HSM circuit breaker:
```javascript
const hsmCircuitBreaker = new CircuitBreaker({
  endpoint: 'http://localhost:9099',
  failureThreshold: 5,     // Open after 5 failures
  resetTimeout: 30000,      // Try to close after 30s
  fallback: async () => {
    // Return cached signing results or queue for later
    return { cached: true };
  }
});
```

---

### ✅ RESOLVED: Discord Between CLAUDE.md and Reality
**File(s):** `CLAUDE.md`, `CONTEXT.md`, `README.md`
**Resolution:** All docs updated (2026-04-11) to reflect:
- `pg` IS used (mock ERP + PG provisioning) — "zero npm deps" claim removed
- Docker files deleted — noted in branch warning
- `authenx-connector/` deleted — noted as critical gap
- Table count corrected to 18 (added `issued_authenx_codes`)
- Route count corrected to ~45 (was incorrectly listed as 75+)
- Rate limiter numbers corrected

---

## 4. Low-Priority Issues & Improvements

### 🟢 LOW: College Onboarding Response Leaks Sensitive Info
**File(s):** `authenx-node/src/routes/colleges.js` (onboardCollege response)
**Severity:** Information disclosure risk
**Issue:**
```javascript
return {
  college_id: ...,
  admin_temp_password: "College@123",  // ← Shown in HTTP response
  shared_secret: "hmac-key...",        // ← Shown in HTTP response
  connector_public_key: "..."          // ← Could be leaked in logs
};
```

**Risk:** If response is logged, cached by proxy, or intercepted, secrets are exposed.

**To Fix:** 
1. Return secrets only once in response, with clear warning:
```javascript
return {
  college_id: ...,
  status: "CREATED",
  warning: "⚠️ Save these secrets immediately — they will not be shown again",
  secrets: {
    admin_temp_password: "...",
    shared_secret: "...",
    connector_public_key: "..."
  }
};
```

2. Log to secure location only (never to debug logs):
```javascript
// ❌ WRONG
logDebug({ adminPassword, sharedSecret }); // logs everything

// ✅ RIGHT
logAudit({ action: 'college_onboarded', collegeId, timestamp }); // only metadata
```

---

### 🟢 LOW: No Health Check for Mock ERP
**File(s):** `authenx-node/src/mock-erp/cvr-erp.js`
**Severity:** Hidden initialization issues
**Issue:**
- Mock ERP database might not exist or be corrupted
- No startup validation
- Errors only surface when first token is issued

**To Fix:** Add health check:
```javascript
function validateMockErpSchema() {
  const tables = query(`SELECT name FROM sqlite_master WHERE type='table'`);
  const requiredTables = ['mock_students', 'mock_credentials'];
  const missingTables = requiredTables.filter(t => !tables.map(r => r.name).includes(t));
  if (missingTables.length > 0) {
    throw new Error(`Mock ERP missing tables: ${missingTables.join(', ')}`);
  }
}

// Call on startup:
server.on('listening', () => validateMockErpSchema());
```

---

### 🟢 LOW: Timestamp Format Inconsistency
**File(s):** Database schema, crypto module, routes
**Severity:** Date parsing bugs in future
**Issue:**
```javascript
// Schema uses SQLite default:
created_at TEXT NOT NULL DEFAULT (datetime('now'))  // ISO 8601: "2026-04-11T12:34:56"

// Some code uses:
const timestamp = Date.now();  // milliseconds since epoch
new Date().toISOString();      // ISO 8601 string
Date.now() / 1000 | 0;         // seconds since epoch
```

**Impact:**
- Future timezone calculations break
- Log analysis tools confused by mixed formats
- Sorting by timestamp unreliable

**To Fix:** Standardize on ISO 8601 + Unix epoch for calculations:
```javascript
// Database: Store ISO 8601 strings
created_at TEXT NOT NULL DEFAULT (datetime('now'))

// Application: Convert to milliseconds when needed
const createdMs = new Date(row.created_at).getTime();
const ageMs = Date.now() - createdMs;
```

---

### 🟢 LOW: No Persistent Session Storage
**File(s):** `authenx-node/src/routes/auth.js`
**Severity:** Logout ineffective across restarts
**Issue:**
```javascript
// JWT revocation stored in memory only
const revokedTokens = new Set();

function logout(token) {
  revokedTokens.add(token);  // ← Lost on server restart
}
```

**Impact:**
- After server restart, all revoked tokens are valid again
- Users cannot truly "log out" if server reboots

**To Fix:** Persist revocations to database:
```javascript
function logout(tokenId) {
  run(`INSERT INTO revoked_tokens (token_id, revoked_at) 
       VALUES (?, datetime('now'))`, [tokenId]);
}

function isTokenRevoked(tokenId) {
  const row = queryOne(`SELECT 1 FROM revoked_tokens WHERE token_id = ?`, [tokenId]);
  return !!row;
}
```

---

## 5. Security Issues (Not Vulnerabilities, But Risky Patterns)

### 🟠 HIGH: No Rate Limit on Token Issuance
**File(s):** `authenx-node/src/routes/tokens.js`
**Severity:** Denial of service / Spam
**Issue:**
```javascript
// POST /v1/tokens/issue has rate limiting on IP but not on per-college basis
// A college_admin can issue 1000s of tokens per minute
```

**Impact:**
- Malicious admin could spam token generation
- Database bloat
- HSM signing queue backs up

**To Fix:** Add per-college rate limit:
```javascript
const tokenIssuanceRateLimiter = new RateLimiter({
  keyFn: (req) => req.user.college_id,
  max: 100,      // 100 tokens per college per hour
  window: 3600   // 1 hour
});

app.post('/v1/tokens/issue', tokenIssuanceRateLimiter.middleware(), issueToken);
```

---

### 🟠 HIGH: Nonce Reuse Not Validated
**File(s):** `authenx-node/src/routes/verify.js` (liveVerify function)
**Severity:** Replay attack possible
**Issue:**
```javascript
async function liveVerify(token, nonce) {
  // No check if nonce was used before
  // Connector could re-sign with same nonce → bypass freshness check
}
```

**Impact:**
- Attacker intercepts a live verification response
- Replays it later (even if credential is revoked in interim)
- Employer accepts old proof as current

**To Fix:** Track used nonces:
```javascript
const nonceCache = new Map(); // nonce → { timestamp, collegeId }

async function liveVerify(token, nonce) {
  if (nonceCache.has(nonce)) {
    const { timestamp } = nonceCache.get(nonce);
    const ageSeconds = (Date.now() - timestamp) / 1000;
    if (ageSeconds > 300) { // 5-minute expiry
      nonceCache.delete(nonce);
    } else {
      throw new Error('Nonce already used (replay attack)');
    }
  }
  
  // ... proceed with verification
  nonceCache.set(nonce, { timestamp: Date.now(), collegeId: token.college_id });
}
```

---

## 6. Configuration & DevOps Issues

### 🟡 MEDIUM: Environment Variables Not Validated on Startup
**File(s):** `authenx-node/src/server.js`
**Severity:** Silent failures in production
**Issue:**
```javascript
// No startup validation
const JWT_SECRET = process.env.JWT_SECRET;  // ← Could be undefined
const HSM_MASTER_KEY = process.env.HSM_MASTER_KEY;  // ← Could be undefined

// Server starts without error, but first JWT create fails with cryptic error
```

**To Fix:** Add validation before server starts:
```javascript
function validateEnv() {
  const required = ['JWT_SECRET', 'HSM_MASTER_KEY'];
  const missing = required.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  // Validate secret lengths
  if (process.env.JWT_SECRET.length < 32) {
    console.error('❌ JWT_SECRET must be at least 32 characters');
    process.exit(1);
  }
}

validateEnv();
```

---

### 🟡 MEDIUM: Database Migration Not Automatic on Schema Changes
**File(s):** `authenx-node/src/db/schema.js`, `authenx-node/src/db/client.js`
**Severity:** Schema drift between versions
**Issue:**
```javascript
// Schema is applied once at startup
function initDb() {
  db.exec(SQL_SCHEMA);  // ← Creates tables only if they don't exist
}

// If schema changes, existing databases are not migrated
// Leads to "column not found" errors
```

**To Fix:** Implement migration system:
```javascript
const migrations = [
  {
    version: '1.0.0',
    up: (db) => {
      db.exec('ALTER TABLE colleges ADD COLUMN active INTEGER DEFAULT 1');
    },
    down: (db) => {
      db.exec('ALTER TABLE colleges DROP COLUMN active');
    }
  }
];

function migrate() {
  const lastVersion = queryOne(`PRAGMA user_version`) || 0;
  for (const m of migrations) {
    if (compareVersions(m.version, lastVersion) > 0) {
      m.up(db);
    }
  }
}
```

---

## 7. Testing & Observability Gaps

### 🟡 MEDIUM: No Integration Tests
**File(s):** Root directory (no `test/` or `__tests__/`)
**Severity:** Bugs not caught before deployment
**Issue:**
- No test suite for verification flow
- No test for HMAC auth between services
- No test for HSM key rotation
- Manual testing only

**To Fix:** Add `authenx-node/test/integration.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert');

test('Full verification flow', async (t) => {
  // 1. Create college
  // 2. Issue token
  // 3. Simulate verification request
  // 4. Assert response structure
});

test('HMAC signature validation', async (t) => {
  // 1. Create request with HMAC
  // 2. Tamper with body
  // 3. Assert verification fails
});

// Run: node test/integration.js
```

---

### 🟡 MEDIUM: Metrics Not Exportable in Standard Format
**File(s):** `authenx-node/src/middleware/metrics.js`
**Severity:** Monitoring blind spot
**Issue:**
```javascript
// GET /v1/metrics returns custom JSON format
// Not compatible with Prometheus scrapers
// Standard monitoring tools cannot parse it
```

**To Fix:** Add Prometheus endpoint:
```javascript
app.get('/metrics/prometheus', (req, res) => {
  const metrics = [
    `# HELP authenx_verifications_total Total verifications`,
    `# TYPE authenx_verifications_total counter`,
    `authenx_verifications_total{status="verified"} 1234`,
    `authenx_verifications_total{status="revoked"} 56`,
    // ... more metrics in Prometheus format
  ];
  res.end(metrics.join('\n'));
});

// Prometheus can now scrape: POST http://localhost:3000/metrics/prometheus
```

---

## 8. Summary Table

| Issue Level | Count | Examples |
|------------|-------|----------|
| 🔴 CRITICAL | 2 | Connector deleted, missing Docker orchestration |
| 🟠 HIGH | 5 | Connector proxy bugs, ERP mock issues, HMAC not documented, no HSM circuit breaker, pg breaks zero-deps principle |
| 🟡 MEDIUM | 7 | Field order validation, onboarding validation, env var validation, migrations, metrics format, rate limit per-college, nonce reuse |
| 🟢 LOW | 4 | Sensitive info leaks, ERP health, timestamp inconsistency, persistent sessions |

---

## 9. Immediate Action Items (Priority Order)

1. **Restore `authenx-connector/` directory** — blocks all verification for real colleges
2. **Restore Docker files** — enables full-stack testing
3. **Add connector health check at onboarding** — catch bad connector configs early
4. **Implement HMAC documentation** — enables connector integration
5. **Fix canonical JSON validation** — prevents hash mismatches
6. **Add environment variable validation on startup** — catch config errors early
7. **Implement retry logic for connector calls** — improve reliability
8. ~~**Decide on `pg` dependency**~~ — resolved: main DB migrated to PostgreSQL
9. **Add test suite** — prevent regressions

---

## 10. Recommended Next Steps for Claude Code

When working with this codebase:

1. **Before running:** Check if you're on `backend-change` branch — if yes, understand it's incomplete
2. **Before making changes:** Restore critical deleted files first (see section 1)
3. **When testing:** Cannot test `/v1/verify/live` without connectors — focus on auth & token issuance
4. **When adding features:** Consider whether `pg` dependency should be used or removed
5. **When deploying:** Wait for Docker orchestration to be restored
6. **When debugging:** Check FLAWS_AND_ISSUES.md first — many issues have known causes

