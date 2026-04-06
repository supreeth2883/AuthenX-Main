# AuthenX — Complete End-to-End Demo Walkthrough

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    AuthenX Server (Node.js)                     │
│                  http://localhost:3000/v1                       │
├─────────────────────────────────────────────────────────────────┤
│  • Authentication (JWT)                                         │
│  • Token issuance & revocation                                  │
│  • Code encryption/decryption (AES-256-GCM)                    │
│  • Signature verification (Ed25519)                             │
│  • Live connector orchestration                                 │
│  • Audit logging                                                │
└─────────────────────────────────────────────────────────────────┘
         ↓                                      ↓
    ┌─────────────┐                  ┌──────────────────┐
    │   College   │                  │  Employer Portal │
    │   Admin     │                  │   (Browser)      │
    │  Portal     │                  │                  │
    │ (Browser)   │                  │ 1. Paste AX code │
    │             │                  │ 2. Decode check  │
    │ 1. Login    │                  │ 3. Live verify   │
    │ 2. Issue    │                  │ 4. View result   │
    │    cred     │                  └──────────────────┘
    │ 3. Get code │
    └─────────────┘
         ↓
    ┌──────────────────────────┐
    │  IIT Bombay Connector    │
    │  http://localhost:9000   │
    ├──────────────────────────┤
    │ • Queries student DB     │
    │ • Signs live data        │
    │ • Returns Ed25519 sigs   │
    └──────────────────────────┘
```

## 🎯 Complete Workflow

### PHASE 1: SETUP

**Start all services:**
```bash
cd /sessions/great-awesome-ramanujan/mnt/AUTHENX-MAIN
./start-demo.sh
```

This starts:
- ✅ AuthenX Server on http://localhost:3000
- ✅ IIT Bombay Connector on http://localhost:9000

### PHASE 2: COLLEGE ADMIN — ISSUE CREDENTIAL

**1. Open College Portal**
```
URL: ui/college/index.html
```

**2. Login as IIT Bombay Admin**
```
Email:    iitb@authenx.in
Password: College@123
```

**What happens behind the scenes:**
- Browser sends POST /v1/auth/login
- Server validates credentials (scrypt hashed in DB)
- Server returns JWT token (HS256, 24hr expiry)
- Token stored in localStorage
- JWT decoded to get college_id = "d96fa96d-b856-4fd5-bb47-cf8f447f5cdd"

**3. Navigate to "Issue Credential"**
```
Screen: ui/college/issue.html
```

**4. Enter Student Reference**
```
Input: stu_ref_001
```

**What happens:**
- Browser calls POST /api/verify with student_ref_token
- Connector (port 9000) queries SQLite: SELECT * FROM students WHERE student_ref_token = 'stu_ref_001'
- DB returns: name="SUPREETH K", degree="BTECH", branch="COMPUTER SCIENCE", etc.
- Connector builds canonical JSON (fixed field order)
- Connector signs with Ed25519 private key:
  - `issuance_signature = sign(canonical_hash)` — for token storage
  - `live_signature = sign(nonce + ':' + canonical_hash)` — for live verify
- Returns signed data to college admin portal

**5. Preview & Issue**
```
Click "Issue & Sign Credential"
```

**What happens:**
- College portal sends POST /v1/tokens/issue with:
  - college_id, student_ref_token, name, degree, branch, cgpa, etc.
  - issuance_signature (from connector)
- Server:
  1. Builds same canonical JSON
  2. Computes canonical_hash = sha256(canonical_json)
  3. Verifies Ed25519 signature against college's public_key_hex
  4. Stores: {token_id, college_id, canonical_hash, issuance_signature, status='active'}
  5. Generates AES-256-GCM encrypted AuthenX Code (AX1.xxxxx)
  6. Returns authenx_code to college admin
- Portal displays code with options: Copy, QR, Email, Download

**6. Copy the AuthenX Code**
```
Example output:
AX1.mqHmZhGvgPVQMcDgWRRpdU0wR6IKLkw...
(128-char code = encrypted token metadata)
```

**📊 Database State After Issue:**
```
verification_tokens:
├─ id: <UUID>
├─ college_id: d96fa96d-b856-4fd5-bb47-cf8f447f5cdd
├─ student_ref_token: stu_ref_001
├─ canonical_hash: a1b2c3d4e5f6... (SHA-256 hex)
├─ issuance_signature: <Ed25519 base64>
├─ status: active
├─ issued_at: 2026-04-05 15:27:36
└─ revocation_reason: NULL

