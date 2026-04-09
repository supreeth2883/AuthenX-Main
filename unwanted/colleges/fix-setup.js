'use strict';
/**
 * Fix and setup all college connectors with correct paths and mock databases.
 * Run this from the colleges directory: node fix-setup.js
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const COLLEGES_DIR = __dirname;
const registry = JSON.parse(fs.readFileSync(path.join(COLLEGES_DIR, 'registry.json'), 'utf8'));

// Mock student data for each college (3 students per college)
const mockStudents = {
  'IITB': [
    { stu_ref: 'stu_iitb_001', name: 'RAHUL SHARMA', degree: 'BTECH', branch: 'COMPUTER SCIENCE', cgpa: 9.2, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_iitb_002', name: 'PRIYA PATEL', degree: 'MTECH', branch: 'ELECTRICAL ENGINEERING', cgpa: 8.8, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_iitb_003', name: 'AMIT KUMAR', degree: 'BTECH', branch: 'MECHANICAL ENGINEERING', cgpa: 8.5, grad_year: 2023, status: 'Alumni' },
  ],
  'IITD': [
    { stu_ref: 'stu_iitd_001', name: 'NEHA GUPTA', degree: 'BTECH', branch: 'CIVIL ENGINEERING', cgpa: 9.0, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_iitd_002', name: 'VIKRAM SINGH', degree: 'PHD', branch: 'PHYSICS', cgpa: 9.5, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_iitd_003', name: 'ANJALI DEVI', degree: 'BTECH', branch: 'CHEMICAL ENGINEERING', cgpa: 8.3, grad_year: 2023, status: 'Alumni' },
  ],
  'IITM': [
    { stu_ref: 'stu_iitm_001', name: 'KARTHIK RAO', degree: 'BTECH', branch: 'COMPUTER SCIENCE', cgpa: 9.4, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_iitm_002', name: 'LAKSHMI NAIR', degree: 'MTECH', branch: 'DATA SCIENCE', cgpa: 9.1, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_iitm_003', name: 'ARUN PRASAD', degree: 'BTECH', branch: 'AEROSPACE ENGINEERING', cgpa: 8.7, grad_year: 2023, status: 'Alumni' },
  ],
  'NITT': [
    { stu_ref: 'stu_nitt_001', name: 'SURESH BABU', degree: 'BTECH', branch: 'ELECTRONICS', cgpa: 8.9, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_nitt_002', name: 'MEENA KUMARI', degree: 'MTECH', branch: 'VLSI DESIGN', cgpa: 8.6, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_nitt_003', name: 'RAJESH PILLAI', degree: 'BTECH', branch: 'INSTRUMENTATION', cgpa: 8.2, grad_year: 2023, status: 'Alumni' },
  ],
  'NITW': [
    { stu_ref: 'stu_nitw_001', name: 'SRINIVAS REDDY', degree: 'BTECH', branch: 'COMPUTER SCIENCE', cgpa: 9.0, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_nitw_002', name: 'BHAVANI PRASAD', degree: 'MTECH', branch: 'ARTIFICIAL INTELLIGENCE', cgpa: 8.8, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_nitw_003', name: 'VENKAT RAO', degree: 'BTECH', branch: 'BIOTECHNOLOGY', cgpa: 8.4, grad_year: 2023, status: 'Alumni' },
  ],
  'BITS': [
    { stu_ref: 'stu_bits_001', name: 'ARJUN MEHTA', degree: 'BE', branch: 'COMPUTER SCIENCE', cgpa: 9.3, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_bits_002', name: 'DIVYA KAPOOR', degree: 'MSC', branch: 'MATHEMATICS', cgpa: 9.0, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_bits_003', name: 'ROHAN JOSHI', degree: 'BE', branch: 'ELECTRONICS', cgpa: 8.6, grad_year: 2023, status: 'Alumni' },
  ],
  'VIT': [
    { stu_ref: 'stu_vit_001', name: 'PRAKASH IYER', degree: 'BTECH', branch: 'INFORMATION TECHNOLOGY', cgpa: 8.7, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_vit_002', name: 'SWATHI BALAJI', degree: 'MTECH', branch: 'SOFTWARE ENGINEERING', cgpa: 8.9, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_vit_003', name: 'GANESH MURTHY', degree: 'BTECH', branch: 'COMPUTER SCIENCE', cgpa: 8.1, grad_year: 2023, status: 'Alumni' },
  ],
  'SRM': [
    { stu_ref: 'stu_srm_001', name: 'ASHOK KUMAR', degree: 'BTECH', branch: 'COMPUTER SCIENCE', cgpa: 8.5, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_srm_002', name: 'KAVITHA RAMAN', degree: 'MTECH', branch: 'EMBEDDED SYSTEMS', cgpa: 8.7, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_srm_003', name: 'MOHAN DAS', degree: 'BTECH', branch: 'MECHANICAL ENGINEERING', cgpa: 8.0, grad_year: 2023, status: 'Alumni' },
  ],
  'ANNA': [
    { stu_ref: 'stu_anna_001', name: 'SENTHIL MURUGAN', degree: 'BE', branch: 'ELECTRONICS', cgpa: 8.8, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_anna_002', name: 'VANI SRINIVASAN', degree: 'ME', branch: 'COMMUNICATION SYSTEMS', cgpa: 9.0, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_anna_003', name: 'BALA KRISHNAN', degree: 'BE', branch: 'CIVIL ENGINEERING', cgpa: 8.3, grad_year: 2023, status: 'Alumni' },
  ],
  'DU': [
    { stu_ref: 'stu_du_001', name: 'ADITYA KAPOOR', degree: 'BCOM', branch: 'COMMERCE', cgpa: 8.6, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_du_002', name: 'SNEHA MALHOTRA', degree: 'MA', branch: 'ECONOMICS', cgpa: 8.9, grad_year: 2024, status: 'Active' },
    { stu_ref: 'stu_du_003', name: 'RAHUL VERMA', degree: 'BSC', branch: 'PHYSICS', cgpa: 8.2, grad_year: 2023, status: 'Alumni' },
  ],
};

console.log('\n Setting up all college connectors...\n');

for (const college of registry) {
  const collegeDir = path.join(COLLEGES_DIR, college.short_code);
  const envFile = path.join(collegeDir, '.env');
  const dbFile = path.join(collegeDir, 'erp.db');
  const configFile = path.join(collegeDir, 'config.json');

  console.log(`[${college.short_code}] Setting up ${college.name}...`);

  // Read existing .env to get private key
  let privateKeyHex = '';
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf8');
    const match = envContent.match(/CONNECTOR_PRIVATE_KEY_HEX=([a-f0-9]+)/);
    if (match) privateKeyHex = match[1];
  }

  // Write fixed .env file with correct paths
  const envContent = `COLLEGE_ID=${college.id}
COLLEGE_NAME="${college.name}"
PORT=${college.port}
DB_PATH=${dbFile.replace(/\\/g, '/')}
CONFIG_PATH=${configFile.replace(/\\/g, '/')}
CONNECTOR_PRIVATE_KEY_HEX=${privateKeyHex}
SHARED_SECRET=${college.shared_secret}
HSM_PORT=9099
`;
  fs.writeFileSync(envFile, envContent);
  console.log(`  .env updated with correct paths`);

  // Create SQLite mock database
  if (fs.existsSync(dbFile)) {
    fs.unlinkSync(dbFile);
  }

  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE student_records (
      stu_ref TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      degree TEXT NOT NULL,
      branch TEXT NOT NULL,
      cgpa REAL NOT NULL,
      grad_year INTEGER NOT NULL,
      issue_dt TEXT NOT NULL,
      status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const students = mockStudents[college.short_code] || [];
  const stmt = db.prepare(`
    INSERT INTO student_records (stu_ref, name, degree, branch, cgpa, grad_year, issue_dt, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of students) {
    stmt.run(s.stu_ref, s.name, s.degree, s.branch, s.cgpa, s.grad_year, `${s.grad_year}-06-15`, s.status);
  }

  console.log(`  erp.db created with ${students.length} mock students`);
}

console.log('\nAll colleges setup complete!\n');
console.log('Next steps:');
console.log('  1. Start HSM:  cd authenx-hsm && node server.js');
console.log('  2. Start connectors:  node start-all-connectors.js');
console.log('  3. Start server:  cd authenx-node/src && node server.js');
console.log('');
