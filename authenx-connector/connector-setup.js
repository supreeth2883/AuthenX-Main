'use strict';
/**
 * AuthenX Connector Setup Script
 * Run once to configure the IIT Bombay real connector.
 *
 * What this does:
 * 1. Reads AuthenX SQLite DB — gets IIT Bombay's UUID
 * 2. Generates a new Ed25519 key pair for the connector
 * 3. Updates AuthenX DB: IIT Bombay public_key_hex + connector_url
 * 4. Re-signs stu_ref_001 token with new key
 * 5. Creates connector.db with mock student data
 * 6. Writes .env for the connector
 * 7. Writes connector_key.json to authenx-node (for mock connector fallback)
 *
 * Usage:  node connector-setup.js [authenx-node-path]
 */

const { DatabaseSync } = require('node:sqlite');
const crypto           = require('node:crypto');
const fs               = require('node:fs');
const path             = require('node:path');

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONNECTOR_DIR  = __dirname;
const AUTHENX_DIR    = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(CONNECTOR_DIR, '..', 'authenx-node');
const AUTHENX_DB     = path.join(AUTHENX_DIR, 'authenx.db');
// Store connector.db in /sessions working dir (mnt may not allow new SQLite files)
const SESSIONS_DIR   = process.env.SESSIONS_DIR || CONNECTOR_DIR;
const CONNECTOR_DB   = path.join(SESSIONS_DIR, 'connector.db');
const CONNECTOR_ENV  = path.join(CONNECTOR_DIR, '.env');
const CONNECTOR_KEY  = path.join(AUTHENX_DIR, 'connector_key.json');

console.log('\n AuthenX Connector Setup');
console.log('═══════════════════════════════════════');
console.log(`  AuthenX DB  : ${AUTHENX_DB}`);
console.log(`  Connector   : ${CONNECTOR_DIR}`);
console.log('');

// ─── Check AuthenX DB exists ──────────────────────────────────────────────────
if (!fs.existsSync(AUTHENX_DB)) {
  console.error(`ERROR: AuthenX database not found at ${AUTHENX_DB}`);
  console.error('Start the AuthenX server first so it can seed the database:');
  console.error('  cd authenx-node && node src/server.js');
  process.exit(1);
}

// ─── Open AuthenX DB ──────────────────────────────────────────────────────────
const authenxDb = new DatabaseSync(AUTHENX_DB);

// ─── Get IIT Bombay UUID ──────────────────────────────────────────────────────
const iitb = authenxDb.prepare("SELECT * FROM colleges WHERE short_code = 'IITB'").get();
if (!iitb) {
  console.error("ERROR: IIT Bombay not found in AuthenX DB. Run server first to seed.");
  process.exit(1);
}
console.log(`✓ Found IIT Bombay — UUID: ${iitb.id}`);

// ─── Generate Ed25519 key pair ────────────────────────────────────────────────
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privRaw       = privateKey.export({ type: 'pkcs8', format: 'der' });
const privateKeyHex = privRaw.slice(-32).toString('hex');
const pubRaw        = publicKey.export({ type: 'spki', format: 'der' });
const publicKeyHex  = pubRaw.slice(-32).toString('hex');

console.log(`✓ Generated Ed25519 key pair`);
console.log(`  Public  : ${publicKeyHex.slice(0, 32)}...`);

// ─── Crypto helpers (matches server's crypto/index.js exactly) ───────────────
function signEd25519(message, privKeyHex) {
  const seed   = Buffer.from(privKeyHex, 'hex');
  const header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der    = Buffer.concat([header, seed]);
  const pk     = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message, 'utf8'), pk).toString('base64');
}

function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function buildCanonicalJson(fields) {
  const ordered = {
    schema_version:    String(fields.schema_version    || '1.0').trim(),
    issuer_id:         String(fields.issuer_id         || '').trim(),
    student_ref_token: String(fields.student_ref_token || '').trim(),
    name:              String(fields.name              || '').trim().toUpperCase(),
    degree:            String(fields.degree            || '').trim().toUpperCase(),
    branch:            String(fields.branch            || '').trim().toUpperCase(),
    credential_type:   String(fields.credential_type   || '').trim().toUpperCase(),
    cgpa:              String(fields.cgpa              || '').trim(),
    graduation_year:   String(fields.graduation_year   || '').trim(),
    issue_date:        String(fields.issue_date        || '').trim(),
  };
  return JSON.stringify(ordered, null, 0);
}

