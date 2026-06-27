# Plan: Migrate AuthenX to PostgreSQL-Only

**Branch:** `backend-change`  
**Objective:** Replace every SQLite runtime dependency with PostgreSQL; purge all MySQL references from code, UI, config, and docs. Result: a single-database architecture backed exclusively by PostgreSQL.

**Strategy:** Maintenance-window cutover. No historical SQLite data migration — start fresh.  
**Parallelism:** Phases 1 → 2 → 3 → 4 are serial (each depends on the previous). Steps within Phase 2 (individual route files) are parallel.

---

## Scope

### Files that change code

| File | Category | Change |
|------|----------|--------|
| `authenx-node/src/db/schema.js` | Schema | Replace SQLite DDL with PostgreSQL DDL |
| `authenx-node/src/db/client.js` | Client | Full rewrite: node:sqlite → pg.Pool, sync → async |
| `authenx-node/src/routes/auth.js` | Routes | `?`→`$N`, async/await, inline SQL fixes |
| `authenx-node/src/routes/colleges.js` | Routes | `?`→`$N`, `INSERT OR REPLACE`→upsert, async/await |
| `authenx-node/src/routes/tokens.js` | Routes | `?`→`$N`, `datetime('now')`→`NOW()`, async/await, transaction API |
| `authenx-node/src/routes/verify.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/audit.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/tokens-extra.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/disclosure.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/security.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/connector-config.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/connector-proxy.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/routes/privacy.js` | Routes | `?`→`$N`, async/await |
| `authenx-node/src/server.js` | Server | Wrap all route dispatch in async try/catch |
| `authenx-node/mock-erp-cvr-seed.js` | Seed | Await all DB calls, remove SQLite comment |
| `start-backend-stack.ps1` | Config | Add `AUTHENX_PG_*` env vars for main DB |
| `authenx-node/package.json` | Config | Confirm `pg` is production dep (already is) |
| `ui/admin/collegeonboarding.html` | UI | Remove SQLite + MySQL db-card options |
| `ui/college/onboarding.html` | UI | Remove SQLite + MySQL db-card options |
| `ui/college/connector-management.html` | UI | Default adapter label: SQLite → PostgreSQL |
| `README.md` | Docs | Remove SQLite node:sqlite refs, update env vars, quick start |
| `CLAUDE.md` | Docs | Update architecture and env vars sections |
| `CONTEXT.md` | Docs | Update schema section heading and env vars table |
| `SECURITY_FIXES.md` | Docs | Remove `DB_PATH=/data/authenx.db` reference |
| `FLAWS_AND_ISSUES.md` | Docs | Update pg-vs-SQLite issue, mark resolved |
| `prd.md` | Docs | Remove MySQL list item |
| `.gitignore` | Config | Remove `*.db` / `authenx.db` if present |

### Files that do NOT change (API + security controls stay intact)

- `authenx-node/src/crypto/index.js` — no DB dependency
- `authenx-node/src/middleware/auth.js` — no DB dependency
- `authenx-node/src/middleware/rate-limiter.js` — in-memory only
- `authenx-node/src/middleware/fraud-detector.js` — in-memory buffer; DB flush is in routes
- `authenx-node/src/middleware/circuit-breaker.js` — no DB dependency
- `authenx-node/src/middleware/hmac-auth.js` — no DB dependency
- `authenx-node/src/middleware/dpdp.js` — no DB dependency (checks against DB via routes)
- `authenx-node/src/mock-erp/cvr-erp.js` — already PostgreSQL (`pg`) ✓
- `authenx-hsm/` — no DB dependency ✓

---

## Phase 1 — Schema + Client Foundation

**Goal:** Replace the synchronous SQLite client with an async PostgreSQL Pool. All route files continue to import the same symbols (`query`, `queryOne`, `run`, `transaction`) but they become async.

**Why this must go first:** Every other phase depends on a working pg client.

### Step 1.1 — New PostgreSQL DDL (`schema.js`)

**File:** `authenx-node/src/db/schema.js`

**All changes are mechanical; business logic is preserved exactly.**

| SQLite construct | PostgreSQL replacement |
|------------------|----------------------|
| `DEFAULT (datetime('now'))` | `DEFAULT NOW()` |
| Comment `Uses Node 22 built-in node:sqlite` | Update to reflect PostgreSQL |
| `INTEGER NOT NULL DEFAULT 0` for booleans | Keep as-is (PG accepts INTEGER; avoids ripple changes to `= 1` / `= 0` checks in routes) |

Full rewrite of `SQL_SCHEMA` export. Preserve all 18 tables, all indexes, all FK constraints, all CHECK constraints — translate syntax only.

**Verification:** `node -e "const {SQL_SCHEMA} = require('./src/db/schema.js'); console.log(SQL_SCHEMA.slice(0,100))"` must not throw.

### Step 1.2 — Async pg.Pool Client (`client.js`)

**File:** `authenx-node/src/db/client.js`

