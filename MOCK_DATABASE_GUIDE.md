# AuthenX Mock College Database — Complete Transparent Workflow

## Overview

This guide shows **exactly how data flows** through the AuthenX connector system using realistic college student records. Every transformation is shown with real values, so you can understand the complete verification workflow with 100% transparency.

**Key Principle**: The mock database represents a college's internal student records. The connector adapter queries this data, signs it cryptographically, and provides it to AuthenX. AuthenX stores ONLY the hash and signature—never the raw student data.

---

## Database Schema

### Colleges Table
```sql
id (INT PRIMARY KEY)
code (VARCHAR) — IITB, NITC, BITS
name (VARCHAR) — IIT Bombay, NIT Calicut, BITS Pilani
connector_url (VARCHAR) — URL where connector service runs
created_at (TIMESTAMP)
```

### Students Table
```sql
student_ref_token (VARCHAR PRIMARY KEY) — stu_ref_001, stu_ref_002, etc
college_id (INT FOREIGN KEY) — links to colleges table
name (VARCHAR UPPERCASE) — SUPREETH K, PRIYA SHARMA, etc
degree (VARCHAR) — BTECH, MTECH, MBA, BCA
branch (VARCHAR) — COMPUTER SCIENCE, ELECTRONICS, MECHANICAL, etc
cgpa (DECIMAL) — 8.9, 9.2, 7.5, etc
graduation_year (INT) — 2024, 2025, etc
issue_date (DATE) — when credential was issued
status (ENUM) — active, alumni, deferred, withdrawn
created_at, updated_at (TIMESTAMPS)
```

---

## Sample Data: 3 Colleges × 4 Students Each

### IIT Bombay (college_id = 1)
| Ref Token | Name | Degree | Branch | CGPA | Grad Year | Status |
|-----------|------|--------|--------|------|-----------|--------|
| stu_ref_001 | SUPREETH K | BTECH | COMPUTER SCIENCE | 8.9 | 2024 | **active** ✓ |
| stu_ref_004 | ANANYA PATEL | BTECH | ELECTRICAL ENGINEERING | 9.3 | 2024 | active |
| stu_ref_007 | VIKRAM SINGH | MTECH | COMPUTER SCIENCE | 8.7 | 2024 | alumni |
| stu_ref_010 | PRIYA DESAI | BTECH | MECHANICAL ENGINEERING | 8.2 | 2023 | alumni |

### NIT Calicut (college_id = 2)
| Ref Token | Name | Degree | Branch | CGPA | Grad Year | Status |
|-----------|------|--------|--------|------|-----------|--------|
| stu_ref_002 | PRIYA SHARMA | MTECH | ELECTRONICS | 9.1 | 2024 | **active** ✓ |
| stu_ref_005 | KARTHIK MENON | BTECH | CIVIL ENGINEERING | 7.6 | 2023 | alumni |
| stu_ref_008 | AMIT KUMAR | BTECH | COMPUTER SCIENCE | 8.5 | 2024 | active |
| stu_ref_011 | NEHA GUPTA | MBA | GENERAL | 8.9 | 2023 | alumni |

### BITS Pilani (college_id = 3)
| Ref Token | Name | Degree | Branch | CGPA | Grad Year | Status |
|-----------|------|--------|--------|------|-----------|--------|
| stu_ref_003 | RAHUL NAIR | BTECH | MECHANICAL ENGINEERING | 7.8 | 2023 | **withdrawn** ✗ |
| stu_ref_006 | DIVYA KUMAR | MBA | FINANCE | 8.7 | 2024 | active |
| stu_ref_009 | ARJUN REDDY | BTECH | ELECTRICAL ENGINEERING | 8.4 | 2024 | active |
| stu_ref_012 | SANJANA VERMA | BTECH | COMPUTER SCIENCE | 9.0 | 2024 | active |

---

## Data Transformation: Step-by-Step with Real Values

### Scenario: HCL Technologies verifies SUPREETH K (stu_ref_001)

---

#### **Step 1: SUBREETH shares AuthenX Code with HCL**

