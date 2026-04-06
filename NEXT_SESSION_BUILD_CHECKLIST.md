# AuthenX — Next Session Build Checklist
## Complete Demo Build · Fresh 200k Token Session

---

## PASTE THIS AT THE START OF THE NEXT SESSION

```
We are building AuthenX — a privacy-first academic credential verification
infrastructure. All planning is complete. This session is pure execution.

Read these files FIRST before touching any code:
1. /AUTHENX-MAIN/NEXT_SESSION_BUILD_CHECKLIST.md  ← THIS FILE (full context)
2. /AUTHENX-MAIN/DESIGN_SYSTEM.md                 ← UI specs (colors, fonts, components)
3. /AUTHENX-MAIN/CONNECTOR_IMPLEMENTATION_PLAN.md ← MySQL connector plan
4. /AUTHENX-MAIN/MOCK_DATABASE_GUIDE.md            ← Test data + workflow
5. /AUTHENX-MAIN/ARCHITECTURE_WITH_MOCK_DB.md     ← System architecture

Working server is at: /sessions/.../authenx-node/
Mock DB file: /AUTHENX-MAIN/mock_college_database.sql
Test credentials: stu_ref_001 (active), stu_ref_002 (active), stu_ref_003 (revoked)

Build order: Connector → College Admin UI → Employer Verification UI → Integration Test
Check each piece BEFORE moving to the next. Verify with tests after each step.
```

---

## What's Already Built ✓

### Core Server (`authenx-node/`)
- [x] `src/db/schema.js` — Full SQLite schema (6 tables)
- [x] `src/db/client.js` — DatabaseSync wrapper (query, queryOne, run, transaction)
- [x] `src/crypto/index.js` — Ed25519, AES-256-GCM, SHA-256, JWT, scrypt (ZERO npm deps)
- [x] `src/routes/auth.js` — Login, JWT issue, /me endpoint
- [x] `src/routes/colleges.js` — List, stats, public key lookup
- [x] `src/routes/tokens.js` — Issue token, list, revoke
- [x] `src/routes/verify.js` — decodeCode, liveVerify, mockConnectorVerify
- [x] `src/server.js` — HTTP server with router, CORS, seedDatabase()
- [x] **14/14 end-to-end tests passing**

### Planning Artifacts (`AUTHENX-MAIN/`)
- [x] `DESIGN_SYSTEM.md` — Complete (colors, typography, components, 3 portals, 16 screens)
- [x] `CONNECTOR_DESIGN.md` — Plug & play architecture
- [x] `CONNECTOR_IMPLEMENTATION_PLAN.md` — Step-by-step MySQL adapter
- [x] `MOCK_DATABASE_GUIDE.md` — 12 students, 3 colleges, all test scenarios
- [x] `ARCHITECTURE_WITH_MOCK_DB.md` — 6-layer system architecture
- [x] `mock_college_database.sql` — MySQL schema + 12 test students
- [x] `wireframe_college_portal.html` — 7-screen interactive wireframe
- [x] `wireframe_employer_portal.html` — 5-screen interactive wireframe

---

## Build Order (Next Session)

### PHASE 1 — MySQL Connector (1–2 hours)
**Goal:** Real connector that queries mock_college_database.sql and returns signed data

#### Step 1.1 — Create connector project
```bash
mkdir authenx-connector && cd authenx-connector
# Copy config.json from CONNECTOR_IMPLEMENTATION_PLAN.md
# Create .env from plan Step 1
```

#### Step 1.2 — Implement connector.js
Follow CONNECTOR_IMPLEMENTATION_PLAN.md Steps 3–7.
Use Approach B (shell mysql subprocess) for fastest demo path.

#### Step 1.3 — Verify connector works
```bash
# Start MySQL with mock_college_database.sql first
mysql -u root -p < /AUTHENX-MAIN/mock_college_database.sql

# Start connector
node connector.js

# Test manually
curl -X POST http://localhost:9000/verify \
  -H "Content-Type: application/json" \
  -d '{"student_ref_token":"stu_ref_001","nonce":"testnonce123"}'
```

**Expected:** JSON response with `name: "SUPREETH K"` and valid `live_signature`

