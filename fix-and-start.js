'use strict';
/**
 * AuthenX Fix & Start Script
 * Fixes the DB path mismatch between connector-setup and running server,
 * then starts both the AuthenX server and the IIT Bombay connector.
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawn } = require('node:child_process');

const SCRIPT_DIR      = __dirname;
const SERVER_DIR      = path.join(SCRIPT_DIR, 'authenx-node');
const CONNECTOR_DIR   = path.join(SCRIPT_DIR, 'authenx-connector');

// The server uses process.cwd()/authenx.db — we will run it from SERVER_DIR
const AUTHENX_DB      = path.join(SERVER_DIR, 'authenx.db');
const CONNECTOR_KEY   = path.join(SERVER_DIR, 'connector_key.json');
const CONNECTOR_ENV   = path.join(CONNECTOR_DIR, '.env');
const CONNECTOR_DB    = path.join(CONNECTOR_DIR, 'connector.db');

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║       AuthenX — Fix & Start Script                         ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ── Kill any existing servers ────────────────────────────────────────────────
console.log('  Killing existing server processes...');
try { execSync('pkill -9 -f "node src/server" 2>/dev/null || true', { stdio: 'inherit' }); } catch (_) {}
try { execSync('pkill -9 -f "node connector.js" 2>/dev/null || true', { stdio: 'inherit' }); } catch (_) {}
try { execSync('lsof -ti:3000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' }); } catch (_) {}
try { execSync('lsof -ti:9000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' }); } catch (_) {}

// Wait for ports to clear
execSync('sleep 1');
console.log('  ✓ Old processes cleared\n');

// ── Start the AuthenX server FIRST so it creates/seeds authenx.db ────────────
console.log('  Starting AuthenX Server (this will seed the DB)...');
// Run server from SERVER_DIR so it uses SERVER_DIR/authenx.db
const serverProc = spawn('node', ['src/server.js'], {
  cwd: SERVER_DIR,
  detached: true,
  stdio: ['ignore', fs.openSync(path.join(SCRIPT_DIR, 'server.log'), 'w'), fs.openSync(path.join(SCRIPT_DIR, 'server.log'), 'w')],
});
serverProc.unref();
console.log('  Waiting 4 seconds for server to start and seed DB...');
execSync('sleep 4');

// Verify server is up
try {
  execSync('curl -sf http://localhost:3000/health > /dev/null');
  console.log('  ✅ AuthenX Server is running on port 3000\n');
} catch (_) {
  console.error('  ❌ Server failed to start! Check server.log');
  process.exit(1);
}

// ── Now open the server's DB and re-key the connector ────────────────────────
console.log('  Re-keying connector to match server DB at:', AUTHENX_DB);
const db = new DatabaseSync(AUTHENX_DB);

// Get IIT Bombay
const iitb = db.prepare("SELECT * FROM colleges WHERE short_code = 'IITB'").get();
if (!iitb) { console.error('  ❌ IIT Bombay not found in DB!'); process.exit(1); }
console.log('  ✓ Found IIT Bombay — UUID:', iitb.id);

// Generate new Ed25519 key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privRaw      = privateKey.export({ type: 'pkcs8', format: 'der' });
const privateKeyHex = privRaw.slice(-32).toString('hex');
const pubRaw        = publicKey.export({ type: 'spki', format: 'der' });
const publicKeyHex  = pubRaw.slice(-32).toString('hex');
console.log('  ✓ Generated Ed25519 key pair');
console.log('    Public:', publicKeyHex.slice(0, 32) + '...');

// Helpers
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function signEd25519(msg, hexSeed) {
  const seed = Buffer.from(hexSeed, 'hex');
  const hdr  = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pk   = crypto.createPrivateKey({ key: Buffer.concat([hdr, seed]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(msg, 'utf8'), pk).toString('base64');
}
function buildCanonical(f) {
  return JSON.stringify({
    schema_version: String(f.schema_version || '1.0').trim(),
    issuer_id:      String(f.issuer_id || '').trim(),
    student_ref_token: String(f.student_ref_token || '').trim(),
    name:           String(f.name || '').trim().toUpperCase(),
    degree:         String(f.degree || '').trim().toUpperCase(),
    branch:         String(f.branch || '').trim().toUpperCase(),
    credential_type:String(f.credential_type || '').trim().toUpperCase(),
    cgpa:           String(f.cgpa || '').trim(),
    graduation_year:String(f.graduation_year || '').trim(),
    issue_date:     String(f.issue_date || '').trim(),
  }, null, 0);
}

// Update ALL colleges in the DB with the new public key
db.exec('BEGIN');
try {
  db.prepare('UPDATE colleges SET public_key_hex = ?').run(publicKeyHex);
  db.prepare("UPDATE colleges SET connector_url = ? WHERE short_code = 'IITB'").run('http://localhost:9000');
  db.prepare("UPDATE colleges SET connector_url = 'mock' WHERE short_code != 'IITB'").run();

  // Re-sign all active tokens
  const tokens = db.prepare("SELECT * FROM verification_tokens WHERE status = 'active'").all();
  for (const token of tokens) {
    const newSig = signEd25519(token.canonical_hash, privateKeyHex);
    db.prepare('UPDATE verification_tokens SET issuance_signature = ? WHERE id = ?').run(newSig, token.id);
  }
  db.exec('COMMIT');
  console.log('  ✓ Updated DB — all colleges now use new public key');
  console.log('  ✓ Re-signed', db.prepare("SELECT COUNT(*) as c FROM verification_tokens WHERE status='active'").get().c, 'active token(s)');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('  ❌ DB update failed:', err.message);
  process.exit(1);
}

// Write connector_key.json (so server's mock connector also uses same key)
fs.writeFileSync(CONNECTOR_KEY, JSON.stringify({ privateKeyHex, publicKeyHex, college: 'all', generated: new Date().toISOString() }, null, 2));
console.log('  ✓ Wrote connector_key.json to server directory');

// ── Recreate connector.db with student data ──────────────────────────────────
if (fs.existsSync(CONNECTOR_DB)) fs.unlinkSync(CONNECTOR_DB);
const connDb = new DatabaseSync(CONNECTOR_DB);
connDb.exec(`
  CREATE TABLE IF NOT EXISTS students (
    student_ref_token TEXT PRIMARY KEY, college_id INTEGER NOT NULL,
    name TEXT NOT NULL, degree TEXT NOT NULL, branch TEXT NOT NULL,
    cgpa REAL NOT NULL, graduation_year INTEGER NOT NULL,
    issue_date TEXT NOT NULL, status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )
`);
const rows = [
  ['stu_ref_001', 1, 'SUPREETH K',   'BTECH', 'COMPUTER SCIENCE',       8.9, 2024, '2024-06-15', 'active'],
  ['stu_ref_004', 1, 'ANANYA PATEL', 'BTECH', 'ELECTRICAL ENGINEERING', 9.3, 2024, '2024-06-15', 'active'],
  ['stu_ref_007', 1, 'VIKRAM SINGH', 'MTECH', 'COMPUTER SCIENCE',       8.7, 2024, '2024-06-15', 'active'],
  ['stu_ref_010', 1, 'PRIYA DESAI',  'BTECH', 'MECHANICAL ENGINEERING', 8.2, 2023, '2023-06-15', 'active'],
];
const ins = connDb.prepare('INSERT INTO students (student_ref_token,college_id,name,degree,branch,cgpa,graduation_year,issue_date,status) VALUES (?,?,?,?,?,?,?,?,?)');
for (const r of rows) ins.run(...r);
console.log('  ✓ Recreated connector.db with', rows.length, 'students\n');

// ── Write connector .env ─────────────────────────────────────────────────────
fs.writeFileSync(CONNECTOR_ENV,
`# AuthenX Connector — IIT Bombay
# Generated by fix-and-start.js on ${new Date().toISOString()}
COLLEGE_ID=${iitb.id}
COLLEGE_NAME=IIT Bombay
CONNECTOR_PRIVATE_KEY_HEX=${privateKeyHex}
PORT=9000
DB_PATH=${CONNECTOR_DB}
`);
console.log('  ✓ Wrote connector .env (private key + college UUID)');

// ── Restart server to load new connector_key.json ────────────────────────────
console.log('\n  Restarting server to pick up new keys...');
try { execSync('lsof -ti:3000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' }); } catch (_) {}
execSync('sleep 1');
const serverProc2 = spawn('node', ['src/server.js'], {
  cwd: SERVER_DIR,
  detached: true,
  stdio: ['ignore', fs.openSync(path.join(SCRIPT_DIR, 'server.log'), 'w'), fs.openSync(path.join(SCRIPT_DIR, 'server.log'), 'w')],
});
serverProc2.unref();
execSync('sleep 3');
try {
  execSync('curl -sf http://localhost:3000/health > /dev/null');
  console.log('  ✅ Server restarted on port 3000');
} catch (_) {
  console.error('  ❌ Server failed to restart!');
  process.exit(1);
}

// ── Start connector ──────────────────────────────────────────────────────────
console.log('\n  Starting IIT Bombay Connector...');
const connProc = spawn('node', ['connector.js'], {
  cwd: CONNECTOR_DIR,
  detached: true,
  stdio: ['ignore', fs.openSync(path.join(SCRIPT_DIR, 'connector.log'), 'w'), fs.openSync(path.join(SCRIPT_DIR, 'connector.log'), 'w')],
});
connProc.unref();
execSync('sleep 2');
try {
  execSync('curl -sf http://localhost:9000/health > /dev/null');
  console.log('  ✅ Connector running on port 9000');
} catch (_) {
  console.error('  ⚠️  Connector not responding — check connector.log');
}

// ── Verify the full issue flow works ────────────────────────────────────────
console.log('\n  Running quick verification test...');
execSync('sleep 1');
const testScript = `
const http = require('http');
function post(host, port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({hostname: host, port, path, method: 'POST', headers: {'Content-Type': 'application/json', ...headers}}, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(d)}));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function test() {
  // Login
  const loginRes = await post('localhost', 3000, '/v1/auth/login', {email: 'iitb@authenx.in', password: 'College@123'}, {});
  if (!loginRes.body.token) throw new Error('Login failed: ' + JSON.stringify(loginRes.body));
  const token = loginRes.body.token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  console.log('  ✓ Login OK — college_id:', claims.college_id);

  // Fetch from connector
  const connRes = await post('localhost', 9000, '/verify', {student_ref_token: 'stu_ref_001', nonce: 'test_' + Date.now()}, {});
  if (!connRes.body.issuance_signature) throw new Error('Connector failed: ' + JSON.stringify(connRes.body));
  console.log('  ✓ Connector OK — Student:', connRes.body.name, '| CGPA:', connRes.body.cgpa);

  // Issue token
  const issueRes = await post('localhost', 3000, '/v1/tokens/issue', {
    college_id: claims.college_id,
    student_ref_token: 'stu_ref_001',
    name: connRes.body.name,
    degree: connRes.body.degree,
    branch: connRes.body.branch,
    credential_type: connRes.body.credential_type || 'DEGREE_CERTIFICATE',
    cgpa: String(connRes.body.cgpa || ''),
    graduation_year: String(connRes.body.graduation_year || ''),
    issue_date: connRes.body.issue_date || '',
    issuance_signature: connRes.body.issuance_signature,
  }, {'Authorization': 'Bearer ' + token});

  if (issueRes.status === 201) {
    console.log('  ✅ TOKEN ISSUED — Code:', issueRes.body.authenx_code.slice(0, 30) + '...');
  } else {
    console.error('  ❌ Issue FAILED:', JSON.stringify(issueRes.body));
    process.exit(1);
  }
  process.exit(0);
}
test().catch(e => { console.error('  ❌', e.message); process.exit(1); });
`;
fs.writeFileSync('/tmp/ax_test.js', testScript);
try {
  execSync('node /tmp/ax_test.js', { stdio: 'inherit', timeout: 15000 });
} catch (err) {
  console.error('\n  ❌ Verification test failed! Check server.log and connector.log');
  process.exit(1);
}

// ── Open Browser ─────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  ALL SYSTEMS GO — Opening browser portals...               ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  College Admin : iitb@authenx.in   / College@123           ║');
console.log('║  Employer      : admin@authenx.in  / Admin@123             ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

execSync(`open "file://${SCRIPT_DIR}/ui/college/index.html"`);
execSync('sleep 1');
execSync(`open "file://${SCRIPT_DIR}/ui/employer/index.html"`);
console.log('  ✅ Browser portals opened!\n');