// ─── Update all colleges to use new public key ────────────────────────────────
// We use ONE key for the connector; mock connector will also use this key.
// This ensures all verifications work after setup.
authenxDb.exec('BEGIN');
try {
  // Update ALL colleges to use the new public key
  authenxDb.prepare('UPDATE colleges SET public_key_hex = ?').run(publicKeyHex);
  console.log(`✓ Updated all colleges' public_key_hex`);

  // Set IIT Bombay to use the real connector
  authenxDb.prepare("UPDATE colleges SET connector_url = ? WHERE short_code = 'IITB'").run('http://localhost:9000');
  console.log(`✓ Set IIT Bombay connector_url → http://localhost:9000`);

  // Keep NITC and BITS as mock
  authenxDb.prepare("UPDATE colleges SET connector_url = 'mock' WHERE short_code != 'IITB'").run();
  console.log(`✓ NITC + BITS remain on mock connector`);

  authenxDb.exec('COMMIT');
} catch (err) {
  authenxDb.exec('ROLLBACK');
  console.error('ERROR updating colleges:', err.message);
  process.exit(1);
}

// ─── Re-sign all active tokens with new key ────────────────────────────────────
const tokens = authenxDb.prepare("SELECT * FROM verification_tokens WHERE status = 'active'").all();
authenxDb.exec('BEGIN');
try {
  for (const token of tokens) {
    // Get the college for this token
    const college = authenxDb.prepare('SELECT * FROM colleges WHERE id = ?').get(token.college_id);
    if (!college) continue;

    // The canonical_hash is already computed correctly (it's deterministic and doesn't
    // depend on the private key). We only need to re-sign the hash with the new key.
    const newSig = signEd25519(token.canonical_hash, privateKeyHex);
    authenxDb.prepare('UPDATE verification_tokens SET issuance_signature = ? WHERE id = ?')
      .run(newSig, token.id);
  }
  authenxDb.exec('COMMIT');
  console.log(`✓ Re-signed ${tokens.length} active token(s) with new key`);
} catch (err) {
  authenxDb.exec('ROLLBACK');
  console.error('ERROR re-signing tokens:', err.message);
  process.exit(1);
}

// ─── Create connector.db (SQLite mock of college student records) ─────────────
if (fs.existsSync(CONNECTOR_DB)) {
  fs.unlinkSync(CONNECTOR_DB);
  console.log(`✓ Removed old connector.db`);
}

const connDb = new DatabaseSync(CONNECTOR_DB);
connDb.exec(`
  CREATE TABLE IF NOT EXISTS students (
    student_ref_token  TEXT PRIMARY KEY,
    college_id         INTEGER NOT NULL,
    name               TEXT NOT NULL,
    degree             TEXT NOT NULL,
    branch             TEXT NOT NULL,
    cgpa               REAL NOT NULL,
    graduation_year    INTEGER NOT NULL,
    issue_date         TEXT NOT NULL,
    status             TEXT DEFAULT 'active',
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now'))
  );
`);

// IIT Bombay students (stu_ref_001, stu_ref_004, stu_ref_007, stu_ref_010)
const iitbStudents = [
  ['stu_ref_001', 1, 'SUPREETH K',    'BTECH', 'COMPUTER SCIENCE',          8.9, 2024, '2024-06-15', 'active'],
  ['stu_ref_004', 1, 'ANANYA PATEL',  'BTECH', 'ELECTRICAL ENGINEERING',    9.3, 2024, '2024-06-15', 'active'],
  ['stu_ref_007', 1, 'VIKRAM SINGH',  'MTECH', 'COMPUTER SCIENCE',          8.7, 2024, '2024-06-15', 'alumni'],
  ['stu_ref_010', 1, 'PRIYA DESAI',   'BTECH', 'MECHANICAL ENGINEERING',    8.2, 2023, '2023-06-15', 'alumni'],
];