verification_requests:
└─ event: issue_token
   └─ token_id: <same UUID>
```

---

### PHASE 3: EMPLOYER — VERIFY CREDENTIAL

**1. Open Employer Portal**
```
URL: ui/employer/index.html
```

**2. Login as Employer Admin**
```
Email:    admin@authenx.in
Password: Admin@123
```

**What happens:**
- Same JWT auth flow
- Token stored in localStorage
- Decoded to get employer info

**3. Navigate to "Verify Credential"**
```
Screen: ui/employer/verify.html
```

**4. Paste the AX Code**
```
Paste: AX1.mqHmZhGvgPVQMcDgWRRpdU0wR6IKLkw...
```

**5. Step 1 → Step 2: Code Decoded**
```
Screen: ui/employer/decoding.html
```

**What happens:**
- Browser calls POST /v1/verify/code with authenx_code
- Server:
  1. Decrypts AX code using AES-256-GCM (AES_KEY from env or random)
     - Extracts: token_id, college_id, student_ref_token, etc.
  2. Queries DB: SELECT token WHERE id = token_id
  3. Returns decoded metadata:
     ```json
     {
       "step": "code_decoded",
       "token_id": "<UUID>",
       "college": { "name": "IIT Bombay", "short_code": "IITB" },
       "credential_type": "DEGREE_CERTIFICATE",
       "student_ref_token": "stu_ref_001",
       "canonical_hash": "a1b2c3d4e5f6...",
       "schema_version": "1.0",
       "status": "active",
       "issued_at": "2026-04-05 15:27:36",
       "revoked_at": null,
       "revocation_reason": null
     }
     ```
  4. Logs event: verification_requests.request_type='code_decode'
- Portal displays:
  - ✅ Code format validated (AX1. prefix)
  - ✅ Found in registry (token_id present)
  - ✅ Not revoked (status='active')
  - ✅ Hash integrity (canonical_hash shown)

**📊 Database State After Decode:**
```
verification_requests:
└─ id: <UUID>
   ├─ token_id: <token UUID>
   ├─ employer_name: admin@authenx.in
   ├─ request_type: code_decode
   ├─ result: verified
   └─ timestamp: 2026-04-05 15:28:04
```

**6. Step 2 → Step 3: Live Verification**
```
Click "Run Live Verification"
Screen: ui/employer/verified.html (if pass) or revoked.html (if revoked)
```

**What happens (CRITICAL FLOW):**

1. **Decode code again**
   - Extract token_id from AX code

2. **Fetch token from DB**
   - SELECT token WHERE id = token_id
   - Get: college_id, student_ref_token, canonical_hash, issuance_signature, public_key_hex, connector_url

3. **Call college connector (HTTP POST)**
   ```
   POST http://localhost:9000/verify
   Body: {
     "student_ref_token": "stu_ref_001",
     "nonce": "<random 32-byte hex>"
   }
   ```

   **Connector responds:**
   ```json
   {
     "name": "SUPREETH K",
     "degree": "BTECH",
     "branch": "COMPUTER SCIENCE",
     "credential_type": "DEGREE_CERTIFICATE",
     "cgpa": "8.9",
     "graduation_year": "2024",
     "issue_date": "2024-06-15",
     "live_signature": "<Ed25519 base64>",
     "issuance_signature": "<Ed25519 base64>"
   }
   ```

4. **Server recomputes canonical hash from LIVE data**
   ```
   liveCanonical = buildCanonicalJson({
     schema_version: "1.0",
     issuer_id: college_id,
     student_ref_token: "stu_ref_001",
     name: "SUPREETH K",
     degree: "BTECH",
     branch: "COMPUTER SCIENCE",
     credential_type: "DEGREE_CERTIFICATE",
     cgpa: "8.9",
     graduation_year: "2024",
     issue_date: "2024-06-15"
   })
   liveHash = sha256(liveCanonical)
   ```

5. **Perform 4 cryptographic checks**
   ```
   ✅ hash_match = (liveHash === stored_canonical_hash)
      → LIVE data hasn't been modified

   ✅ issuance_sig = verify(
        stored_canonical_hash,
        stored_issuance_signature,
        public_key_hex
      )
      → Original issuance was authentic (college signed it)

   ✅ live_sig = verify(
        nonce + ':' + liveHash,
        connector_live_signature,
        public_key_hex
      )
      → This response is REAL-TIME from college ERP (nonce prevents replay)

   ✅ not_revoked = (token.status === 'active')
      → Token not revoked by college
   ```

6. **Return verification result**
   ```json
   {
     "result": "verified",
     "college": "IIT Bombay",
     "hash_match": true,
     "issuance_sig": true,
     "live_sig": true,
     "not_revoked": true,
     "latency_ms": 1,
     "live_data": {
       "name": "SUPREETH K",
       "degree": "BTECH",
       "branch": "COMPUTER SCIENCE",
       "credential_type": "DEGREE_CERTIFICATE",
       "cgpa": "8.9",
       "graduation_year": "2024",
       "issue_date": "2024-06-15"
     }
   }
   ```

7. **Portal displays VERIFIED screen**
   - Green banner: "Credential Verified"
   - Student profile: SUPREETH K, IIT Bombay, B.Tech Computer Science, CGPA 8.9
   - LIVE DATA badge (pulsing dot)
   - All 4 checks ✓ green
   - Actions: Download Report, Copy Summary, Verify Another

**📊 Database State After Live Verify:**
```
verification_requests:
└─ id: <UUID>
   ├─ token_id: <token UUID>
   ├─ employer_name: admin@authenx.in
   ├─ request_type: live_verify
   ├─ result: verified
   ├─ hash_match: 1 (true)
   ├─ sig_valid: 1 (both issuance_sig AND live_sig valid)
   ├─ latency_ms: 1
   ├─ nonce: <hex>
   └─ timestamp: 2026-04-05 15:28:05
