'use strict';

const { Client } = require('pg');

const DEFAULT_STUDENTS = [
  { student_id: 'stu_ref_001', full_name: 'SUPREETH K', dept_name: 'COMPUTER SCIENCE AND ENGINEERING', degree: 'BTECH', issue_date: '2024-05-15', credential_type: 'DEGREE_CERTIFICATE', cgpa: 8.9, grad_year: '2024', student_status: 'active' },
  { student_id: 'stu_ref_002', full_name: 'PRIYA SHARMA', dept_name: 'ELECTRONICS AND COMMUNICATION ENGINEERING', degree: 'BTECH', issue_date: '2024-05-15', credential_type: 'DEGREE_CERTIFICATE', cgpa: 9.1, grad_year: '2024', student_status: 'active' },
  { student_id: 'stu_ref_003', full_name: 'ROHITH REDDY', dept_name: 'MECHANICAL ENGINEERING', degree: 'BTECH', issue_date: '2023-06-10', credential_type: 'DEGREE_CERTIFICATE', cgpa: 7.8, grad_year: '2023', student_status: 'active' },
  { student_id: 'stu_ref_004', full_name: 'ANANYA PATEL', dept_name: 'INFORMATION TECHNOLOGY', degree: 'BTECH', issue_date: '2024-05-15', credential_type: 'DEGREE_CERTIFICATE', cgpa: 8.5, grad_year: '2024', student_status: 'active' },
  { student_id: 'stu_ref_005', full_name: 'SIVA KRISHNA MURTHY', dept_name: 'ELECTRICAL AND ELECTRONICS ENGINEERING', degree: 'BTECH', issue_date: '2024-05-15', credential_type: 'DEGREE_CERTIFICATE', cgpa: 8.2, grad_year: '2024', student_status: 'active' },
  { student_id: 'stu_ref_006', full_name: 'DIVYA LAKSHMI', dept_name: 'CIVIL ENGINEERING', degree: 'BTECH', issue_date: '2023-06-10', credential_type: 'DEGREE_CERTIFICATE', cgpa: 7.5, grad_year: '2023', student_status: 'active' },
  { student_id: 'stu_ref_007', full_name: 'ARAVIND KUMAR', dept_name: 'COMPUTER SCIENCE AND ENGINEERING', degree: 'MTECH', issue_date: '2024-05-20', credential_type: 'DEGREE_CERTIFICATE', cgpa: 8.7, grad_year: '2024', student_status: 'active' },
  { student_id: 'stu_ref_008', full_name: 'NAVYA SREE', dept_name: 'COMPUTER SCIENCE AND ENGINEERING', degree: 'BTECH', issue_date: '2025-05-20', credential_type: 'DEGREE_CERTIFICATE', cgpa: 9.3, grad_year: '2025', student_status: 'active' },
  { student_id: 'stu_ref_009', full_name: 'VENKAT RAMANA', dept_name: 'CHEMICAL ENGINEERING', degree: 'BTECH', issue_date: '2022-06-01', credential_type: 'DEGREE_CERTIFICATE', cgpa: 6.9, grad_year: '2022', student_status: 'inactive' },
  { student_id: 'stu_ref_010', full_name: 'KEERTHI VARMA', dept_name: 'ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING', degree: 'BTECH', issue_date: '2025-05-20', credential_type: 'DEGREE_CERTIFICATE', cgpa: 9.0, grad_year: '2025', student_status: 'active' },
];

const STUDENTS_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS erp;

CREATE TABLE IF NOT EXISTS erp.students (
  college_id TEXT NOT NULL REFERENCES public.colleges(id),
  student_id TEXT NOT NULL,
  full_name TEXT,
  dept_name TEXT,
  degree TEXT,
  issue_date TEXT,
  credential_type TEXT,
  cgpa NUMERIC,
  grad_year TEXT,
  student_status TEXT,
  PRIMARY KEY (college_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_students_college_id ON erp.students(college_id);
CREATE INDEX IF NOT EXISTS idx_students_lookup ON erp.students(college_id, student_id);
`;

function pgConfig() {
  return {
    host: process.env.AUTHENX_PG_HOST || 'localhost',
    port: Number(process.env.AUTHENX_PG_PORT || 5432),
    user: process.env.AUTHENX_PG_USER || 'postgres',
    password: process.env.AUTHENX_PG_PASSWORD || '',
    database: process.env.AUTHENX_PG_DATABASE || 'postgres',
    connectionTimeoutMillis: 5000,
  };
}

async function withClient(fn) {
  const client = new Client(pgConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureStudentsSchema(client) {
  const statements = STUDENTS_SCHEMA_SQL.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await client.query(statement);
  }

  const legacyTable = await client.query("SELECT to_regclass('public.students') AS rel");
  if (legacyTable.rows[0]?.rel) {
    await client.query(
      `INSERT INTO erp.students (college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status)
       SELECT college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status
       FROM public.students
       ON CONFLICT (college_id, student_id) DO NOTHING`
    );
  }
}

async function seedDefaultStudentsForCollege(college_id, students = DEFAULT_STUDENTS) {
  return withClient(async (client) => {
    await ensureStudentsSchema(client);

    let seeded = 0;
    for (const student of students) {
      const result = await client.query(
        `INSERT INTO erp.students (college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (college_id, student_id) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           dept_name = EXCLUDED.dept_name,
           degree = EXCLUDED.degree,
           issue_date = EXCLUDED.issue_date,
           credential_type = EXCLUDED.credential_type,
           cgpa = EXCLUDED.cgpa,
           grad_year = EXCLUDED.grad_year,
           student_status = EXCLUDED.student_status`,
        [
          college_id,
          student.student_id,
          student.full_name,
          student.dept_name,
          student.degree || 'BTECH',
          student.issue_date || new Date().toISOString().split('T')[0],
          student.credential_type || 'DEGREE_CERTIFICATE',
          student.cgpa,
          student.grad_year,
          student.student_status,
        ]
      );
      if (result.rowCount > 0) seeded++;
    }

    console.log(`[students] seeded ${students.length} default students for college_id=${college_id}`);
    return { total: students.length, seeded };
  });
}

async function lookupStudent(college_id, student_ref_token) {
  if (!college_id) {
    throw new Error('college_id is required for central student lookup');
  }

  return withClient(async (client) => {
    await ensureStudentsSchema(client);
    console.log(`[students] lookup via postgres.erp.students college_id=${college_id} student_id=${student_ref_token}`);
    const result = await client.query(
      `SELECT college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status
       FROM erp.students
       WHERE college_id = $1 AND student_id = $2`,
      [college_id, student_ref_token]
    );

    if (!result.rows.length) {
      console.log(`[students] miss for college_id=${college_id} student_id=${student_ref_token}`);
      return null;
    }

    console.log(`[students] hit for college_id=${college_id} student_id=${student_ref_token}`);
    return result.rows[0];
  });
}

module.exports = {
  DEFAULT_STUDENTS,
  STUDENTS_SCHEMA_SQL,
  ensureStudentsSchema,
  seedDefaultStudentsForCollege,
  lookupStudent,
};