const insertStmt = connDb.prepare(`
  INSERT INTO students (student_ref_token, college_id, name, degree, branch, cgpa, graduation_year, issue_date, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const s of iitbStudents) insertStmt.run(...s);

console.log(`✓ Created connector.db with ${iitbStudents.length} IIT Bombay students`);

// ─── Write connector .env ─────────────────────────────────────────────────────
const envContent = `# AuthenX Connector — IIT Bombay
# Generated by connector-setup.js on ${new Date().toISOString()}
# DO NOT commit this file — contains private key

COLLEGE_ID=${iitb.id}
COLLEGE_NAME=IIT Bombay
CONNECTOR_PRIVATE_KEY_HEX=${privateKeyHex}
PORT=9000
DB_PATH=${CONNECTOR_DB}
`;
fs.writeFileSync(CONNECTOR_ENV, envContent);
console.log(`✓ Wrote .env (private key + college UUID)`);

// ─── Write connector_key.json to authenx-node (for mock connector + server) ──
const keyData = { privateKeyHex, publicKeyHex, college: 'all', generated: new Date().toISOString() };
fs.writeFileSync(CONNECTOR_KEY, JSON.stringify(keyData, null, 2));
console.log(`✓ Wrote connector_key.json to authenx-node/`);

// ─── Verify setup by doing a test canonical hash check ───────────────────────
const testToken = authenxDb.prepare("SELECT * FROM verification_tokens WHERE student_ref_token = 'stu_ref_001'").get();
if (testToken) {
  const testCollege = authenxDb.prepare('SELECT * FROM colleges WHERE id = ?').get(testToken.college_id);
  const testCanonical = buildCanonicalJson({
    schema_version: '1.0',
    issuer_id: testCollege.id,
    student_ref_token: 'stu_ref_001',
    name: 'SUPREETH K',
    degree: 'BTECH',
    branch: 'COMPUTER SCIENCE',
    credential_type: 'DEGREE_CERTIFICATE',
    cgpa: '8.9',
    graduation_year: '2024',
    issue_date: '2024-06-15',
  });
  const testHash = sha256(testCanonical);

  if (testHash === testToken.canonical_hash) {
    console.log(`✓ Canonical hash verification — PASS (stu_ref_001)`);
  } else {
    console.warn(`⚠  Canonical hash mismatch for stu_ref_001`);
    console.warn(`   Expected : ${testToken.canonical_hash}`);
    console.warn(`   Got      : ${testHash}`);
  }

  // Verify the new issuance signature
  const updatedToken = authenxDb.prepare("SELECT * FROM verification_tokens WHERE student_ref_token = 'stu_ref_001'").get();
  const pubBytes = Buffer.from(publicKeyHex, 'hex');
  const spkiHdr  = Buffer.from('302a300506032b6570032100', 'hex');
  const pubKey   = crypto.createPublicKey({ key: Buffer.concat([spkiHdr, pubBytes]), format: 'der', type: 'spki' });
  const sigBuf   = Buffer.from(updatedToken.issuance_signature, 'base64');
  const isValid  = crypto.verify(null, Buffer.from(updatedToken.canonical_hash, 'utf8'), pubKey, sigBuf);
  console.log(`✓ Issuance signature re-sign — ${isValid ? 'PASS' : 'FAIL'} (stu_ref_001)`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════');
console.log('  Setup complete! Next steps:');
console.log('');
console.log('  1. Restart the AuthenX server:');
console.log('     cd authenx-node && node src/server.js');
console.log('');
console.log('  2. Start the connector:');
console.log('     cd authenx-connector && node connector.js');
console.log('');
console.log('  3. Test it:');
console.log('     curl http://localhost:9000/health');
console.log('     curl -X POST http://localhost:9000/verify \\');
console.log('       -H "Content-Type: application/json" \\');
console.log('       -d \'{"student_ref_token":"stu_ref_001","nonce":"test123"}\'');
console.log('═══════════════════════════════════════\n');