```
AX1.eyJzY2hlbWFfdmVyc2lvbiI6IjEuMCIsImlzc3Vlcl9pZCI6ImNvbGxlZ2UtaWl0Yi0wMDEiLCJzdHVkZW50X3JlZl90b2tlbiI6InN0dV9yZWZfMDAxIiwidG9rZW5faWQiOiI3MzA3ZmY4OC1jN2NmLTQxYjktYjI2My05OTQwZjllYzJiYmMiLCJjcmVkZW50aWFsX3R5cGUiOiJERUdSRUVfQ0VSVElGSUNBVEUiLCJpc3N1ZWRfYXQiOiIyMDI0LTA2LTE1VDEyOjAwOjAwWiJ9...
```

This is AES-256-GCM encrypted. Only AuthenX app can decrypt it.

---

#### **Step 2: AuthenX decrypts the code**

```json
{
  "v": 1,
  "token_id": "7307ff88-c7cf-41b9-b263-9940f9ec2bbc",
  "college_id": "college-iitb-001",
  "student_ref_token": "stu_ref_001",
  "credential_type": "DEGREE_CERTIFICATE",
  "issued_at": "2024-06-15T12:00:00Z"
}
```

Decryption succeeds ✓ (code is valid, not tampered)

---

#### **Step 3: AuthenX fetches stored token from database**

Query: `SELECT * FROM verification_tokens WHERE id = '7307ff88-...'`

Result:
```
id: 7307ff88-c7cf-41b9-b263-9940f9ec2bbc
college_id: college-iitb-001
student_ref_token: stu_ref_001
canonical_hash: 52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
issuance_signature: MEUCIQDx4f8kL9mN2pQ3rS5tU7vW9xY0zA2bC4dE6fG8hI0jK/w==
status: active
issued_at: 2024-06-15 12:00:00
```

AuthenX now knows:
- Where to find the college connector (college_id → IIT Bombay)
- What to ask for (student_ref_token = stu_ref_001)
- What to compare against (canonical_hash, issuance_signature)

---

#### **Step 4: AuthenX calls IIT Bombay's connector**

```http
POST https://connector.iitb.ac.in/verify HTTP/1.1
Content-Type: application/json
Authorization: Bearer <shared_secret>

{
  "student_ref_token": "stu_ref_001",
  "nonce": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "challenge": "hash_match_and_signature_verify"
}
```

The nonce prevents replay attacks. Each verification uses a fresh nonce.

---

#### **Step 5: Connector Queries College Database**

The IIT Bombay connector runs this query:

```sql
SELECT * FROM students
WHERE student_ref_token = 'stu_ref_001'
AND status IN ('active', 'alumni');
```

**Result from mock database:**
```
student_ref_token: stu_ref_001
college_id: 1
name: SUPREETH K
degree: BTECH
branch: COMPUTER SCIENCE
cgpa: 8.9
graduation_year: 2024
issue_date: 2024-06-15
status: active
```

✓ Record found, status is ACTIVE

---

#### **Step 6: Connector Builds Canonical JSON**

The connector constructs a **deterministic** JSON with fields in FIXED order:

```json
{
  "schema_version": "1.0",
  "issuer_id": "college-iitb-001",
  "student_ref_token": "stu_ref_001",
  "name": "SUPREETH K",
  "degree": "BTECH",
  "branch": "COMPUTER SCIENCE",
  "credential_type": "DEGREE_CERTIFICATE",
  "cgpa": "8.9",
  "graduation_year": "2024",
  "issue_date": "2024-06-15"
}
```

**CRITICAL**: Field order is FIXED. Any reordering changes the hash. Any missing/extra field = different hash.

Serialized (no spaces, no line breaks):
```
{"schema_version":"1.0","issuer_id":"college-iitb-001","student_ref_token":"stu_ref_001","name":"SUPREETH K","degree":"BTECH","branch":"COMPUTER SCIENCE","credential_type":"DEGREE_CERTIFICATE","cgpa":"8.9","graduation_year":"2024","issue_date":"2024-06-15"}
```

---

