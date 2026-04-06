# AuthenX Connector Architecture

## Design Principle: "Plug & Play" for Any College

```
┌─────────────────────────────────────────────────────────────┐
│                    CONNECTOR FRAMEWORK                       │
│                                                               │
│   ┌──────────────────────────────────────────────────────┐  │
│   │              ADAPTER INTERFACE (standard)              │  │
│   │                                                        │  │
│   │  Input:  { student_ref_token, nonce }                 │  │
│   │  Output: { name, degree, branch, cgpa, ...,           │  │
│   │            live_signature }                            │  │
│   │                                                        │  │
│   │  Every adapter implements this same contract.          │  │
│   └──────────────────────────────────────────────────────┘  │
│                          │                                    │
│           ┌──────────────┼──────────────┐                    │
│           ▼              ▼              ▼                    │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │
│   │   MySQL     │ │   Oracle    │ │   REST API  │          │
│   │   Adapter   │ │   Adapter   │ │   Adapter   │          │
│   │             │ │             │ │             │          │
│   │ SELECT *    │ │ SELECT *    │ │ GET /api/   │          │
│   │ FROM        │ │ FROM        │ │ students/   │          │
│   │ students    │ │ students    │ │ {ref}       │          │
│   │ WHERE ...   │ │ WHERE ...   │ │             │          │
│   └─────────────┘ └─────────────┘ └─────────────┘          │
│           │              │              │                    │
│           ▼              ▼              ▼                    │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │
│   │  College A  │ │  College B  │ │  College C  │          │
│   │  MySQL DB   │ │  Oracle DB  │ │  Cloud ERP  │          │
│   └─────────────┘ └─────────────┘ └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

## How College Onboarding Works

When a new college joins AuthenX:

1. College IT provides: "Here's our database schema"
2. We create a MAPPING CONFIG (JSON file):
   ```json
   {
     "college_id": "iitb",
     "college_name": "IIT Bombay",
     "adapter_type": "mysql",
     "db_config": {
       "host": "college-internal.iitb.ac.in",
       "port": 3306,
       "database": "student_records",
       "user": "authenx_readonly",
       "password": "<from-env>"
     },
     "field_mapping": {
       "student_ref_token": "enrollment_number",
       "name": "CONCAT(first_name, ' ', last_name)",
       "degree": "program_name",
       "branch": "department",
       "cgpa": "final_cgpa",
       "graduation_year": "YEAR(graduation_date)",
       "issue_date": "convocation_date",
       "status_field": "enrollment_status",
       "active_values": ["ACTIVE", "GRADUATED", "ALUMNI"]
     }
   }
   ```
3. Deploy connector with this config
4. Register college's Ed25519 public key with AuthenX
5. Done — AuthenX can now verify this college's students

## Privacy Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    COLLEGE NETWORK                         │
│                  (College controls this)                   │
│                                                            │
│  ┌──────────────┐     ┌──────────────────────────────┐  │
│  │  College DB   │────→│  AuthenX Connector Service   │  │
│  │  (MySQL/etc)  │     │                              │  │
│  │               │     │  • READ-ONLY DB access       │  │
│  │  Full student │     │  • Never writes to college DB│  │
│  │  records      │     │  • Never exports bulk data   │  │
│  └──────────────┘     │  • Query ONLY by ref_token   │  │
│                        │  • Returns ONLY mapped fields│  │
│                        │  • Signs with Ed25519 key    │  │
│                        └──────────────┬───────────────┘  │
│                                        │                   │
│                          COLLEGE FIREWALL                  │
└────────────────────────────────────────┼───────────────────┘
                                         │
                              [Signed response only]
                              {name, degree, branch,
                               cgpa, grad_year,
                               live_signature}
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────┐
│                    AUTHENX CLOUD                          │
│                                                            │
│  Receives: Live signed data                              │
│  Stores: NOTHING from this response                      │
│  Shows: To employer (then discards)                      │
│  Logs: Only verification event metadata                  │
└──────────────────────────────────────────────────────────┘
```

### Privacy Guarantees:
1. Connector runs ON COLLEGE NETWORK — data never leaves
2. READ-ONLY database access — we never write to their DB
3. SINGLE RECORD queries only — no bulk export possible
4. FIELD MAPPING controls what's exposed — college decides
5. Ed25519 signing — college proves authenticity
6. AuthenX stores ZERO student data — only hash + signature
