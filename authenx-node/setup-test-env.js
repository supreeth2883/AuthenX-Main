'use strict';
/**
 * AuthenX — Test Environment Setup Script
 *
 * Prepares a clean test environment for the full college onboarding and
 * credential issuance flow using IIT Bombay (IITB) as the test college.
 *
 * What this script does:
 *  1. Opens authenx.db and ensures schema tables exist
 *  2. Syncs all 10 colleges from colleges/registry.json (fixes IDs, public keys, secrets)
 *  3. Removes all verification_tokens (seeded demo data)
 *  4. Resets the IITB college_admin account (iitb@authenx.in / College@123, no forced PW change)
 *  5. Saves connector config for IITB: onboarding_completed=1, sqlite, http://localhost:9001
 *  6. Creates authenx-connector/connector.db with 10 mock IITB students
 *
 * Run from authenx-node/:
 *   node setup-test-env.js
 *
 * Then start services in order:
 *   1. cd authenx-hsm    && node server.js
 *   2. cd authenx-node   && node src/server.js
 *   3. cd authenx-connector && node connector.js
 *   4. Open ui/college/index.html
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ─── Paths ───────────────────────────────────────────────────────────────────
const ROOT           = path.join(__dirname, '..');
const DB_PATH        = path.join(__dirname, 'authenx.db');
const REGISTRY_PATH  = path.join(ROOT, 'colleges', 'registry.json');
const CONNECTOR_DB   = path.join(ROOT, 'authenx-connector', 'connector.db');

// ─── IITB constants (from registry.json) ────────────────────────────────────
const IITB_ID            = '992c65ba-11e1-4a56-b065-a365bdb4e129';
const IITB_CONNECTOR_URL = 'http://localhost:9001';
const IITB_EMAIL         = 'iitb@authenx.in';
const IITB_PASSWORD      = 'College@123';

// ─── Password hashing (matches server's crypto/index.js) ─────────────────────
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

// ─── Schema excerpt — only tables we need to guarantee exist ─────────────────
const ENSURE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS colleges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_code TEXT NOT NULL UNIQUE,
    public_key_hex TEXT NOT NULL,
    connector_url TEXT NOT NULL,
    shared_secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('super_admin','college_admin','employer')),
    college_id TEXT REFERENCES colleges(id),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_password_change TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS verification_tokens (
    id TEXT PRIMARY KEY,
    college_id TEXT NOT NULL,
    student_ref_token TEXT NOT NULL,
    canonical_hash TEXT NOT NULL,
    issuance_signature TEXT NOT NULL,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    credential_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    revocation_reason TEXT,
    revoked_at TEXT,
    issued_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS college_connector_configs (
    college_id TEXT PRIMARY KEY REFERENCES colleges(id),
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    erp_type TEXT,
    connector_url TEXT,
    connector_config_json TEXT,
    field_mapping_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// ─── Connector config saved to DB (used by connector-config route) ────────────
const FIELD_MAPPING = {
  name:            { type: 'column', column: 'name' },
  degree:          { type: 'column', column: 'degree' },
  branch:          { type: 'column', column: 'branch' },
  cgpa:            { type: 'column', column: 'cgpa' },
  graduation_year: { type: 'column', column: 'graduation_year' },
  issue_date:      { type: 'column', column: 'issue_date' },
  credential_type: { type: 'direct', value: 'DEGREE_CERTIFICATE' },
  status: {
    type: 'map_values',
    column: 'status',
    active_values:   ['active', 'alumni'],
    inactive_values: ['withdrawn', 'deferred', 'suspended', 'expelled'],
  },
};

const CONNECTOR_CONFIG_JSON = {
  db_path:    CONNECTOR_DB.replace(/\\/g, '/'),
  table:      'students',
  ref_column: 'student_ref_token',
};

// ─── 10 mock IITB students ────────────────────────────────────────────────────
// ref tokens stu_ref_001..010 — issue.html has quick-fill for 001, 002, 004
const MOCK_STUDENTS = [
  { ref: 'stu_ref_001', name: 'SUPREETH K',         degree: 'BTECH', branch: 'COMPUTER SCIENCE AND ENGINEERING',   cgpa: '8.9', grad: '2024', issue: '2024-06-15', status: 'active' },
  { ref: 'stu_ref_002', name: 'PRIYA SHARMA',       degree: 'MTECH', branch: 'ELECTRONICS AND COMMUNICATION',      cgpa: '9.1', grad: '2024', issue: '2024-06-15', status: 'active' },
  { ref: 'stu_ref_003', name: 'RAHUL NAIR',         degree: 'BTECH', branch: 'MECHANICAL ENGINEERING',             cgpa: '7.8', grad: '2023', issue: '2023-06-15', status: 'alumni' },
  { ref: 'stu_ref_004', name: 'ANANYA PATEL',       degree: 'BTECH', branch: 'CIVIL ENGINEERING',                  cgpa: '8.4', grad: '2024', issue: '2024-06-15', status: 'active' },
  { ref: 'stu_ref_005', name: 'ARJUN MEHTA',        degree: 'BTECH', branch: 'ELECTRICAL ENGINEERING',             cgpa: '8.2', grad: '2024', issue: '2024-06-15', status: 'active' },
  { ref: 'stu_ref_006', name: 'DIVYA KRISHNAN',     degree: 'MTECH', branch: 'COMPUTER SCIENCE AND ENGINEERING',   cgpa: '9.4', grad: '2024', issue: '2024-06-20', status: 'active' },
  { ref: 'stu_ref_007', name: 'KARAN VERMA',        degree: 'BTECH', branch: 'AEROSPACE ENGINEERING',              cgpa: '8.7', grad: '2023', issue: '2023-06-15', status: 'alumni' },
  { ref: 'stu_ref_008', name: 'SNEHA IYER',         degree: 'BTECH', branch: 'CHEMICAL ENGINEERING',               cgpa: '8.0', grad: '2024', issue: '2024-06-15', status: 'active' },
  { ref: 'stu_ref_009', name: 'ROHIT GUPTA',        degree: 'PHD',   branch: 'COMPUTER SCIENCE AND ENGINEERING',   cgpa: '9.6', grad: '2024', issue: '2024-05-30', status: 'active' },
  { ref: 'stu_ref_010', name: 'MEERA SUBRAMANIAN',  degree: 'BTECH', branch: 'METALLURGICAL ENGINEERING',          cgpa: '7.5', grad: '2024', issue: '2024-06-15', status: 'active' },
];

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   AuthenX — Test Environment Setup          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── 1. Open main DB ────────────────────────────────────────────────────────
  if (!fs.existsSync(DB_PATH)) {
    console.error(`✗ authenx.db not found at ${DB_PATH}`);
    console.error('  Start the server once first to create the DB, then re-run this script.');
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(ENSURE_SCHEMA);
  console.log('✓ Opened authenx.db and ensured schema');

  // ── 2. Sync registry.json → colleges table ────────────────────────────────
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`✗ Registry not found at ${REGISTRY_PATH}`);
    process.exit(1);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  for (const r of registry) {
    if (!r?.id || !r?.short_code) continue;
    const existing = db.prepare('SELECT id FROM colleges WHERE short_code = ?').get(r.short_code);

    if (!existing) {
      db.prepare(`INSERT INTO colleges (id,name,short_code,public_key_hex,connector_url,shared_secret,active)
                  VALUES (?,?,?,?,?,?,1)`)
        .run(r.id, r.name, r.short_code, r.public_key_hex, r.connector_url, r.shared_secret);
    } else if (existing.id !== r.id) {
      // ID mismatch — update FK references first
      db.prepare('UPDATE users SET college_id = ? WHERE college_id = ?').run(r.id, existing.id);
      db.prepare('UPDATE verification_tokens SET college_id = ? WHERE college_id = ?').run(r.id, existing.id);
      try { db.prepare('UPDATE college_connector_configs SET college_id = ? WHERE college_id = ?').run(r.id, existing.id); } catch {}
      db.prepare(`UPDATE colleges SET id=?,name=?,public_key_hex=?,connector_url=?,shared_secret=?,active=1 WHERE id=?`)
        .run(r.id, r.name, r.public_key_hex, r.connector_url, r.shared_secret, existing.id);
    } else {
      // Same ID — keep fields in sync
      db.prepare(`UPDATE colleges SET name=?,public_key_hex=?,connector_url=?,shared_secret=?,active=1 WHERE id=?`)
        .run(r.name, r.public_key_hex, r.connector_url, r.shared_secret, r.id);
    }
  }
  console.log(`✓ Synced ${registry.length} colleges from registry.json`);

  // ── 3. Clean verification tokens ──────────────────────────────────────────
  // Delete verification_requests first (FK references verification_tokens)
  let revCount = 0;
  try { const r = db.prepare('DELETE FROM verification_requests').run(); revCount = r.changes; } catch {}
  const tokResult = db.prepare('DELETE FROM verification_tokens').run();
  console.log(`✓ Removed ${tokResult.changes} verification token(s) and ${revCount} verification request(s)`);

  // Also clear revocation_events (references tokens that no longer exist)
  try { db.prepare('DELETE FROM revocation_events').run(); } catch {}

  // ── 4. Clear existing connector config for IITB (fresh onboarding state) ─
  try { db.prepare('DELETE FROM college_connector_configs WHERE college_id = ?').run(IITB_ID); } catch {}

  // ── 5. Fix IITB admin user ─────────────────────────────────────────────────
  const passwordHash = await hashPassword(IITB_PASSWORD);
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(IITB_EMAIL);

  if (existing) {
    db.prepare(`UPDATE users SET
      college_id = ?,
      password_hash = ?,
      must_change_password = 0,
      role = 'college_admin'
      WHERE email = ?`)
      .run(IITB_ID, passwordHash, IITB_EMAIL);
    console.log(`✓ Updated user: ${IITB_EMAIL} → college_id=${IITB_ID}, must_change_password=0`);
  } else {
    const userId = crypto.randomUUID();
    db.prepare(`INSERT INTO users (id,email,password_hash,role,college_id,must_change_password)
                VALUES (?,?,?,'college_admin',?,0)`)
      .run(userId, IITB_EMAIL, passwordHash, IITB_ID);
    console.log(`✓ Created user: ${IITB_EMAIL}`);
  }

  // ── 6. Save connector config (onboarding complete) ────────────────────────
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO college_connector_configs
    (college_id, onboarding_completed, erp_type, connector_url, connector_config_json, field_mapping_json, updated_at)
    VALUES (?, 1, 'sqlite', ?, ?, ?, ?)
    ON CONFLICT(college_id) DO UPDATE SET
      onboarding_completed=1,
      erp_type='sqlite',
      connector_url=excluded.connector_url,
      connector_config_json=excluded.connector_config_json,
      field_mapping_json=excluded.field_mapping_json,
      updated_at=excluded.updated_at`)
    .run(IITB_ID, IITB_CONNECTOR_URL, JSON.stringify(CONNECTOR_CONFIG_JSON), JSON.stringify(FIELD_MAPPING), now);

  // Also keep colleges.connector_url aligned
  db.prepare('UPDATE colleges SET connector_url = ? WHERE id = ?').run(IITB_CONNECTOR_URL, IITB_ID);
  console.log(`✓ Connector config saved: onboarding_completed=1, sqlite, ${IITB_CONNECTOR_URL}`);

  db.exec('PRAGMA foreign_keys=ON');

  // ── 7. Create connector.db with 10 mock students ──────────────────────────
  if (fs.existsSync(CONNECTOR_DB)) {
    fs.unlinkSync(CONNECTOR_DB);
    // Remove WAL/SHM sidecar files if present
    try { fs.unlinkSync(CONNECTOR_DB + '-wal'); } catch {}
    try { fs.unlinkSync(CONNECTOR_DB + '-shm'); } catch {}
    console.log('✓ Removed old connector.db');
  }

  const cdb = new DatabaseSync(CONNECTOR_DB);
  cdb.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      student_ref_token TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      degree           TEXT NOT NULL,
      branch           TEXT NOT NULL,
      cgpa             TEXT NOT NULL,
      graduation_year  TEXT NOT NULL,
      issue_date       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active'
    );
  `);

  const insertStmt = cdb.prepare(`
    INSERT INTO students
      (student_ref_token, name, degree, branch, cgpa, graduation_year, issue_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of MOCK_STUDENTS) {
    insertStmt.run(s.ref, s.name, s.degree, s.branch, s.cgpa, s.grad, s.issue, s.status);
  }

  console.log(`✓ Created connector.db with ${MOCK_STUDENTS.length} students at:`);
  console.log(`    ${CONNECTOR_DB}`);

  // ── 8. Verify HSM key exists ───────────────────────────────────────────────
  const hsmKeyPath = path.join(ROOT, 'authenx-hsm', 'keys', `${IITB_ID}.json`);
  if (fs.existsSync(hsmKeyPath)) {
    const keyData = JSON.parse(fs.readFileSync(hsmKeyPath, 'utf8'));
    console.log(`✓ HSM key found for IITB (public: ${keyData.public_key_hex?.slice(0, 16)}…)`);
  } else {
    console.warn(`⚠  HSM key NOT found at ${hsmKeyPath}`);
    console.warn('  The HSM will auto-generate a key on first sign, but it may not match the registry public key.');
    console.warn('  Run: cd authenx-hsm && node server.js   (to generate the key on startup)');
  }

  // ── 9. Summary ─────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║          Test Environment Ready              ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  College      : IIT Bombay (IITB)           ║');
  console.log(`║  College ID   : ${IITB_ID.slice(0, 28)}… ║`);
  console.log('║  Login        : iitb@authenx.in             ║');
  console.log('║  Password     : College@123                  ║');
  console.log('║  Connector    : http://localhost:9001        ║');
  console.log('║  Onboarding   : COMPLETE (skips wizard)      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Student refs : stu_ref_001 → stu_ref_010   ║');
  console.log('║  Quick-test   : stu_ref_001 (SUPREETH K)    ║');
  console.log('║               : stu_ref_002 (PRIYA SHARMA)  ║');
  console.log('║               : stu_ref_004 (ANANYA PATEL)  ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Start order:                                ║');
  console.log('║  1. cd authenx-hsm && node server.js        ║');
  console.log('║  2. cd authenx-node && node src/server.js   ║');
  console.log('║  3. cd authenx-connector && node connector.js║');
  console.log('║  4. Open ui/college/index.html              ║');
  console.log('╚══════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('\n✗ Setup failed:', err.message);
  if (err.message?.includes('database is locked')) {
    console.error('  The DB is locked — stop the running server first, then re-run this script.');
  }
  process.exit(1);
});