This is the most impactful file in the migration.

**Remove entirely:**
- `const { DatabaseSync } = require('node:sqlite')`
- `let _db = null`
- `function getDb()` and all PRAGMA calls
- `function runMigrations(db)` — includes PRAGMA table_info checks and registry.json sync (registry.json does not exist on this branch)
- `DB_PATH` env var read

**Add:**
```js
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.AUTHENX_PG_HOST     || 'localhost',
  port:     Number(process.env.AUTHENX_PG_PORT)  || 5432,
  user:     process.env.AUTHENX_PG_USER     || 'postgres',
  password: process.env.AUTHENX_PG_PASSWORD || '',
  database: process.env.AUTHENX_PG_DATABASE || 'authenx',
  max:      10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

**New async exports:**

```js
/** Run a SELECT and return all rows */
async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

/** Run a SELECT and return first row or null */
async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

/** Run INSERT/UPDATE/DELETE */
async function run(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

/**
 * Run multiple statements inside a transaction.
 * fn receives a dbClient object with { run, query, queryOne } bound to the
 * transaction connection — callers must use dbClient.run() not module-level run().
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dbClient = {
      run:      (sql, params = []) => client.query(sql, params),
      query:    async (sql, params = []) => { const r = await client.query(sql, params); return r.rows; },
      queryOne: async (sql, params = []) => { const r = await client.query(sql, params); return r.rows[0] || null; },
    };
    const result = await fn(dbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Initialize DB: apply schema (CREATE TABLE IF NOT EXISTS is idempotent) */
async function initDb() {
  const { SQL_SCHEMA } = require('./schema.js');
  // pg does not support multiple statements in a single query() call.
  // Split by statement and run each individually.
  const statements = SQL_SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const client = await pool.connect();
  try {
    for (const stmt of statements) {
      await client.query(stmt);
    }
  } finally {
    client.release();
  }
}

module.exports = { query, queryOne, run, transaction, initDb, pool };
```

**Note on `initDb()`:** Must be called from `server.js` on startup before serving requests. `CREATE TABLE IF NOT EXISTS` is idempotent — safe to call on every startup.

**Critical note on pool error handling:** Add pool-level error listener in client.js:
```js
pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});
```

**Verification:** `node -e "const {query} = require('./src/db/client.js'); console.log(typeof query)"` must print `function`.

---

## Phase 2 — SQL Compatibility + Async Route Migration

**Goal:** Make every route and middleware that calls `query/queryOne/run/transaction` async-aware. Fix all SQLite-specific SQL.

**These steps run independently of each other (parallel execution possible after Phase 1 is done).**

### The three SQL transformation rules (apply to every file)

**Rule A — Parameter placeholder substitution:**
Replace positional `?` with `$1`, `$2`, `$3`, ... (left-to-right order, 1-indexed).

```js
// BEFORE
queryOne('SELECT id FROM colleges WHERE short_code = ?', [sc])
// AFTER
queryOne('SELECT id FROM colleges WHERE short_code = $1', [sc])
```

```js
// BEFORE
run('INSERT INTO users (id, email, ...) VALUES (?,?,?,?,?,?)', [a,b,c,d,e,f])
// AFTER
run('INSERT INTO users (id, email, ...) VALUES ($1,$2,$3,$4,$5,$6)', [a,b,c,d,e,f])
```

**Rule B — SQLite datetime function:**
```sql
-- BEFORE (SQLite)
DEFAULT (datetime('now'))          -- in schema
issued_at = datetime('now')        -- in inline UPDATE
VALUES (..., datetime('now'), ...) -- in inline INSERT
-- AFTER (PostgreSQL)
DEFAULT NOW()
issued_at = NOW()
VALUES (..., NOW(), ...)
```

**Rule C — INSERT OR REPLACE:**
SQLite `INSERT OR REPLACE INTO` has no direct PostgreSQL equivalent.
- Use `INSERT INTO ... ON CONFLICT (pk_column) DO UPDATE SET col = EXCLUDED.col, ...`
- If the intent is "replace all columns", list every column in the DO UPDATE SET clause.

Two occurrences in `colleges.js`:
1. `INSERT OR REPLACE INTO college_postgres_provisioning (college_id, ...) VALUES (?,?,?,?,?,?)`
   → `INSERT INTO college_postgres_provisioning (college_id, ...) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (college_id) DO UPDATE SET db_name=EXCLUDED.db_name, db_user=EXCLUDED.db_user, db_password_enc=EXCLUDED.db_password_enc, provisioned=EXCLUDED.provisioned, provisioned_at=EXCLUDED.provisioned_at`

2. `INSERT OR REPLACE INTO college_connector_configs (...) VALUES (?,?,?,?,?,1)`
   → `INSERT INTO college_connector_configs (...) VALUES ($1,$2,$3,$4,$5,1) ON CONFLICT (college_id) DO UPDATE SET erp_type=EXCLUDED.erp_type, connector_url=EXCLUDED.connector_url, connector_config_json=EXCLUDED.connector_config_json, field_mapping_json=EXCLUDED.field_mapping_json, onboarding_completed=1, updated_at=NOW()`

One occurrence in `tokens.js` (`issued_authenx_codes`):
- Already uses `ON CONFLICT(token_id) DO UPDATE SET` syntax — this is valid PostgreSQL ✓ (just fix `datetime('now')` → `NOW()` inside it).

**Rule D — Async/await:**
Every function that calls `query`, `queryOne`, `run`, or `transaction` must be declared `async` and must `await` those calls.

```js
// BEFORE
function revokeToken(req, res, body) {
  const token = queryOne('SELECT ...', [id]);
  ...
}
// AFTER
async function revokeToken(req, res, body) {
  const token = await queryOne('SELECT ...', [id]);
  ...
}
```

**Rule E — Transaction callers:**
The new `transaction(fn)` passes a `dbClient` to `fn`. Any call inside a transaction must use `dbClient.run()` not the module-level `run()`.

Before (tokens.js `revokeToken`):
```js
transaction(() => {
  run(`UPDATE verification_tokens SET status='revoked' ...`, [...]);
  verificationCache.invalidate(token_id);
  run(`INSERT INTO revocation_events ...`, [...]);
  run(`INSERT INTO security_events ...`, [...]);
});
```

After:
```js
await transaction(async (db) => {
  await db.run(`UPDATE verification_tokens SET status='revoked' ...`, [...]);
  verificationCache.invalidate(token_id);
  await db.run(`INSERT INTO revocation_events ...`, [...]);
  await db.run(`INSERT INTO security_events ...`, [...]);
});
```

### Step 2.1 — Update server.js startup + route dispatch

**File:** `authenx-node/src/server.js`

**Change 1 — Call `initDb()` on startup:**
```js
const { getDb, run, queryOne, query } = require('./db/client.js');
// Remove getDb from import; add initDb
const { run, queryOne, query, initDb } = require('./db/client.js');

