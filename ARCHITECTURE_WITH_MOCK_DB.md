# AuthenX Architecture — With Mock College Database

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AUTHENX ECOSYSTEM                              │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                          STUDENT/CANDIDATE                               │
│                                                                          │
│  1. Receives degree from college                                        │
│  2. Gets AuthenX Code (AES-256-GCM encrypted)                          │
│  3. Shares code with employers during job interviews                   │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
                            [AuthenX Code]
                    AX1.eyJzY2hlbWFfdmVyc2lvbiI6...
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                        EMPLOYER (HCL, Infosys, TCS)                      │
│                                                                          │
│  1. Receives AuthenX Code from candidate                               │
│  2. Pastes into verification app                                       │
│  3. Sees: "VERIFIED ✓" + live credential fields                        │
│  4. Can reference verification record in audit log                     │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
                    [Verification Request]
                    POST /v1/verify/live
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                    AUTHENX API (Node.js Server)                         │
│                  ✓ Zero external dependencies                           │
│              ✓ Ed25519, AES-256-GCM, SHA-256 native                     │
│                  ✓ SQLite database (node:sqlite)                        │
│                                                                          │
│  Responsibilities:                                                     │
│  • Decrypt AuthenX Code                                               │
│  • Fetch token from DB (hash + signatures)                            │
│  • Call college connector for live verification                       │
│  • Verify 3 checks (hash match, issuance sig, live sig)              │
│  • Return live data (never stored)                                   │
│  • Log verification event (audit trail)                              │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
                    [Live Verification Request]
                    POST /verify with nonce
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│               COLLEGE CONNECTOR ADAPTER (Java/Python/Node)              │
│                    (Runs on college network)                            │
│                                                                          │
│  Responsibilities:                                                     │
│  • Receive student_ref_token + nonce                                  │
│  • Query college's student database                                   │
│  • Build canonical JSON (deterministic)                              │
│  • Compute SHA-256 hash                                              │
│  • Sign with college Ed25519 private key                             │
│  • Return live_data + live_signature                                 │
│                                                                          │
│  ↓ ↓ ↓                                                                 │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │                    COLLEGE DATABASE                             │  │
│ │           (Mock or Real: MySQL, Oracle, etc)                   │  │
│ │                                                                 │  │
│ │  colleges TABLE                                               │  │
│ │  ├─ id, code, name, connector_url                            │  │
│ │                                                                 │  │
│ │  students TABLE                                              │  │
│ │  ├─ student_ref_token (PK)                                  │  │
│ │  ├─ college_id (FK)                                         │  │
│ │  ├─ name (UPPERCASE)                                        │  │
│ │  ├─ degree (BTECH, MTECH, MBA)                              │  │
│ │  ├─ branch (COMPUTER SCIENCE, etc)                          │  │
│ │  ├─ cgpa (8.9, 9.2, etc)                                    │  │
│ │  ├─ graduation_year (2024, 2025)                            │  │
│ │  ├─ issue_date (2024-06-15)                                 │  │
│ │  └─ status (active, alumni, withdrawn)                      │  │
│ │                                                                 │  │
│ │  SAMPLE DATA (Mock)                                          │  │
│ │  ├─ IIT Bombay: 4 students                                  │  │
│ │  ├─ NIT Calicut: 4 students                                 │  │
│ │  └─ BITS Pilani: 4 students                                 │  │
│ │                                                                 │  │
│ │  QUERY EXAMPLE                                               │  │
│ │  SELECT * FROM students                                      │  │
│ │  WHERE student_ref_token = 'stu_ref_001'                    │  │
│ │  AND status IN ('active', 'alumni')                         │  │
│ │                                                                 │  │
│ │  RESULT                                                      │  │
│ │  ├─ name: SUPREETH K ✓                                      │  │
│ │  ├─ degree: BTECH ✓                                         │  │
│ │  ├─ branch: COMPUTER SCIENCE ✓                             │  │
│ │  ├─ cgpa: 8.9 ✓                                            │  │
│ │  ├─ graduation_year: 2024 ✓                                │  │
│ │  └─ status: active ✓ (credential valid)                    │  │
│ └─────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  SIGNING PROCESS                                                       │
│  1. Build canonical JSON: {"schema_version":"1.0", ...}              │
│  2. Hash (SHA-256): 52b4a3cd8347f433...                             │
│  3. Sign hash (Ed25519): MEUCIQDx4f8k...                            │
│  4. Sign nonce+hash (Ed25519): for replay resistance                │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
                    [Live Data + Signatures]
                    { name, degree, branch,
                      cgpa, graduation_year,
                      live_signature }
                                    ↓
           (Returns to AuthenX API for verification)
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                    VERIFICATION & RESPONSE                              │
│                                                                          │
│  AuthenX verifies 3 checks:                                           │
│  ✓ Hash Match (recompute canonical JSON, hash matches)              │
│  ✓ Issuance Signature (college's Ed25519 signature valid)           │
│  ✓ Live Signature (nonce+hash signature valid)                      │
│                                                                          │
│  If all 3 pass → Result: VERIFIED ✓                                │
│  If status='revoked' → Result: REVOKED ✗                           │
│                                                                          │
│  Response to Employer:                                              │
│  {                                                                   │
│    "result": "verified",                                            │
│    "college": "IIT Bombay",                                        │
│    "hash_match": true,                                             │
│    "issuance_sig": true,                                           │
│    "live_sig": true,                                               │
│    "latency_ms": 347,                                              │
│    "live_data": {                                                  │
│      "name": "SUPREETH K",         ← Fetched NOW from college    │
│      "degree": "BTECH",             ← Never stored in AuthenX     │
│      "branch": "COMPUTER SCIENCE",  ← Fresh on each verification  │
│      "cgpa": "8.9",                                               │
│      "graduation_year": "2024"                                    │
│    }                                                               │
│  }                                                                  │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
                    [Verification Result]
                    Shown in employer app
                    Logged in audit trail
```

---

## Data Flow: Complete Example with Mock Database

### 1. ISSUE PHASE (College)

```
IIT Bombay College Admin
        ↓
[Credential Issuance Request]
┌──────────────────────────────────┐
│ College: IIT Bombay              │
│ Student Ref: stu_ref_001         │
│ Name: SUPREETH K                 │
│ Degree: BTECH                    │
│ Branch: COMPUTER SCIENCE         │
│ CGPA: 8.9                        │
│ Graduation Year: 2024            │
│ Issue Date: 2024-06-15           │
└──────────────────────────────────┘
        ↓
[Connector signs with Ed25519]
        ↓
Canonical JSON:
{"schema_version":"1.0","issuer_id":"iitb","student_ref_token":"stu_ref_001","name":"SUPREETH K","degree":"BTECH","branch":"COMPUTER SCIENCE","credential_type":"DEGREE_CERTIFICATE","cgpa":"8.9","graduation_year":"2024","issue_date":"2024-06-15"}
        ↓
SHA-256 Hash:
52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
        ↓
Ed25519 Signature:
MEUCIQDx4f8kL9mN2pQ3rS5tU7vW9xY0zA2bC4dE6fG8hI0jK/w==
        ↓
[AuthenX stores: hash + signature only]
        ↓
[Generate AuthenX Code: AES-256-GCM encrypt]
        ↓
AX1.eyJzY2hlbWFfdmVyc2lvbiI6IjEuMCIsImlzc3Vlcl9pZCI6Iml0YmEiLCJzdHVkZW50X3JlZl90b2tlbiI6InN0dV9yZWZfMDAxIiwiTkFNRSI6IlNVUFJFRVRIIEsifQ==
        ↓
Share with SUPREETH K
```

---

### 2. VERIFY PHASE (Employer)

```
HCL Technologies Employer
        ↓
Receives AuthenX Code from SUPREETH K
        ↓
[Paste into verification app]
        ↓
POST /v1/verify/live
{
  "authenx_code": "AX1.eyJ..."
}
        ↓
[AuthenX API Decrypts Code]
        ↓
{
  "token_id": "7307ff88-c7cf-41b9...",
  "college_id": "iitb",
  "student_ref_token": "stu_ref_001"
}
        ↓
[AuthenX fetches from DB]
        ↓
token {
  canonical_hash: 52b4a3cd8347f433...,
  issuance_signature: MEUCIQDx4f8k...
}
        ↓
[AuthenX calls IIT Bombay Connector]
        ↓
POST https://connector.iitb.ac.in/verify
{
  "student_ref_token": "stu_ref_001",
  "nonce": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
}
        ↓
[Connector queries MOCK DATABASE]
        ↓
SELECT * FROM students
WHERE student_ref_token = 'stu_ref_001'
AND status IN ('active', 'alumni')
        ↓
RESULT from Mock DB:
{
  student_ref_token: stu_ref_001,
  name: SUPREETH K,
  degree: BTECH,
  branch: COMPUTER SCIENCE,
  cgpa: 8.9,
  graduation_year: 2024,
  status: active ✓
}
        ↓
[Connector builds canonical JSON from LIVE data]
        ↓
{"schema_version":"1.0","issuer_id":"iitb","student_ref_token":"stu_ref_001","name":"SUPREETH K","degree":"BTECH","branch":"COMPUTER SCIENCE","credential_type":"DEGREE_CERTIFICATE","cgpa":"8.9","graduation_year":"2024","issue_date":"2024-06-15"}
        ↓
[Connector computes SHA-256 hash]
        ↓
52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
        ↓
[Connector signs with Ed25519 private key]
        ↓
live_signature: MEUCIQCy5g7h8i9...
        ↓
[Returns to AuthenX]
        ↓
{
  name: SUPREETH K,
  degree: BTECH,
  branch: COMPUTER SCIENCE,
  cgpa: 8.9,
  graduation_year: 2024,
  live_signature: MEUCIQCy5g7h8i9...
}
        ↓
[AuthenX Verification Checks]
        ↓
Check 1: Hash Match?
  Recomputed: 52b4a3cd8347f433...
  Stored:     52b4a3cd8347f433...
  → ✓ MATCH
        ↓
Check 2: Issuance Signature Valid?
  Verify(hash, stored_signature, college_pubkey)
  → ✓ VALID
        ↓
Check 3: Live Signature Valid?
  Verify(nonce+hash, live_signature, college_pubkey)
  → ✓ VALID
        ↓
ALL CHECKS PASS → Result: VERIFIED ✓
        ↓
[Return to HCL Employer App]
        ↓
{
  "result": "verified",
  "college": "IIT Bombay",
  "hash_match": true,
  "issuance_sig": true,
  "live_sig": true,
  "latency_ms": 347,
  "live_data": {
    "name": "SUPREETH K",
    "degree": "BTECH",
    "branch": "COMPUTER SCIENCE",
    "cgpa": "8.9",
    "graduation_year": "2024"
  }
}
        ↓
[Shown to HCL hiring manager]
        ↓
✓ VERIFIED — Candidate credential confirmed
```

---

## Privacy Layer: What's Stored Where

```
┌────────────────────────────────────────────────────────────────┐
│                    COLLEGE DATABASE                             │
│                  (Private to college)                           │
│                                                                  │
│  students TABLE with complete records:                        │
│  ├─ student_ref_token → stu_ref_001                          │
│  ├─ name → SUPREETH K                                        │
│  ├─ degree → BTECH                                           │
│  ├─ branch → COMPUTER SCIENCE                                │
│  ├─ cgpa → 8.9                                               │
│  ├─ graduation_year → 2024                                   │
│  ├─ status → active                                          │
│  ├─ enrollment_date                                          │
│  ├─ phone_number                                             │
│  ├─ email                                                    │
│  ├─ address                                                  │
│  └─ ... [all personal data]                                  │
│                                                                  │
│  Status: KEPT AT COLLEGE                                      │
│  Access: College admin + connector only                       │
│  Backup: College's responsibility                             │
└────────────────────────────────────────────────────────────────┘
                            ↓ (via connector)
                    [Only hash + signature]
                            ↓
┌────────────────────────────────────────────────────────────────┐
│                   AUTHENX DATABASE                              │
│                   (Secure at AuthenX)                          │
│                                                                  │
│  verification_tokens TABLE:                                   │
│  ├─ id → 7307ff88-c7cf-41b9-b263-9940f9ec2bbc               │
│  ├─ college_id → iitb                                        │
│  ├─ student_ref_token → stu_ref_001  (for lookup only)      │
│  ├─ canonical_hash → 52b4a3cd8347f433...  (fingerprint)    │
│  ├─ issuance_signature → MEUCIQDx4f8k...  (proof)           │
│  ├─ credential_type → DEGREE_CERTIFICATE                    │
│  ├─ status → active/revoked                                 │
│  ├─ issued_at → 2024-06-15 12:00:00                        │
│  └─ [NO PERSONAL DATA]                                       │
│                                                                  │
│  Status: ZERO PERSONAL DATA STORED                            │
│  Content: Cryptographic proof only                            │
│  Privacy: Complete — only identifiers + hashes              │
└────────────────────────────────────────────────────────────────┘
                            ↓ (at verification time)
                    [Fetch live data]
                            ↓
        ┌───────────────────────────────────────────┐
        │  LIVE DATA SHOWN TO EMPLOYER              │
        │  (Then discarded — not stored)            │
        │                                             │
        │  name: SUPREETH K                        │
        │  degree: BTECH                           │
        │  branch: COMPUTER SCIENCE                │
        │  cgpa: 8.9                               │
        │  graduation_year: 2024                   │
        │                                             │
        │  Status: TRANSIENT (fetch + show + delete)│
        │  Stored: NO — verified & forgotten        │
        └───────────────────────────────────────────┘
```

---

## Connector Adapter Implementation (Pseudo-code)

```javascript
// College's Connector Service
// Runs on college network, has access to student database

async function handleVerificationRequest(req) {
  const { student_ref_token, nonce } = req.body;

  // 1. Query college database for live student record
  const student = await db.query(
    "SELECT * FROM students WHERE student_ref_token = ? AND status IN ('active', 'alumni')",
    [student_ref_token]
  );

  if (!student) {
    return { error: "Student not found or inactive" };
  }

  // 2. Build canonical JSON (FIXED field order)
  const canonicalJSON = JSON.stringify({
    schema_version:    "1.0",
    issuer_id:        "college-iitb-001",
    student_ref_token: student.student_ref_token,
    name:             student.name,
    degree:           student.degree,
    branch:           student.branch,
    credential_type:  "DEGREE_CERTIFICATE",
    cgpa:             String(student.cgpa),
    graduation_year:  String(student.graduation_year),
    issue_date:       student.issue_date
  }, null, 0); // No whitespace

  // 3. Compute SHA-256 hash
  const hash = sha256(canonicalJSON);

  // 4. Sign hash with college's Ed25519 private key
  const signature = signEd25519(hash, COLLEGE_PRIVATE_KEY);

  // 5. Sign nonce+hash for replay resistance
  const liveSignature = signEd25519(
    nonce + ":" + hash,
    COLLEGE_PRIVATE_KEY
  );

  // 6. Return live data + signatures
  return {
    name:            student.name,
    degree:          student.degree,
    branch:          student.branch,
    cgpa:            String(student.cgpa),
    graduation_year: String(student.graduation_year),
    live_signature:  liveSignature
  };
}
```

---

## Testing with Mock Database

1. **Create Schema**
   ```bash
   mysql < mock_college_database.sql
   ```

2. **Test Queries**
   ```sql
   -- Fetch active student
   SELECT * FROM students
   WHERE student_ref_token = 'stu_ref_001'
   AND status = 'active';

   -- Result: SUPREETH K record (all 8 fields)
   ```

3. **Test Connector**
   - Build connector to query this database
   - Sign results with Ed25519
   - Return live_data + signature

4. **Test Full Flow**
   - Issue credential
   - Get AuthenX Code
   - Decode code
   - Live verify
   - See live data from mock DB
   - All 3 checks pass ✓

---

## Next: Real Deployment

When deploying with actual college:

1. **Replace mock database** with college's real student database
2. **Map schema** (college's fields → AuthenX standard)
3. **Deploy connector** on college network
4. **Register Ed25519 public key** with AuthenX
5. **Test end-to-end** with real students

The entire flow remains identical — only the data source changes.

---

**Version**: AuthenX 1.0.0
**Date**: April 2026
**Database**: Mock (12 test students, 3 colleges)
**Privacy**: ✓ Zero personal data stored in AuthenX