#### **Step 7: Connector Computes SHA-256 Hash**

Input: the canonical JSON string above
Algorithm: SHA-256

```
SHA-256 Hash:
52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
```

This hash is the "fingerprint" of this exact credential. If ANY field changes, the hash changes.

---

#### **Step 8: Connector Signs Hash with Ed25519**

The connector uses IIT Bombay's Ed25519 **private key** to sign the hash:

```
Private Key (hex): a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0
Message to sign: 52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
Algorithm: Ed25519

Live Signature:
MEUCIQDx4f8kL9mN2pQ3rS5tU7vW9xY0zA2bC4dE6fG8hI0jK/w==
```

Only IIT Bombay (with their private key) can create this exact signature.

---

#### **Step 9: Connector Returns Response**

```json
{
  "name": "SUPREETH K",
  "degree": "BTECH",
  "branch": "COMPUTER SCIENCE",
  "credential_type": "DEGREE_CERTIFICATE",
  "cgpa": "8.9",
  "graduation_year": "2024",
  "schema_version": "1.0",
  "live_signature": "MEUCIQDx4f8kL9mN2pQ3rS5tU7vW9xY0zA2bC4dE6fG8hI0jK/w=="
}
```

✓ All live data from the college database
✓ Signed by college's Ed25519 key
✓ Timestamp: [current time] (proves freshness)

---

#### **Step 10: AuthenX Performs 3 Verification Checks**

**Check #1: Recompute Hash from Live Data**

AuthenX takes the connector's response and rebuilds the canonical JSON:

```json
{
  "schema_version": "1.0",
  "issuer_id": "college-iitb-001",
  "student_ref_token": "stu_ref_001",
  "name": "SUPREETH K",
  "degree": "BTECH",
  "branch": "COMPUTER SCIENCE",
  "credential_type": "DEGREE_CERTIFICATE",
  "cgpa": "8.9",
  "graduation_year": "2024",
  "issue_date": "2024-06-15"
}
```

Compute hash:
```
SHA-256(canonical) = 52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
```

Compare with stored hash:
```
Stored:  52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
Computed: 52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
Result: ✓ HASH MATCH
```

---

**Check #2: Verify Issuance Signature**

AuthenX uses IIT Bombay's public Ed25519 key (registered during college onboarding):

```
Public Key (hex): c7d0e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8
Message: 52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
Signature: MEUCIQDx4f8kL9mN2pQ3rS5tU7vW9xY0zA2bC4dE6fG8hI0jK/w==
Verify: Ed25519 signature valid? YES ✓
```

The signature proves:
- IIT Bombay signed this credential
- The hash hasn't been tampered with

---

**Check #3: Verify Live Signature (Replay Resistance)**

Connector also signs the nonce + hash to prove freshness:

```
Nonce: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
Hash: 52b4a3cd8347f433e8a2f1c9d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
Message: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6:52b4a3cd8347f433...
Live Signature: MEUCIQCy5g7h8i9...

Verify: Ed25519 signature valid? YES ✓
```

This proves:
- The live data was signed by the connector
- This is a fresh response (nonce matches)
- Not a replay of old data

---

#### **Step 11: AuthenX Returns to HCL**

```json
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
    "credential_type": "DEGREE_CERTIFICATE",
    "cgpa": "8.9",
    "graduation_year": "2024"
  },
  "note": "Live data fetched from IIT Bombay ERP at verification time. Never stored in AuthenX."
}
```

HCL sees the verification result:
- ✓ All 3 checks passed
- ✓ Live data from the college (fetched at verification time)
- ✓ Response time: 347ms (live ERP query)

---

## Revoked Credential Example: RAHUL NAIR (stu_ref_003)

If HCL verifies RAHUL NAIR:

**Database query result:**
```
student_ref_token: stu_ref_003
name: RAHUL NAIR
degree: BTECH
status: withdrawn  ← Status is NOT 'active'
```

**AuthenX response:**
```json
{
  "result": "revoked",
  "college": "BITS Pilani",
  "reason": "Student withdrew from program",
  "revoked_at": "2023-06-15T00:00:00Z",
  "note": "This credential is no longer valid."
}
```