```

---

## 🔄 ALTERNATIVE FLOW: Revoked Credential

**Same steps 1-5, but with stu_ref_003 (RAHUL NAIR):**

1. Issue token for stu_ref_003
   - Token stored with status='active'

2. Revoke the token
   - POST /v1/tokens/revoke with token_id and reason
   - DB updated: status='revoked', revocation_reason='...'

3. Employer pastes code

4. Step 2 — Decode response shows:
   ```json
   {
     "status": "revoked",
     "revocation_reason": "Academic misconduct",
     "revoked_at": "2026-04-05 15:28:15"
   }
   ```
   - ✅ Code format valid
   - ✅ Found in registry
   - ❌ REVOKED (status != active)
   - Portal shows red "Revoked" card, doesn't allow live verify

5. OR if employer proceeds to live verify anyway:
   - Server returns: `{ "result": "revoked", "reason": "..." }`
   - Portal shows Step 3 red screen with warning box

---

## 🎓 Demo Test Students

```
stu_ref_001: SUPREETH K
  └─ Degree: B.Tech, Branch: Computer Science, CGPA: 8.9
  └─ Status: active (ready to issue)

stu_ref_002: PRIYA SHARMA
  └─ Degree: M.Tech, Branch: Electronics, CGPA: 9.1
  └─ Status: active (ready to issue)

stu_ref_003: RAHUL NAIR
  └─ Degree: B.Tech, Branch: Mechanical, CGPA: 7.8
  └─ Status: active (ready to revoke demo)
```

---

## 🔐 Cryptographic Summary

**Keys stored in system:**
```
Connector private key (Ed25519):
  └─ Hex: e6816daf39d2243903eb013de92acc2f737bbc84ded9bef62e6485cf262afdb0
  └─ Location: authenx-connector/.env
  └─ Backup: authenx-node/authenx-node/connector_key.json

Public key registered in DB:
  └─ Hex: d2d99e7bc2a2212cf0cf5f1bdd0f2be7072623c8d09c036a09baf77c966e6a73
  └─ Used by: all 3 colleges (IITB, NIT, BITS)
```

**Signatures involved:**
```
1. Issuance signature (stored in DB)
   └─ Input: sha256(canonical_json) = "a1b2c3d4e5f6..."
   └─ Signed by: Connector's Ed25519 private key
   └─ Verified at: /v1/tokens/issue (college admin issues token)
   └─ Purpose: Prove college authentically issued credential

2. Live signature (returned by connector at verify time)
   └─ Input: nonce + ':' + sha256(canonical_json) = "xyz123:a1b2c3d4e5f6..."
   └─ Signed by: Connector's Ed25519 private key
   └─ Verified at: /v1/verify/live (employer verifies credential)
   └─ Purpose: Prove this is REAL-TIME response from college ERP
   └─ Nonce prevents replay attacks