// In the HTTP server startup (after http.createServer):
async function start() {
  await initDb();
  const server = http.createServer(router);
  server.listen(PORT, () => { logStartup(PORT); });
}
start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
```

**Change 2 — Seed default users/data on first start:**
The current code seeds default users inline in `server.js` using synchronous `run()` calls. These must become async. Move the seeding logic into the `start()` function after `initDb()`.

**Change 3 — Route dispatch error handling:**
The existing `router()` function is already `async`. Ensure every route handler invocation is wrapped in `try/catch` and errors return 500. Pattern:
```js
try {
  await login(req, res, body);
} catch (err) {
  log.error('Route error:', err.message);
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}
```

**Verification:** Server starts without error; `GET /health` returns 200.

### Step 2.2 — Migrate `auth.js`

**File:** `authenx-node/src/routes/auth.js`

Apply Rules A, B, D to all functions:
- `isAccountLocked()` → async, await query, `?`→`$1,$2`
- `getRemainingAttempts()` → async, await query, `?`→`$1,$2`
- `recordLoginAttempt()` → async, await run, `?`→`$1,$2,$3,$4`
- `logSecurityEvent()` → async, await run, `?`→`$1,$2,$3,$4,$5,$6,$7`
- `login()` → async, await all DB calls, `?`→`$N`
- `refreshAuth()` → async, await all DB calls
- `logout()` → async, await all DB calls
- `changePassword()` → async, await all DB calls
- `enrollMfa()` → async, await all DB calls
- `confirmMfaSetup()` → async, await all DB calls
- `verifyMfaLogin()` → async, await all DB calls

**Note on `COUNT(*) as cnt`:** PostgreSQL returns BigInt strings for aggregate columns. Existing code checks `recentFailures[0]?.cnt`. After migration, `cnt` will be a string like `'3'`. Change comparisons to use `parseInt(recentFailures[0]?.cnt || '0', 10)` or `Number(...)`.

**Verification:** `POST /v1/auth/login` with valid credentials returns 200 with token.

### Step 2.3 — Migrate `colleges.js`

**File:** `authenx-node/src/routes/colleges.js`

Apply Rules A, B, C, D to all functions:
- `listColleges()` → async
- `getCollege()` → async, `?`→`$1`
- `createCollege()` → async, `?`→`$1`..`$6`
- `provisionCollegePostgres()` → already uses `pg` client internally; just apply Rule D on the outer `run()` call at line 134
- `onboardCollege()` → async; apply Rule A throughout; fix the two `INSERT OR REPLACE` calls (Rule C)

**Specific fix for `onboardCollege` manual rollback:**
The manual rollback on error (deletes partially inserted records) must remain. Since these are separate `run()` calls (not a real transaction), they stay as-is but become `await run(...)`. 

For correctness, wrap the entire onboarding body in a real `transaction()` call to make it atomic. This removes the need for manual rollback logic entirely.

**Verification:** `POST /v1/colleges/onboard` creates a college and returns 201.

### Step 2.4 — Migrate `tokens.js`

**File:** `authenx-node/src/routes/tokens.js`

Apply Rules A, B, D, E:
- `issueToken()` → async; fix inline `datetime('now')` (Rule B) on lines 88 and 116–119; fix `?`→`$N` (Rule A)
- `revokeToken()` → async; fix `transaction()` call (Rule E)
- `getToken()` → async
- `listTokens()` → async

**Verification:** `POST /v1/tokens/issue` creates token; `POST /v1/tokens/revoke` revokes it.

### Step 2.5 — Migrate `verify.js`

**File:** `authenx-node/src/routes/verify.js`

Apply Rules A, D:
- `decodeCode()` → async
- `liveVerify()` → async

**Verification:** `POST /v1/verify/code` with valid AuthenX Code returns decoded token info.

### Step 2.6 — Migrate `audit.js`

**File:** `authenx-node/src/routes/audit.js`

Apply Rules A, D. Note: `COUNT(*) as cnt` → use `Number()` conversion.

**Verification:** `GET /v1/audit` returns paginated events list.

### Step 2.7 — Migrate `tokens-extra.js`, `disclosure.js`, `security.js`, `connector-config.js`, `connector-proxy.js`, `privacy.js`

Apply Rules A, B, D to each file.

Check each for:
- Any `sqlite_master` reference → replace with `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`
- Any `datetime('now')` inline → `NOW()`
- Any `PRAGMA` usage → remove
- Any `INSERT OR REPLACE` → proper upsert

**Verification for each:** Affected API endpoints return expected responses (not 500).

### Step 2.8 — Migrate seed data in `server.js`

The existing `server.js` seeds default admin/college/employer accounts using synchronous `run()` at module load time. These must be moved inside the async `start()` function and awaited. Also replace `?`→`$N` and `INSERT OR IGNORE`→`INSERT INTO ... ON CONFLICT (email) DO NOTHING` if present.

**Search for:** Any `INSERT OR IGNORE` in server.js → replace with `ON CONFLICT ... DO NOTHING`.

**Verification:** On first start, default test accounts are created and login works.

---

## Phase 3 — Configuration + Seed Script + Startup

**Goal:** Establish PostgreSQL env vars for the main AuthenX DB; remove all SQLite-specific bootstrap assumptions; update the startup script.

### Step 3.1 — New environment variables

**Add** these new env vars for the main AuthenX PostgreSQL database:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTHENX_PG_HOST` | `localhost` | Main DB host |
| `AUTHENX_PG_PORT` | `5432` | Main DB port |
| `AUTHENX_PG_USER` | `postgres` | Main DB user |
| `AUTHENX_PG_PASSWORD` | _(required in prod)_ | Main DB password |
| `AUTHENX_PG_DATABASE` | `authenx` | Main DB database name |