#### Step 1.4 — Wire into server.js
In `src/routes/verify.js`, update `callConnector()` to use real connector URL.
Set `CONNECTOR_URL=http://localhost:9000` in env.
Keep mock connector as fallback when CONNECTOR_URL is not set.

#### Step 1.5 — Run full end-to-end test
```bash
# Issue a token using stu_ref_001
POST /api/tokens/issue → get token_id + encrypted_code

# Decode the code
POST /api/verify/decode → check decoded fields

# Live verify (now uses REAL MySQL connector)
POST /api/verify/live → should return live SUPREETH K data

# Revoke token
POST /api/tokens/stu_ref_003/revoke

# Verify revoked token → should fail with revoked error
```

**Checkpoint:** All 5 steps pass → Phase 1 complete ✓

---

### PHASE 2 — College Admin Portal UI (2–3 hours)
**Goal:** Production-quality 7-screen web app for college admins

**Tech stack:** Plain HTML/CSS/JS (no React needed for demo) or React if preferred.
Reference: `wireframe_college_portal.html` for exact layout + `DESIGN_SYSTEM.md` for styles.

#### Step 2.1 — Create `/ui/college/` directory
```
ui/college/
├── index.html          ← Login screen
├── dashboard.html      ← Dashboard (stats + activity)
├── students.html       ← Student list + search
├── issue.html          ← Issue credential form
├── code-issued.html    ← Code display + share
├── tokens.html         ← Manage tokens + revoke
├── audit.html          ← Audit log
└── app.js              ← Shared JS (API calls, auth, navigation)
└── app.css             ← Shared CSS (from DESIGN_SYSTEM.md)
```

#### Step 2.2 — Build each screen (check after each)

**Screen 1: Login**
- [ ] Email + password form
- [ ] JWT stored in localStorage
- [ ] Redirect to dashboard on success
- [ ] Error state: "Invalid credentials"
- [ ] API: `POST /api/auth/login`

**Screen 2: Dashboard**
- [ ] 4 stat cards: Total Tokens, Active Colleges, Verifications, Revoked
- [ ] Recent activity feed (last 5 events from audit log)
- [ ] Quick action buttons: Issue Credential, View Students
- [ ] Connector status indicator (green if live, amber if mock)
- [ ] API: `GET /api/colleges/stats`

**Screen 3: Students**
- [ ] Table: name, ref token, degree, CGPA, status badge
- [ ] Search input (filter by name or ref token)
- [ ] Filter tabs: All / Active / Revoked
- [ ] Revoke button with confirmation modal
- [ ] API: `GET /api/tokens` (list tokens for this college)

**Screen 4: Issue Credential**
- [ ] Step 1: Enter student ref token input
- [ ] Step 2: Click "Fetch from ERP" → calls live verify → shows preview card
- [ ] Preview shows: name, degree, branch, CGPA, graduation year
- [ ] Step 3: Click "Issue & Sign" → creates token + encrypted code
- [ ] API: `POST /api/tokens/issue`

**Screen 5: Code Issued**
- [ ] Large code display (`AX1.xxxxx...`)
- [ ] Copy to clipboard button
- [ ] QR code display (generate client-side with qrcode.js CDN)
- [ ] Share via email button (opens mailto:)
- [ ] Token details: issued at, expires, linked student
- [ ] "Issue another" button

**Screen 6: Manage Tokens**
- [ ] Full table: student ref, code prefix, issued date, status, actions
- [ ] Revoke button per row
- [ ] Confirmation modal: "Revoke this credential? This cannot be undone."
- [ ] Revoked tokens shown with strike-through + revoked badge
- [ ] API: `GET /api/tokens`, `POST /api/tokens/:id/revoke`

**Screen 7: Audit Log**
- [ ] Immutable event table: timestamp, event type, student ref, actor, details
- [ ] Event type badges: ISSUED / REVOKED / VERIFIED / DECODE
- [ ] No delete/edit possible — read only
- [ ] API: `GET /api/audit`

**Checkpoint:** All 7 screens render + connect to API → Phase 2 complete ✓

---

### PHASE 3 — Employer Verification Portal UI (1.5–2 hours)
**Goal:** Production-quality 5-screen verification flow for employers

**Tech stack:** Same as College Portal.
Reference: `wireframe_employer_portal.html`