```

**AES encryption:**
```
AuthenX Code (AX1.xxxxx)
  └─ Encrypted with: AES-256-GCM
  └─ Key: Random 32 bytes (or env AES_KEY_HEX if set)
  └─ Payload: { v: 1, token_id, college_id, student_ref_token, credential_type, issued_at }
  └─ Format: AX1. + base64url(nonce[12] + tag[16] + ciphertext)
  └─ Decryptable only: Within same session (random key per session unless env var set)
```

---

## ✅ Integration Tests Results

All 31 tests passing:

```
SCENARIO 1: Happy Path (stu_ref_001 — SUPREETH K)
  ✅ Login, issue, decode, live verify, all 4 checks pass, name returned

SCENARIO 2: Revoked (stu_ref_003 — RAHUL NAIR)
  ✅ Issue, revoke, decode shows revoked status, live verify returns revoked

SCENARIO 3: Tampered Codes
  ✅ Fake code rejected
  ✅ Truncated code rejected
  ✅ Non-AX1 prefix rejected
  ✅ Empty code rejected

SCENARIO 4: Concurrent Verifications
  ✅ 5 concurrent decode requests all succeed
  ✅ 3 concurrent live verifies all return verified
  ✅ Audit log captures all events
```

---

## 📋 API Endpoints Reference

### Authentication
```
POST /v1/auth/login
  Body: { email, password }
  Return: { token, role, college_id }
```

### College Admin
```
POST /v1/tokens/issue
  Auth: Bearer token (college_admin)
  Body: { college_id, student_ref_token, name, degree, branch, ... issuance_signature }
  Return: { token_id, authenx_code }

POST /v1/tokens/revoke
  Auth: Bearer token (college_admin)
  Body: { token_id, reason }
  Return: { status: revoked }

GET /v1/tokens
  Auth: Bearer token (college_admin)
  Return: { tokens: [...] }
```

### Employer
```
POST /v1/verify/code
  Auth: Bearer token (employer)
  Body: { authenx_code }
  Return: { step, token_id, college, status, canonical_hash, ... }

POST /v1/verify/live
  Auth: Bearer token (employer)
  Body: { authenx_code }
  Return: { result, college, hash_match, issuance_sig, live_sig, not_revoked, live_data, latency_ms }
```

### Audit
```
GET /v1/audit
  Auth: Bearer token (college_admin)
  Return: { events: [...] }
```

---

## 🚀 To Run The Complete Demo

```bash
# 1. Start all services
cd /sessions/great-awesome-ramanujan/mnt/AUTHENX-MAIN
./start-demo.sh

# 2. Open College Portal
open ui/college/index.html  # or navigate in browser

# 3. Login: iitb@authenx.in / College@123

# 4. Issue Credential for stu_ref_001

# 5. Copy the AX1. code

# 6. Open Employer Portal
open ui/employer/index.html

# 7. Login: admin@authenx.in / Admin@123

# 8. Paste code → See VERIFIED ✓ with LIVE DATA
```

---

## 📊 What Data Gets Stored

**In AuthenX (server):**
- ✅ token_id (UUID)
- ✅ canonical_hash (SHA-256)
- ✅ issuance_signature (Ed25519 base64)
- ✅ status ('active' or 'revoked')
- ❌ Never stores: name, degree, branch, CGPA, graduation_year
  - These are ONLY fetched at verify time from college ERP
  - Never persisted in AuthenX

**What employer sees (temporarily):**
- ✅ Live student data (name, degree, branch, CGPA, etc.)
- ✅ 4 cryptographic verification checks
- ✅ Revocation status
- ❌ Never stored — only displayed during verification

**Privacy-first architecture:**
- College issues credential with Ed25519 signature
- AuthenX stores ONLY hash + signature
- Employer verifies against LIVE ERP data in real-time
- Zero raw student data in AuthenX database

---

## 🔍 Key Insights

1. **Two signatures for two purposes:**
   - Issuance sig: "This college issued this credential"
   - Live sig: "This is the REAL-TIME response from college ERP"

2. **Nonce in live signature:**
   - Prevents replay attacks (attacker can't replay old response)
   - 60-second TTL on connector side

3. **Canonical JSON with fixed field order:**
   - Any tampering changes the hash
   - Both connector and server build identical JSON
   - Hash must match for verification to pass

4. **AES-encrypted AuthenX Code:**
   - Small (128 chars) vs storing full token data
   - Can't be decrypted by external parties
   - Nonce + auth tag prevent tampering

5. **Connector as trusted bridge:**
   - Only system that has Ed25519 private key
   - Only system that can sign live data
   - College controls deployment (on their network)