**Remove:** `DB_PATH` — no longer used anywhere.

**Unchanged** (distinct purpose): `PG_PROVISION_*` vars remain for college-specific database provisioning and CVR mock ERP.

**Production guard** in `client.js`:
```js
if (process.env.NODE_ENV === 'production' && !process.env.AUTHENX_PG_PASSWORD) {
  throw new Error('AUTHENX_PG_PASSWORD is required in production');
}
```

### Step 3.2 — Update `start-backend-stack.ps1`

**File:** `start-backend-stack.ps1`

Add `AUTHENX_PG_*` injection into the backend startup block (alongside the existing `PG_PROVISION_*` injection):
```powershell
`$env:AUTHENX_PG_HOST = '$pgHostEsc'
`$env:AUTHENX_PG_PORT = '$pgPortEsc'
`$env:AUTHENX_PG_USER = '$pgUserEsc'
`$env:AUTHENX_PG_PASSWORD = '$pgPasswordEsc'
`$env:AUTHENX_PG_DATABASE = 'authenx'
```

Also update the `Write-Step 'Done'` summary to show the main AuthenX DB connection details.

### Step 3.3 — Update `mock-erp-cvr-seed.js`

**File:** `authenx-node/mock-erp-cvr-seed.js`

1. Remove the comment `CVR admin credentials set (SQLite main DB)` — replace with `(main AuthenX DB)`
2. Await all calls to `run()` and `queryOne()` from `./src/db/client.js` (they are now async)
3. Add `await initDb()` before the user update calls to ensure the pool is initialized

### Step 3.4 — Update `.gitignore`

Remove any `*.db` or `authenx.db` entries — SQLite file is no longer created. Add `authenx.db` to the removal list (not just gitignore — this file should not exist in the working directory).

**Verification:** `node src/server.js` starts without mentioning SQLite, connects to PostgreSQL, creates schema via `initDb()`.

---

## Phase 4 — UI + Documentation Cleanup

**Goal:** Remove all SQLite and MySQL references from UI HTML and markdown docs. After this phase, no file in the repository mentions SQLite or MySQL in a live/runtime context.

### Step 4.1 — `ui/admin/collegeonboarding.html`

This file contains a "ERP Database Type" selector with 5 options: SQLite, MySQL, PostgreSQL, MSSQL, API. These represent the *external college connector's* ERP database type. Since connectors are deleted on this branch:

**Remove entirely:**
- `<div class="db-card" ... id="db-sqlite">` — the SQLite card and its CSS `.db-card` variant
- `<div id="db-fields-sqlite">` — the SQLite path input block
- `<div class="db-card" onclick="selectDb('mysql')" id="db-mysql">` — the MySQL card
- `<div id="db-fields-mysql">` — the MySQL input fields block
- All `mysql_host`, `mysql_port`, `mysql_user`, `mysql_password`, `mysql_database` field references
- JS: remove `'sqlite'` and `'mysql'` from the `['sqlite','mysql','postgres','mssql','api']` array
- JS: remove the `if (type === 'sqlite')` and `if (type === 'mysql')` branches in the config builder
- JS: remove `if (selectedDb === 'sqlite') lines.push(...)` and `if (selectedDb === 'mysql') lines.push(...)` in the summary builder
- JS: change `let selectedDb = 'sqlite'` → `let selectedDb = 'postgres'`
- JS: remove `selectedDb === 'mysql' ? '4. npm install mysql2' :` from install_steps
- Comment at bottom `// Pre-select SQLite on load` → `// Pre-select PostgreSQL on load`
- `selectDb('sqlite')` → `selectDb('postgres')`