```
ui/employer/
├── index.html          ← Landing + login
├── verify.html         ← Paste code (step 1)
├── decoding.html       ← Registry check (step 2)
├── verified.html       ← Live verified result ✓
├── revoked.html        ← Revoked result ✗
└── verify.js           ← Verification flow logic
└── verify.css          ← Styles
```

#### Step 3.1 — Build verification flow screens

**Screen 1: Landing + Login**
- [ ] Hero with tagline "Verify Degrees in Seconds, Not Weeks"
- [ ] Feature cards: Instant Results / Cryptographic Proof / Revocation Aware
- [ ] Login form (email + password)
- [ ] Redirect to verify screen on login

**Screen 2: Paste Code**
- [ ] Stepper: Step 1 (active) → Step 2 → Step 3
- [ ] Textarea for AX1. code
- [ ] Sample code fill button (for demo)
- [ ] "Verify Credential" button → calls API → redirects to step 2
- [ ] API: `POST /api/verify/decode`

**Screen 3: Code Decoded**
- [ ] Stepper: Step 1 ✓ → Step 2 (active) → Step 3
- [ ] Show decoded fields: college, student ref, credential type, issue date
- [ ] Registry check status: "Found — not revoked"
- [ ] Hash preview (truncated)
- [ ] "Confirm Live Verification" → calls live verify → redirects to result
- [ ] API: `POST /api/verify/live`

**Screen 4: Live Verified ✓**
- [ ] Green top bar (verified color)
- [ ] Verified banner with large checkmark
- [ ] Student profile card: name, degree, branch, CGPA, graduation year, status
- [ ] LIVE DATA badge with pulsing dot
- [ ] 4 cryptographic checks (all green ✓)
- [ ] Download Report / Copy Summary / Verify Another actions

**Screen 5: Revoked ✗**
- [ ] Red top bar (revoked color)
- [ ] Revoked banner with X mark
- [ ] Revoked credential details table
- [ ] Warning box: "Do Not Accept This Credential"
- [ ] Partial verification results (code valid, but revoked)
- [ ] "Verify Another" button → back to step 1

**Checkpoint:** All 5 screens work + green/red flows both work → Phase 3 complete ✓

---

### PHASE 4 — Integration Test (1 hour)
**Goal:** Complete end-to-end demo with zero mocking

#### Test Scenario A — Happy Path (SUPREETH K)
```
1. College admin logs in → Dashboard
2. Issue credential for stu_ref_001
3. Code generated: AX1.xxxxx
4. Employer logs in → Paste Code screen
5. Paste the AX1 code → Click Verify
6. Step 2: Decoded — shows IIT Bombay, stu_ref_001, not revoked
7. Step 3: LIVE VERIFIED ✓ — shows SUPREETH K, B.Tech CS, CGPA 8.9
```

#### Test Scenario B — Revoked Credential (RAHUL NAIR)
```
1. College admin logs in → Manage Tokens
2. Revoke stu_ref_003 token (or use already-revoked one)
3. Employer pastes that code → Verify
4. Step 3: CREDENTIAL REVOKED ✗ — shows revocation date + reason
```

#### Test Scenario C — Tampered Code
```
1. Take valid AX1 code, change 2 characters
2. Employer pastes modified code → Verify
3. Step 1 fails: "Invalid or expired code"
```

#### Test Scenario D — Concurrent Verifications
```
1. Issue 3 different codes (stu_ref_001, stu_ref_002, stu_ref_004)
2. Verify all 3 in separate browser tabs simultaneously
3. All 3 return different student data correctly
```

**Checkpoint:** All 4 scenarios pass → Phase 4 complete ✓

---

### PHASE 5 — Polish + Demo Prep (30 min)
**Goal:** Make it look and feel production-ready for demo

- [ ] Add loading spinners during API calls
- [ ] Add error toasts for failed requests
- [ ] Add success animations on verified screen
- [ ] Test on mobile viewport (768px) — responsive check
- [ ] Test in Chrome + Safari + Firefox
- [ ] Take screenshots of all screens for slide deck
- [ ] Record a 2-minute demo video (screen capture)

---

## Test Accounts (Pre-seeded by seedDatabase())

