'use strict';

/**
 * CVR ERP compatibility layer over the shared central ERP students table.
 * Student records live in postgres.erp.students and are scoped by
 * college_id + student_id.
 */

const { seedDefaultStudentsForCollege, lookupStudent: lookupCentralStudent } = require('../db/students.js');

const CVR_COLLEGE_ID = '35e8750a-9972-4cc2-8e20-a25bfe2d825b';
const CVR_SHORT_CODE = 'CVRH';

async function seed() {
  return seedDefaultStudentsForCollege(CVR_COLLEGE_ID);
}

async function lookupStudent(college_id, student_ref_token) {
  const row = await lookupCentralStudent(college_id || CVR_COLLEGE_ID, student_ref_token);
  if (!row) return null;

  return {
    student_ref_token: row.student_id,
    name: row.full_name,
    degree: row.degree,
    branch: row.dept_name,
    cgpa: String(row.cgpa),
    graduation_year: row.grad_year,
    issue_date: row.issue_date,
    status: row.student_status,
    credential_type: row.credential_type || 'DEGREE_CERTIFICATE',
    college_name: 'CVR College of Engineering',
    source: 'central_postgres_erp_students',
  };
}

module.exports = { CVR_COLLEGE_ID, CVR_SHORT_CODE, seed, lookupStudent };