**Keep:** PostgreSQL, MSSQL (still valid ERP types for external connectors), API.

### Step 4.2 — `ui/college/onboarding.html`

**Remove:**
- SQLite db-card (`data-db="sqlite"`)
- MySQL/MariaDB db-card (`data-db="mysql"`)
- SQLite path input block and its related JS (`c-sqlite`)
- MySQL input fields and their JS
- References to `sqlite_path` in `cfg.connection.sqlite_path`
- Change `let selectedDb = 'sqlite'` → `let selectedDb = 'postgres'`
- `if (selectedDb === 'sqlite') { ... }` branch in `collectConfig()`
- `if (selectedDb === 'sqlite') { ... }` branch in `renderDbFields()`
- Change `const erpCols = selectedDb === 'sqlite' ? ...` → always use the non-sqlite branch
- `-e DB_PATH=/data/students.db` in the Docker example → remove or replace with PostgreSQL equivalent

**Update:** Default selected db-card should be PostgreSQL on page load.

### Step 4.3 — `ui/college/connector-management.html`

**File:** `ui/college/connector-management.html`

Line 128: `<span ... id="adapter-db">SQLite</span>` → `<span ... id="adapter-db">PostgreSQL</span>`

This is a display-only label that gets overwritten by the API response. The default just changes.

### Step 4.4 — `README.md`

**Specific changes:**

1. Line 21: Remove `(uses \`node:sqlite\` built-in)` — replace with `(uses \`pg\` for PostgreSQL)`  
   New text: `> **Requires Node.js 22+**. One npm dependency: \`pg\` (PostgreSQL client for main DB and CVR mock ERP).`

2. Environment variables table — remove `DB_PATH` row; add:
   | `AUTHENX_PG_HOST` | — | `localhost` | Main PostgreSQL host |
   | `AUTHENX_PG_PORT` | — | `5432` | Main PostgreSQL port |
   | `AUTHENX_PG_USER` | — | `postgres` | Main PostgreSQL user |
   | `AUTHENX_PG_PASSWORD` | ✅ (prod) | _(none)_ | Main PostgreSQL password |
   | `AUTHENX_PG_DATABASE` | — | `authenx` | Main PostgreSQL database name |

3. Onboarding example request body line 95-98: Change `"db_type": "mysql"` → `"db_type": "postgres"`

4. Architecture description: Remove any "zero external dependencies" language — that was SQLite-era.

5. Quick start section: Add a prerequisite step:
   ```
   # Prerequisite: PostgreSQL must be running with the authenx database created
   # createdb -U postgres authenx   (or use psql: CREATE DATABASE authenx;)
   ```

### Step 4.5 — `CLAUDE.md`

**Specific changes:**

1. Line 34: `Requires **Node.js 22+** — uses \`node:sqlite\` built-in. One npm dependency: \`pg\`...`  
   → `Requires **Node.js 22+**. One npm dependency: \`pg\` (PostgreSQL client — main DB and CVR mock ERP).`

2. Line 49: `SQLite database (\`authenx.db\`) — 18 tables; never stores student names...`  
   → `PostgreSQL database (\`authenx\`) — 18 tables; never stores student names...`

3. `DB_PATH` row in env vars table → remove; add `AUTHENX_PG_*` rows.

4. Schema description line 169: `SQLite schema — 18 tables` → `PostgreSQL schema — 18 tables`