| Role | Email | Password | College |
|------|-------|----------|---------|
| Super Admin | admin@authenx.in | authenx2024 | — |
| College Admin | admin@iitb.ac.in | iitb2024 | IIT Bombay |
| College Admin | admin@nitc.ac.in | nitc2024 | NIT Calicut |

---

## Test Students (in mock DB + server mock connector)

| Ref Token | Name | College | Status | Scenario |
|-----------|------|---------|--------|----------|
| stu_ref_001 | SUPREETH K | IIT Bombay | Active | Happy path |
| stu_ref_002 | PRIYA SHARMA | IIT Bombay | Active | Happy path |
| stu_ref_003 | RAHUL NAIR | NIT Calicut | Withdrawn | Revoked |
| stu_ref_004 | ARUN KUMAR | NIT Calicut | Active | Happy path |
| stu_ref_005 | DEEPA MENON | BITS Pilani | Alumni | Happy path |

---

## Environment Variables Needed

```bash
# AuthenX Server
JWT_SECRET=authenx_jwt_secret_2024
AES_KEY=authenx_aes_key_32_bytes_exactly!
PORT=3000

# Mock connector (auto-set by seedDatabase)
MOCK_CONNECTOR_PRIV_KEY=<generated on first run — saved to seed_codes.json>

# Real connector (Phase 1)
CONNECTOR_URL=http://localhost:9000

# MySQL (if using real DB instead of mock)
DB_HOST=localhost
DB_PORT=3306
DB_NAME=authenx_mock_college
DB_USER=root
DB_PASS=password
```

---

## File Locations Quick Reference

```
/sessions/.../authenx-node/
  src/
    crypto/index.js    ← All crypto (Ed25519, AES, JWT, scrypt)
    db/client.js       ← SQLite wrapper
    db/schema.js       ← Table definitions
    routes/
      auth.js          ← Login, JWT
      colleges.js      ← College management
      tokens.js        ← Issue, list, revoke
      verify.js        ← decode, liveVerify, mockConnector
    server.js          ← HTTP server + seed + demo UI

/sessions/.../mnt/AUTHENX-MAIN/
  DESIGN_SYSTEM.md                ← Colors, fonts, components
  CONNECTOR_IMPLEMENTATION_PLAN.md ← MySQL adapter steps
  MOCK_DATABASE_GUIDE.md          ← Test data walkthrough
  ARCHITECTURE_WITH_MOCK_DB.md    ← System architecture
  CONNECTOR_DESIGN.md             ← Plug & play design
  mock_college_database.sql       ← MySQL schema + 12 students
  wireframe_college_portal.html   ← 7-screen interactive wireframe
  wireframe_employer_portal.html  ← 5-screen interactive wireframe
  seed_codes.json                 ← Generated on first server run
```

---

## Readiness Assessment

| Component | Status | Next Action |
|-----------|--------|-------------|
| Cryptography | ✅ 100% | None |
| Database (SQLite) | ✅ 100% | None |
| Auth (JWT + scrypt) | ✅ 100% | None |
| API Routes | ✅ 100% | None |
| Mock Connector | ✅ 100% | None |
| Design System | ✅ 100% | None |
| Wireframes (College) | ✅ 100% | None |
| Wireframes (Employer) | ✅ 100% | None |
| MySQL Connector | 🔲 0% | Phase 1 |
| College Admin UI | 🔲 0% | Phase 2 |
| Employer Verify UI | 🔲 0% | Phase 3 |
| Integration Tests | 🔲 0% | Phase 4 |
| **Overall Demo** | **45%** | **4–6 hours build** |

---

## Demo Day Talking Points

1. **"AuthenX stores zero student data"** — Show the liveVerify code: data comes in, gets verified, never written to DB
2. **"Cryptographically impossible to fake"** — Show the 3-check verification: hash match + issuance sig + live sig
3. **"Instant revocation"** — Show revoked scenario: credential was valid, then revoked, now fails in real-time
4. **"Works with any college DB"** — Show config.json: just change the field mapping
5. **"College controls their data"** — Show connector runs on college network, behind their firewall

---

*This checklist was created at the end of Session 1 (planning session) to hand off to Session 2 (execution session). All planning is complete — Session 2 is 100% execution.*
