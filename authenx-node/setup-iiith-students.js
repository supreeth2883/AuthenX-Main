'use strict';

const { Client } = require('pg');

const collegeId = 'e32ced79-04f4-4e0b-925b-0435a33a6edf';

const createTableSql = `
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
`;

const insertSql = `
INSERT INTO erp.students (college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status)
VALUES
  ('${collegeId}', 'stu_ref_001', 'SUPREETH K', 'COMPUTER SCIENCE AND ENGINEERING', 'BTECH', '2024-05-15', 'DEGREE_CERTIFICATE', 8.9, '2024', 'active'),
  ('${collegeId}', 'stu_ref_002', 'PRIYA SHARMA', 'ELECTRONICS AND COMMUNICATION ENGINEERING', 'BTECH', '2024-05-15', 'DEGREE_CERTIFICATE', 9.1, '2024', 'active'),
  ('${collegeId}', 'stu_ref_003', 'ROHITH REDDY', 'MECHANICAL ENGINEERING', 'BTECH', '2023-06-10', 'DEGREE_CERTIFICATE', 7.8, '2023', 'active'),
  ('${collegeId}', 'stu_ref_004', 'ANANYA PATEL', 'INFORMATION TECHNOLOGY', 'BTECH', '2024-05-15', 'DEGREE_CERTIFICATE', 8.5, '2024', 'active'),
  ('${collegeId}', 'stu_ref_005', 'SIVA KRISHNA MURTHY', 'ELECTRICAL AND ELECTRONICS ENGINEERING', 'BTECH', '2024-05-15', 'DEGREE_CERTIFICATE', 8.2, '2024', 'active'),
  ('${collegeId}', 'stu_ref_006', 'DIVYA LAKSHMI', 'CIVIL ENGINEERING', 'BTECH', '2023-06-10', 'DEGREE_CERTIFICATE', 7.5, '2023', 'active'),
  ('${collegeId}', 'stu_ref_007', 'ARAVIND KUMAR', 'COMPUTER SCIENCE AND ENGINEERING', 'MTECH', '2024-05-20', 'DEGREE_CERTIFICATE', 8.7, '2024', 'active'),
  ('${collegeId}', 'stu_ref_008', 'NAVYA SREE', 'COMPUTER SCIENCE AND ENGINEERING', 'BTECH', '2025-05-20', 'DEGREE_CERTIFICATE', 9.3, '2025', 'active'),
  ('${collegeId}', 'stu_ref_009', 'VENKAT RAMANA', 'CHEMICAL ENGINEERING', 'BTECH', '2022-06-01', 'DEGREE_CERTIFICATE', 6.9, '2022', 'inactive'),
  ('${collegeId}', 'stu_ref_010', 'KEERTHI VARMA', 'ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING', 'BTECH', '2025-05-20', 'DEGREE_CERTIFICATE', 9.0, '2025', 'active')
ON CONFLICT (college_id, student_id) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  dept_name = EXCLUDED.dept_name,
  degree = EXCLUDED.degree,
  issue_date = EXCLUDED.issue_date,
  credential_type = EXCLUDED.credential_type,
  cgpa = EXCLUDED.cgpa,
  grad_year = EXCLUDED.grad_year,
  student_status = EXCLUDED.student_status;
`;

const verifySql = `
SELECT college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status
FROM erp.students
WHERE college_id = $1 AND student_id = 'stu_ref_007';
`;

const schemaSql = `
SELECT table_schema, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'erp' AND table_name = 'students'
ORDER BY ordinal_position;
`;

(async () => {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: process.env.AUTHENX_PG_USER || 'postgres',
    password: process.env.AUTHENX_PG_PASSWORD || '',
    database: process.env.AUTHENX_PG_DATABASE || 'postgres',
  });

  await client.connect();

  console.log('Executing SQL (create table):');
  console.log(createTableSql.trim());
  await client.query(createTableSql);

  console.log('\nExecuting SQL (upsert sample students):');
  console.log(insertSql.trim());
  await client.query(insertSql);

  console.log('\nExecuting SQL (verify rows):');
  console.log(verifySql.trim());
  const result = await client.query(verifySql, [collegeId]);

  console.log('\nExecuting SQL (verify schema):');
  console.log(schemaSql.trim());
  const schema = await client.query(schemaSql);

  console.log('\nStudents in central postgres.erp.students:');
  for (const row of result.rows) {
    console.log(`${row.college_id} | ${row.student_id} | ${row.full_name} | ${row.dept_name} | ${row.degree} | ${row.issue_date} | ${row.credential_type} | ${row.cgpa} | ${row.grad_year} | ${row.student_status}`);
  }

  console.log('\nerp.students table schema:');
  for (const col of schema.rows) {
    console.log(`${col.table_schema}.${col.column_name} | ${col.data_type}`);
  }

  await client.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