5. Remove any reference to WAL mode or PRAGMA.

### Step 4.6 — `CONTEXT.md`

**Specific changes:**

1. Line 61: `db/                ← SQLite schema & client (18 tables)` → `db/ ← PostgreSQL schema & client (18 tables)`

2. Line 181: `## 6. Database Schema (18 Tables in SQLite)` → `## 6. Database Schema (18 Tables in PostgreSQL)`

3. Line 389: `Pre-seeded via PostgreSQL (\`mock-erp-cvr.db\` for local SQLite fallback)` → remove the parenthetical SQLite fallback note.

4. Line 402: `DB_PATH` row → remove; add `AUTHENX_PG_*` rows.

### Step 4.7 — `SECURITY_FIXES.md`

Line 268: `DB_PATH=/data/authenx.db` → Remove this line (or replace with `AUTHENX_PG_DATABASE=authenx`).  
Line 300: `Configure DB backups (\`authenx.db\`)` → `Configure DB backups (PostgreSQL \`authenx\` database via pg_dump)`.

### Step 4.8 — `FLAWS_AND_ISSUES.md`

Find the section `### 🟡 MEDIUM: \`pg\` Used in Mock ERP and Provisioning But \`db/client.js\` Is SQLite-Only` and update:
- Change the heading to note this issue is resolved.
- Update body to reflect that the main DB is now PostgreSQL.

Find the summary table row about `pg vs SQLite clarity` — mark as resolved.  
Find item 8: `Decide on \`pg\` dependency` — mark as resolved.

Also update any mentions of `sqlite_master` (line 474 shows a query with `sqlite_master`) — mark that as a prior bug, now resolved.

### Step 4.9 — `prd.md`

Line 713: Remove `* MySQL` from the database list (or replace with a note that PostgreSQL is the only supported ERP connector DB alongside MSSQL and API types).

---

---

## Errata — Corrections from Adversarial Review

The following issues were identified after the initial draft. They override or supplement the relevant sections above.

### E1 — `middleware/dpdp.js` Has DB Dependencies (CRITICAL)

The plan's "Files that do NOT change" section incorrectly listed `dpdp.js`. **It imports and calls `run`, `queryOne`, `query` directly.** It must be added to Phase 2 with the full Rules A, B, D treatment.

**Specific SQLite patterns in `dpdp.js`:**
- Line 31: `run(\`INSERT INTO consent_records ... VALUES (?,?,?,?,?,1)\`, [...])` → Rule A
- Line 40: `run(\`UPDATE consent_records SET ... revoked_at = datetime('now') WHERE user_id = ? AND purpose = ? ...\`, [...])` → Rules A + B
- Lines 49, 60, 82, 89, 96, 103: multiple `queryOne()`/`query()` with `?` → Rule A
- Lines 158–178: multiple `run()` calls in `processErasureRequest()` (not transactional — note risk)
- Line 177: `completed_at = datetime('now')` → Rule B
- Line 203: `run(\`DELETE FROM ${table} WHERE created_at < ?\`, [cutoff])` → Rule A

All functions that call `run`/`queryOne`/`query` must become `async` (Rule D). This means `recordConsent`, `revokeConsent`, `hasConsent`, `getUserConsents`, `generateDataAccessReport`, `processErasureRequest`, `enforceRetentionPolicy` all become async.

**Downstream impact:** `privacy.js` (already in plan) wraps these functions — it must await them. No other routes call dpdp.js directly.

### E2 — `server.js` Has More DB-Using Functions Than Documented (CRITICAL)

The plan only addressed `seedDatabase()` and route dispatch in server.js. The following **additional** functions in server.js use `query`/`queryOne`/`run` and need async migration:

| Function | Location | SQLite-specific patterns |
|----------|----------|--------------------------|
| `bulkVerify()` | line 290 | `?` in queryOne |
| `tokenAnalytics()` | line 331 | `strftime('%Y-%m', ...)`, `date(r.created_at)`, `?` params |
| `getSecurityEvents()` | line 381 | `?` params, `COUNT(*)` |
| `connectorHealthCheck()` | line 400 | no params, just query |
| `detailedHealth()` | line 439 | `date(created_at) = date('now')`, `COUNT(*)` |
| `serveFraudAlerts()` | line 480 | `?` params, `COUNT(*)` |
| `flushFraudAlerts()` | line 497 | `run()` with `?`, called from setInterval |
| `seedDatabase()` | line 513 | `INSERT OR IGNORE`, `datetime('now')`, `?` params |

**`strftime`/`date` replacements (Rule F — SQLite date functions):**

| SQLite | PostgreSQL |
|--------|-----------|
| `strftime('%Y-%m', t.issued_at)` | `to_char(t.issued_at::timestamptz, 'YYYY-MM')` |
| `date(r.created_at) as day` | `to_char(r.created_at::timestamptz, 'YYYY-MM-DD') as day` |
| `date(created_at) = date('now')` | `created_at::date = CURRENT_DATE` |

