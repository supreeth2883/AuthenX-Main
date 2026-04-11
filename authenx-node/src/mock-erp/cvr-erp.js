'use strict';
/**
 * Mock ERP for CVR College of Engineering
 * college_id : 35e8750a-9972-4cc2-8e20-a25bfe2d825b
 * short_code : CVRH
 *
 * PostgreSQL-backed student lookup used when the real external connector is
 * absent or unreachable.  Uses the `pg` npm package (the same optional dep
 * already referenced in colleges.js for provisioning).
 *
 * PostgreSQL connection is configured via the same env vars injected by
 * start-backend-stack.ps1:
 *   PG_PROVISION_HOST     (default: localhost)
 *   PG_PROVISION_PORT     (default: 5432)
 *   PG_PROVISION_USER     (default: postgres)
 *   PG_PROVISION_PASSWORD (default: Postgres@123)
 *   CVR_ERP_PG_DB         (default: postgres)
 */

/** Identifiers for CVR College — imported by connector-proxy for scoping. */
const CVR_COLLEGE_ID = '35e8750a-9972-4cc2-8e20-a25bfe2d825b';
const CVR_SHORT_CODE = 'CVRH';

const TABLE = 'cvr_mock_erp_students';

function pgConfig() {
  return {
    host:                   process.env.PG_PROVISION_HOST     || 'localhost',
    port:                   Number(process.env.PG_PROVISION_PORT) || 5432,
    user:                   process.env.PG_PROVISION_USER     || 'postgres',
    password:               process.env.PG_PROVISION_PASSWORD || 'Postgres@123',
    database:               process.env.CVR_ERP_PG_DB         || 'postgres',
    connectionTimeoutMillis: 5000,
  };
}

/** Open a pg Client, connect, run fn(client), then close. */
async function withClient(fn) {
  const { Client } = require('pg');
  const client = new Client(pgConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  student_id      TEXT PRIMARY KEY,
  full_name       TEXT NOT NULL,
  degree          TEXT NOT NULL,
  dept_name       TEXT NOT NULL,
  cgpa            TEXT NOT NULL,
  grad_year       TEXT NOT NULL,
  issue_date      TEXT NOT NULL,
  student_status  TEXT NOT NULL DEFAULT 'active',
  credential_type TEXT NOT NULL DEFAULT 'DEGREE_CERTIFICATE'
);`;

// ─── Seed data ────────────────────────────────────────────────────────────────
const STUDENTS = [
  // Required quick-action refs from issue.html
  {
    student_id: 'stu_ref_001', full_name: 'SUPREETH K',
    degree: 'BTECH', dept_name: 'COMPUTER SCIENCE AND ENGINEERING',
    cgpa: '8.9', grad_year: '2024', issue_date: '2024-05-15',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_002', full_name: 'PRIYA SHARMA',
    degree: 'BTECH', dept_name: 'ELECTRONICS AND COMMUNICATION ENGINEERING',
    cgpa: '9.1', grad_year: '2024', issue_date: '2024-05-15',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_004', full_name: 'ANANYA PATEL',
    degree: 'BTECH', dept_name: 'INFORMATION TECHNOLOGY',
    cgpa: '8.5', grad_year: '2024', issue_date: '2024-05-15',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  // Additional realistic CVR students
  {
    student_id: 'stu_ref_003', full_name: 'ROHITH REDDY',
    degree: 'BTECH', dept_name: 'MECHANICAL ENGINEERING',
    cgpa: '7.8', grad_year: '2023', issue_date: '2023-06-10',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_005', full_name: 'SIVA KRISHNA MURTHY',
    degree: 'BTECH', dept_name: 'ELECTRICAL AND ELECTRONICS ENGINEERING',
    cgpa: '8.2', grad_year: '2024', issue_date: '2024-05-15',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_006', full_name: 'DIVYA LAKSHMI',
    degree: 'BTECH', dept_name: 'CIVIL ENGINEERING',
    cgpa: '7.5', grad_year: '2023', issue_date: '2023-06-10',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_007', full_name: 'ARAVIND KUMAR',
    degree: 'MTECH', dept_name: 'COMPUTER SCIENCE AND ENGINEERING',
    cgpa: '8.7', grad_year: '2024', issue_date: '2024-05-20',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_008', full_name: 'NAVYA SREE',
    degree: 'BTECH', dept_name: 'COMPUTER SCIENCE AND ENGINEERING',
    cgpa: '9.3', grad_year: '2025', issue_date: '2025-05-20',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_009', full_name: 'VENKAT RAMANA',
    degree: 'BTECH', dept_name: 'CHEMICAL ENGINEERING',
    cgpa: '6.9', grad_year: '2022', issue_date: '2022-06-01',
    student_status: 'inactive', credential_type: 'DEGREE_CERTIFICATE',
  },
  {
    student_id: 'stu_ref_010', full_name: 'KEERTHI VARMA',
    degree: 'BTECH', dept_name: 'ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING',
    cgpa: '9.0', grad_year: '2025', issue_date: '2025-05-20',
    student_status: 'active', credential_type: 'DEGREE_CERTIFICATE',
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create the table (if absent) and upsert all seed rows.
 * Safe to call multiple times — ON CONFLICT DO NOTHING.
 * Returns { total, seeded }.
 */
async function seed() {
  return withClient(async (client) => {
    await client.query(CREATE_TABLE_SQL);

    let seeded = 0;
    for (const s of STUDENTS) {
      const r = await client.query(
        `INSERT INTO ${TABLE}
           (student_id, full_name, degree, dept_name, cgpa, grad_year,
            issue_date, student_status, credential_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (student_id) DO NOTHING`,
        [s.student_id, s.full_name, s.degree, s.dept_name, s.cgpa,
         s.grad_year, s.issue_date, s.student_status, s.credential_type]
      );
      if (r.rowCount > 0) seeded++;
    }
    return { total: STUDENTS.length, seeded };
  });
}

/**
 * Look up a student by student_ref_token.
 * Returns a canonical-compatible object, or null if not found.
 */
async function lookupStudent(student_ref_token) {
  return withClient(async (client) => {
    // Ensure table exists (non-fatal if seed hasn't run yet)
    await client.query(CREATE_TABLE_SQL);

    const r = await client.query(
      `SELECT * FROM ${TABLE} WHERE student_id = $1`,
      [student_ref_token]
    );
    if (r.rows.length === 0) return null;

    const row = r.rows[0];
    return {
      student_ref_token: row.student_id,
      name:              row.full_name,
      degree:            row.degree,
      branch:            row.dept_name,
      cgpa:              row.cgpa,
      graduation_year:   row.grad_year,
      issue_date:        row.issue_date,
      status:            row.student_status,
      credential_type:   row.credential_type,
      college_name:      'CVR College of Engineering',
      source:            'mock_erp',
    };
  });
}

module.exports = { CVR_COLLEGE_ID, CVR_SHORT_CODE, seed, lookupStudent };