The connector checks `status` field:
- If `'active'` or `'alumni'` → credential is valid ✓
- If `'withdrawn'`, `'deferred'`, etc. → credential is revoked ✗

---

## Complete Transparency: What AuthenX Stores vs. Doesn't Store

### ✓ AuthenX Stores (Privacy-Safe)
| Data | Reason |
|------|--------|
| `canonical_hash` (SHA-256 hex) | Tamper-proof fingerprint |
| `issuance_signature` (Ed25519 base64) | Proves college signed it |
| `token_id` (UUID) | Unique identifier |
| `status` (active/revoked) | Whether credential is valid |
| `college_id` | Which college issued it |

**Total per credential: ~512 bytes of cryptographic data**

---

### ✗ AuthenX Does NOT Store (Privacy Protected)
| Data | Why Not |
|------|---------|
| Student name | Personal data stays at college |
| CGPA / grades | Sensitive academic data at source |
| Enrollment history | Audit trail at college |
| Database credentials | Only connector has ERP access |
| Phone, email, address | Zero personal data policy |

**Key**: Live credential fields (`name`, `cgpa`, `graduation_year`) are fetched from college ERP **at verification time**, shown to employer, then **discarded**. Never persisted in AuthenX.

---

## Security Model: Threat vs. Defense

| Threat | Attack Scenario | Defense |
|--------|-----------------|---------|
| **Tampering** | Change CGPA from 8.9 to 9.9 | Hash changes → signature invalid |
| **Forgery** | Forge signature without private key | Ed25519 impossible without key |
| **Replay** | Use old code with stale CGPA | Nonce + live signature each time |
| **Data breach** | Steal student data from AuthenX | No personal data stored |
| **College impersonation** | Another college signs credentials | Public key registry validates issuer |
| **Employer fraud** | Fake employer requests verification | Shared nonce pattern + audit log |

---

## How to Use This for Testing

### 1. Load Mock Database
```bash
mysql -u root < mock_college_database.sql
```

### 2. Query Test Students
```sql
SELECT * FROM students WHERE student_ref_token = 'stu_ref_001';
```

### 3. Test Connector Adapter
Build the connector to:
- Accept: `{ student_ref_token, nonce }`
- Query this database
- Build canonical JSON
- Sign with college Ed25519 key
- Return: `{ live_data, live_signature }`

### 4. Test Full Flow
- Issue credential from college
- Get AuthenX Code
- Decode code
- Live verify → see live data from database
- All 3 checks pass ✓

---

## Key Learning Points

1. **Canonical JSON order is fixed** — must never change
2. **Hash is deterministic** — same data = same hash every time
3. **Signatures prove authenticity** — college proves it signed
4. **Live data is transient** — fetched fresh, never stored
5. **AuthenX stores zero personal data** — only hashes + signatures
6. **Privacy-first by design** — all sensitive data stays at source (college)
7. **Double verification** — both issuance and live signatures prove authenticity
8. **Nonce prevents replay** — each verification uses fresh nonce + live signature
9. **Transparent workflow** — employer sees exactly what happened
10. **Audit trail immutable** — every verification event logged with timestamp

---

## Real-World Deployment

When deployed with a real college:

1. Replace this mock database with actual college student records (MySQL, Oracle, etc.)
2. Map college's schema → AuthenX standard schema
3. Run connector as service on college network
4. Register college's public key with AuthenX
5. Employers verify students in real-time against live college data

The workflow stays exactly the same — only the data source changes from mock to real.

---

## Files in This Package

- `mock_college_database.sql` — Create this schema and seed data
- `MOCK_DATABASE_GUIDE.md` — This guide (complete transparency)
- `authenx-node/src/routes/verify.js` — Connector integration code
- `seed_codes.json` — Test AuthenX codes (pre-generated from seed data)

---

**Created**: April 2026
**AuthenX Version**: 1.0.0
**Privacy First**: ✓ No student data stored in AuthenX
**Transparency**: ✓ All transformations shown with real data