**`flushFraudAlerts` async fix:**
```js
// BEFORE
function flushFraudAlerts() {
  const alerts = fraud.flushAlerts();
  for (const a of alerts) {
    try { run(...); } catch {}
  }
}
setInterval(flushFraudAlerts, 5000).unref();

// AFTER
async function flushFraudAlerts() {
  const alerts = fraud.flushAlerts();
  for (const a of alerts) {
    try { await run(...); } catch {}
  }
}
setInterval(() => { flushFraudAlerts().catch(() => {}); }, 5000).unref();
```

**`seedDatabase()` fixes:**
1. `INSERT OR IGNORE INTO colleges ...` → `INSERT INTO colleges ... ON CONFLICT (id) DO NOTHING`
2. `INSERT OR IGNORE INTO users ...` → `INSERT INTO users ... ON CONFLICT (email) DO NOTHING`
3. `INSERT OR IGNORE INTO verification_tokens ...` → `INSERT INTO verification_tokens ... ON CONFLICT (id) DO NOTHING`
4. `datetime('now')` in line 635 UPDATE → `NOW()`
5. All `run()` / `queryOne()` calls → `await run()` / `await queryOne()`
6. Function is already `async` — just needs await keywords added

**Route dispatch `return` vs `await return`:**
Lines 210–282 use `return login(req, res, body)` for sync functions. After making all handlers async, these must become:
```js
try { return await login(req, res, body); } catch (err) { /* 500 */ }
```
This change must be applied to **every route dispatch line** (approximately 30 lines in the router function).

### E3 — `pg` Multi-Statement Support Correction

The plan's `initDb()` comment "pg does not support multiple statements in a single query() call" is **incorrect** — pg's simple query protocol does support multiple statements. The `split(';')` approach works but is not required. Simpler alternative:

```js
async function initDb() {
  const { SQL_SCHEMA } = require('./schema.js');
  const client = await pool.connect();
  try {
    await client.query(SQL_SCHEMA);
  } finally {
    client.release();
  }
}
```

This works because `SQL_SCHEMA` contains no parameterized queries (no `$1` etc.) — it's pure DDL.

### E4 — `run()` Return Value Difference

SQLite's `run()` returns `{ changes, lastInsertRowid }`. PostgreSQL's `run()` returns a pg Result with `{ rowCount, rows, command }`. Any code checking `.changes` or `.lastInsertRowid` will silently break.

**Grep check required:**
```bash
grep -r "\.changes\b\|\.lastInsertRowid\b" authenx-node/src/ --include="*.js"
```
If results found: replace `.changes` with `.rowCount` and remove `.lastInsertRowid` (UUIDs are generated in JS, not DB-generated, so this should not exist).

### E5 — `COUNT(*)` Returns String in Node.js pg

This was mentioned in Step 2.2 (auth.js only). It affects **every** `COUNT(*) as cnt` query across the entire codebase. The pattern is:
```js
// BEFORE (SQLite — cnt is a Number)
const total = query('SELECT COUNT(*) as cnt FROM ...')[0]?.cnt || 0;

// AFTER (pg — cnt is a string like "42")
const total = Number(query('SELECT COUNT(*) as cnt FROM ...')[0]?.cnt || 0);
// OR:
const total = parseInt((query('...')[0]?.cnt || '0'), 10);
```

Files affected: `audit.js`, `server.js` (multiple functions), `auth.js`, `security.js`, any file using aggregate queries.

**Note:** With the async migration, these all become:
```js
const total = Number((await query('SELECT COUNT(*) as cnt FROM ...'))[0]?.cnt || 0);
```

### E6 — Scope Table Corrections

The "Files that do NOT change" table must be corrected:
- **Remove** `authenx-node/src/middleware/dpdp.js` from "no DB dependency" claim
- **Add** it to the "Files that change" table in Phase 2

The full corrected list of files with DB dependencies (needing async migration):

| Route/Middleware File | Rule A | Rule B | Rule C | Rule D | Rule E | Rule F |
|----------------------|--------|--------|--------|--------|--------|--------|
| `routes/auth.js` | ✓ | ✓ | — | ✓ | — | — |
| `routes/colleges.js` | ✓ | — | ✓ | ✓ | — | — |
| `routes/tokens.js` | ✓ | ✓ | — | ✓ | ✓ | — |
| `routes/verify.js` | ✓ | — | — | ✓ | — | — |
| `routes/audit.js` | ✓ | — | — | ✓ | — | — |
| `routes/tokens-extra.js` | ✓ | — | — | ✓ | — | — |
| `routes/disclosure.js` | ✓ | — | — | ✓ | — | — |
| `routes/security.js` | ✓ | — | — | ✓ | — | — |
| `routes/connector-config.js` | ✓ | — | — | ✓ | — | — |
| `routes/connector-proxy.js` | ✓ | — | — | ✓ | — | — |
| `routes/privacy.js` | ✓ | — | — | ✓ | — | — |
| `middleware/dpdp.js` | ✓ | ✓ | — | ✓ | — | — |
| `server.js` (inline fns) | ✓ | ✓ | ✓ | ✓ | — | ✓ |

