-- ============================================================================
-- AuthenX Mock College Database
-- Complete transparent mock of real college student records
-- ============================================================================
-- This schema represents how colleges store student data.
-- The connector adapter will query this to fetch live student records
-- during verification. This is PURELY FOR TESTING/DEMONSTRATION.
-- ============================================================================

-- Colleges Table (the institutions using AuthenX)
CREATE TABLE IF NOT EXISTS colleges (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  code            VARCHAR(20) UNIQUE NOT NULL,      -- IITB, NITC, BITS
  name            VARCHAR(100) NOT NULL,             -- IIT Bombay, NIT Calicut, etc
  connector_url   VARCHAR(255),                      -- Where connector service runs
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Students Table (enrollment records)
CREATE TABLE IF NOT EXISTS students (
  student_ref_token VARCHAR(50) PRIMARY KEY,        -- stu_ref_001, stu_ref_002, etc (AuthenX ref)
  college_id      INT NOT NULL REFERENCES colleges(id),
  name            VARCHAR(100) NOT NULL,             -- UPPERCASE as per spec
  degree          VARCHAR(20) NOT NULL,              -- BTECH, MTECH, MBA, BCA, etc
  branch          VARCHAR(50) NOT NULL,              -- COMPUTER SCIENCE, ELECTRONICS, MECHANICAL, etc
  cgpa            DECIMAL(3,1) NOT NULL,             -- 8.9, 9.2, 7.5, etc
  graduation_year INT NOT NULL,                      -- 2024, 2025, etc
  issue_date      DATE NOT NULL,                     -- When credential was issued
  status          ENUM('active', 'alumni', 'deferred', 'withdrawn') DEFAULT 'active',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_college (college_id),
  INDEX idx_ref_token (student_ref_token)
);

-- ============================================================================
-- SEED DATA: IIT BOMBAY
-- ============================================================================

INSERT INTO colleges (code, name, connector_url) VALUES
('IITB', 'IIT Bombay', 'http://connector.iitb.ac.in'),
('NITC', 'NIT Calicut', 'http://connector.nitc.ac.in'),
('BITS', 'BITS Pilani', 'http://connector.bits-pilani.ac.in');

-- IIT Bombay Students
INSERT INTO students (student_ref_token, college_id, name, degree, branch, cgpa, graduation_year, issue_date, status) VALUES
('stu_ref_001', 1, 'SUPREETH K', 'BTECH', 'COMPUTER SCIENCE', 8.9, 2024, '2024-06-15', 'active'),
('stu_ref_004', 1, 'ANANYA PATEL', 'BTECH', 'ELECTRICAL ENGINEERING', 9.3, 2024, '2024-06-15', 'active'),
('stu_ref_007', 1, 'VIKRAM SINGH', 'MTECH', 'COMPUTER SCIENCE', 8.7, 2024, '2024-06-15', 'alumni'),
('stu_ref_010', 1, 'PRIYA DESAI', 'BTECH', 'MECHANICAL ENGINEERING', 8.2, 2023, '2023-06-15', 'alumni');

-- NIT Calicut Students
INSERT INTO students (student_ref_token, college_id, name, degree, branch, cgpa, graduation_year, issue_date, status) VALUES
('stu_ref_002', 2, 'PRIYA SHARMA', 'MTECH', 'ELECTRONICS', 9.1, 2024, '2024-06-15', 'active'),
('stu_ref_005', 2, 'KARTHIK MENON', 'BTECH', 'CIVIL ENGINEERING', 7.6, 2023, '2023-06-15', 'alumni'),
('stu_ref_008', 2, 'AMIT KUMAR', 'BTECH', 'COMPUTER SCIENCE', 8.5, 2024, '2024-06-15', 'active'),
('stu_ref_011', 2, 'NEHA GUPTA', 'MBA', 'GENERAL', 8.9, 2023, '2023-06-15', 'alumni');

-- BITS Pilani Students
INSERT INTO students (student_ref_token, college_id, name, degree, branch, cgpa, graduation_year, issue_date, status) VALUES
('stu_ref_003', 3, 'RAHUL NAIR', 'BTECH', 'MECHANICAL ENGINEERING', 7.8, 2023, '2023-06-15', 'withdrawn'),
('stu_ref_006', 3, 'DIVYA KUMAR', 'MBA', 'FINANCE', 8.7, 2024, '2024-06-15', 'active'),
('stu_ref_009', 3, 'ARJUN REDDY', 'BTECH', 'ELECTRICAL ENGINEERING', 8.4, 2024, '2024-06-15', 'active'),
('stu_ref_012', 3, 'SANJANA VERMA', 'BTECH', 'COMPUTER SCIENCE', 9.0, 2024, '2024-06-15', 'active');

-- ============================================================================
-- QUERY EXAMPLES FOR CONNECTOR IMPLEMENTATION
-- ============================================================================

-- Example 1: Fetch SUPREETH K (active student)
-- Query: SELECT * FROM students WHERE student_ref_token = 'stu_ref_001';
-- Result: Returns all 8 fields needed for credential verification

-- Example 2: Check if student exists
-- SELECT COUNT(*) FROM students WHERE student_ref_token = ? AND status = 'active';

-- Example 3: Get all active credentials from a college
-- SELECT * FROM students WHERE college_id = 1 AND status = 'active';

-- Example 4: Verify graduation year (for post-degree employment)
-- SELECT graduation_year FROM students WHERE student_ref_token = ? AND graduation_year <= YEAR(NOW());

-- ============================================================================
-- CONNECTOR ADAPTER WORKFLOW
-- ============================================================================
--
-- When an employer verifies a student credential:
--
-- 1. AuthenX API receives: { authenx_code: "AX1.eyJ..." }
-- 2. AuthenX decrypts code → gets token_id, college_id, student_ref_token
-- 3. AuthenX calls connector: POST /verify { student_ref_token: "stu_ref_001", nonce: "..." }
-- 4. Connector queries this database:
--    SELECT * FROM students WHERE student_ref_token = ? AND status IN ('active', 'alumni')
-- 5. Connector builds canonical JSON from results (deterministic field order):
--    {"schema_version":"1.0","issuer_id":"...", ... all fields in fixed order ...}
-- 6. Connector computes SHA-256 hash of canonical JSON
-- 7. Connector signs hash with college Ed25519 private key
-- 8. Connector returns live_data + signature to AuthenX
-- 9. AuthenX verifies: 3 checks (hash match, issuance sig, live sig)
-- 10. AuthenX returns to employer with live_data (never stored in AuthenX)
--
-- ============================================================================