---

## Cross-Cutting Verification Checklist

Run after all phases are complete.

### Remnant search

```bash
# Must return 0 matches for each:
grep -r "node:sqlite\|DatabaseSync\|new DatabaseSync\|PRAGMA\|journal_mode\|authenx\.db\|DB_PATH" \
  authenx-node/src/ --include="*.js"

grep -ri "mysql\|MySQL" \
  authenx-node/src/ ui/ --include="*.js" --include="*.html"

grep -r "sqlite" \
  authenx-node/src/ --include="*.js"

grep -r "INSERT OR REPLACE\|INSERT OR IGNORE" \
  authenx-node/src/ --include="*.js"

grep -r "datetime('now')" \
  authenx-node/src/ --include="*.js"

grep -r "strftime\|date('now')\b" \
  authenx-node/src/ --include="*.js"

grep -r "\.changes\b\|\.lastInsertRowid\b" \
  authenx-node/src/ --include="*.js"

# Verify no unparameterized ? in SQL strings (check manually for SQL context)
grep -rn "= ?" \
  authenx-node/src/routes/ authenx-node/src/middleware/ authenx-node/src/server.js \
  --include="*.js"
```

### Smoke tests (manual, requires running stack)

```bash
# 1. Start stack (PostgreSQL must be running)
AUTHENX_PG_HOST=localhost AUTHENX_PG_PASSWORD=Postgres@123 node authenx-node/src/server.js &
node authenx-hsm/server.js &

# 2. Health check
curl http://localhost:3000/health

# 3. Auth flow
curl -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@authenx.in","password":"Admin@123"}'

# 4. College list (use token from step 3)
curl http://localhost:3000/v1/colleges \
  -H 'Authorization: Bearer <TOKEN>'

# 5. Onboard a college (super_admin)
curl -X POST http://localhost:3000/v1/colleges/onboard \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test College","short_code":"TEST","admin_email":"admin@test.ac.in","connector_url":"http://localhost:9001"}'

# 6. Issue a token (college_admin)
# 7. Revoke the token
# 8. Decode verification code
# 9. Audit log query
```

### Documentation consistency check

```bash
# Must return 0 matches in docs:
grep -ri "sqlite" README.md CLAUDE.md CONTEXT.md SECURITY_FIXES.md
grep -ri "mysql\|MySQL" README.md CLAUDE.md CONTEXT.md prd.md
grep -r "DB_PATH" README.md CLAUDE.md CONTEXT.md SECURITY_FIXES.md
```

---

## Rollback Plan

Since this is a fresh PostgreSQL start (no historical data migration), rollback means switching back to the SQLite branch:

```bash
git stash          # Save in-progress PG migration work
git checkout main  # Or the last known-good SQLite commit
```

The SQLite `authenx.db` file is generated fresh on startup — no data is lost by rolling back since no production data exists.

---

## Dependencies and Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `COUNT(*)` returns string in pg vs number in SQLite | HIGH | Use `Number()` / `parseInt()` wrapper on every aggregate result |
| Transaction callers use module-level `run()` inside callback | HIGH | Rule E: update every `transaction()` caller to use `dbClient.run()` |
| `pg` multi-statement `query()` restriction | HIGH | `initDb()` splits schema by `;` and runs each statement individually |
| Missing `AUTHENX_PG_PASSWORD` in dev environments | MEDIUM | Default password fallback + clear error message; startup script passes it |
| Pool exhaustion on high load | LOW | Pool max=10 (conservative); monitor and tune via `AUTHENX_PG_POOL_MAX` if needed |
| `server.js` seed logic was synchronous at module load | MEDIUM | Move seeding inside `start()` async function |

---

## Files Created/Modified Summary

**New:** `plans/migrate-to-postgresql.md` (this file)

**Modified (26 files total):**
- DB layer (2): `schema.js`, `client.js`  
- Routes (11): `auth.js`, `colleges.js`, `tokens.js`, `verify.js`, `audit.js`, `tokens-extra.js`, `disclosure.js`, `security.js`, `connector-config.js`, `connector-proxy.js`, `privacy.js`
- Server (1): `server.js`
- Seed (1): `mock-erp-cvr-seed.js`
- Config/startup (2): `start-backend-stack.ps1`, `.gitignore`
- UI (3): `collegeonboarding.html`, `onboarding.html`, `connector-management.html`
- Docs (6): `README.md`, `CLAUDE.md`, `CONTEXT.md`, `SECURITY_FIXES.md`, `FLAWS_AND_ISSUES.md`, `prd.md`

**Not modified (API + security controls preserved):**
All middleware except `server.js` route dispatch; `crypto/index.js`; `cvr-erp.js`; `authenx-hsm/`
