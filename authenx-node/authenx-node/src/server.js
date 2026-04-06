'use strict';
/**
 * AuthenX Node.js Server
 * Production-grade academic credential verification infrastructure
 * Zero external dependencies — uses only Node 22 built-in modules
 */

const http    = require('node:http');
const crypto  = require('node:crypto');
const { URL } = require('node:url');

const { getDb, run, queryOne, query } = require('./db/client.js');
const { hashPassword, generateEd25519KeyPair, signEd25519, sha256, buildCanonicalJson, encryptCode } = require('./crypto/index.js');

const { login }                         = require('./routes/auth.js');
const { listColleges, getCollege, createCollege } = require('./routes/colleges.js');
const { issueToken, revokeToken, getToken, listTokens } = require('./routes/tokens.js');
const { decodeCode, liveVerify }        = require('./routes/verify.js');
const { getAuditLog, getStats }         = require('./routes/audit.js');

const PORT = process.env.PORT || 3000;

// ─── Request body parser ──────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function router(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const path   = urlObj.pathname;
  const method = req.method;

  // Static: serve HTML frontend
  if (path === '/' || path === '/app') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_APP);
  }

  // Health check
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: '1.0.0', node: process.version }));
  }

  let body = {};
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    try { body = await readBody(req); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Auth routes
  if (path === '/v1/auth/login'  && method === 'POST') return login(req, res, body);

  // College routes
  if (path === '/v1/colleges'    && method === 'GET')  return listColleges(req, res);
  if (path === '/v1/colleges'    && method === 'POST') return createCollege(req, res, body);
  const collegeMatch = path.match(/^\/v1\/colleges\/([^/]+)$/);
  if (collegeMatch             && method === 'GET')  return getCollege(req, res, collegeMatch[1]);

  // Token routes
  if (path === '/v1/tokens'          && method === 'GET')  return listTokens(req, res);
  if (path === '/v1/tokens/issue'    && method === 'POST') return issueToken(req, res, body);
  if (path === '/v1/tokens/revoke'   && method === 'POST') return revokeToken(req, res, body);
  const tokenMatch = path.match(/^\/v1\/tokens\/([^/]+)$/);
  if (tokenMatch                     && method === 'GET')  return getToken(req, res, tokenMatch[1]);

  // Verify routes
  if (path === '/v1/verify/code' && method === 'POST') return decodeCode(req, res, body);
  if (path === '/v1/verify/live' && method === 'POST') return liveVerify(req, res, body);

  // Audit routes
  if (path === '/v1/audit'       && method === 'GET') return getAuditLog(req, res, urlObj);
  if (path === '/v1/audit/stats' && method === 'GET') return getStats(req, res);

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Route not found', path, method }));
}

// ─── Seed data ────────────────────────────────────────────────────────────────
async function seedDatabase() {
  const existingAdmin = queryOne("SELECT id FROM users WHERE email='admin@authenx.in'");
  if (existingAdmin) { console.log('  ✓ Database already seeded'); return; }

  console.log('  → Seeding database...');

  // Generate Ed25519 key pair for mock college connector
  const { privateKeyHex, publicKeyHex } = generateEd25519KeyPair();
  process.env.MOCK_CONNECTOR_PRIV_KEY = privateKeyHex;

  // Create 3 colleges
  const colleges = [
    { id: crypto.randomUUID(), name: 'IIT Bombay',   short_code: 'IITB',  connector_url: 'mock', shared_secret: crypto.randomBytes(32).toString('hex'), public_key_hex: publicKeyHex },
    { id: crypto.randomUUID(), name: 'NIT Calicut',  short_code: 'NITC',  connector_url: 'mock', shared_secret: crypto.randomBytes(32).toString('hex'), public_key_hex: publicKeyHex },
    { id: crypto.randomUUID(), name: 'BITS Pilani',  short_code: 'BITS',  connector_url: 'mock', shared_secret: crypto.randomBytes(32).toString('hex'), public_key_hex: publicKeyHex },
  ];
  for (const c of colleges) {
    run('INSERT INTO colleges (id,name,short_code,public_key_hex,connector_url,shared_secret) VALUES (?,?,?,?,?,?)',
      [c.id, c.name, c.short_code, c.public_key_hex, c.connector_url, c.shared_secret]);
  }

  // Create admin user (scrypt-hashed password)
  const adminHash  = await hashPassword('Admin@123');
  const collegeHash = await hashPassword('College@123');

  run('INSERT INTO users (id,email,password_hash,role) VALUES (?,?,?,?)',
    [crypto.randomUUID(), 'admin@authenx.in', adminHash, 'super_admin']);
  run('INSERT INTO users (id,email,password_hash,role,college_id) VALUES (?,?,?,?,?)',
    [crypto.randomUUID(), 'iitb@authenx.in', collegeHash, 'college_admin', colleges[0].id]);
  run('INSERT INTO users (id,email,password_hash,role,college_id) VALUES (?,?,?,?,?)',
    [crypto.randomUUID(), 'nitc@authenx.in', collegeHash, 'college_admin', colleges[1].id]);

  // Issue 3 test tokens (signed with the college Ed25519 key)
  const testStudents = [
    { student_ref_token: 'stu_ref_001', name: 'SUPREETH K',    degree: 'BTECH', branch: 'COMPUTER SCIENCE', credential_type: 'DEGREE_CERTIFICATE', cgpa: '8.9', graduation_year: '2024', issue_date: '2024-06-15', college: colleges[0] },
    { student_ref_token: 'stu_ref_002', name: 'PRIYA SHARMA',  degree: 'MTECH', branch: 'ELECTRONICS',      credential_type: 'DEGREE_CERTIFICATE', cgpa: '9.1', graduation_year: '2024', issue_date: '2024-06-15', college: colleges[1] },
    { student_ref_token: 'stu_ref_003', name: 'RAHUL NAIR',    degree: 'BTECH', branch: 'MECHANICAL',       credential_type: 'DEGREE_CERTIFICATE', cgpa: '7.8', graduation_year: '2023', issue_date: '2023-06-15', college: colleges[2] },
  ];

  const generatedCodes = [];
  for (const s of testStudents) {
    const fields = {
      schema_version: '1.0', issuer_id: s.college.id,
      student_ref_token: s.student_ref_token, name: s.name,
      degree: s.degree, branch: s.branch, credential_type: s.credential_type,
      cgpa: s.cgpa, graduation_year: s.graduation_year, issue_date: s.issue_date,
    };
    const canonical  = buildCanonicalJson(fields);
    const canonical_hash = sha256(canonical);
    const issuance_signature = signEd25519(canonical_hash, privateKeyHex);
    const token_id = crypto.randomUUID();

    run(`INSERT INTO verification_tokens
         (id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type, status)
         VALUES (?,?,?,?,?,?,?,?)`,
      [token_id, s.college.id, s.student_ref_token, canonical_hash, issuance_signature, '1.0', s.credential_type, 'active']);

    const code = encryptCode({ v: 1, token_id, college_id: s.college.id, student_ref_token: s.student_ref_token, credential_type: s.credential_type });
    generatedCodes.push({ name: s.name, student_ref_token: s.student_ref_token, token_id, authenx_code: code });
  }

  // Revoke stu_ref_003 (Rahul Nair) — for testing revoked flow
  run("UPDATE verification_tokens SET status='revoked', revocation_reason='Re-enrolled for additional year', revoked_at=datetime('now') WHERE student_ref_token='stu_ref_003'");

  // Store generated codes in a file so we can read them in tests
  require('node:fs').writeFileSync(
    require('node:path').join(process.cwd(), 'seed_codes.json'),
    JSON.stringify(generatedCodes, null, 2)
  );

  console.log('  ✓ Seeded: 3 colleges, 3 users, 3 tokens');
  console.log('  ✓ Seed codes saved to seed_codes.json');
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────
const HTML_APP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AuthenX — Credential Verification</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;color:#1f2937}
.sidebar{position:fixed;top:0;left:0;width:200px;height:100vh;background:#1B4F8A;padding:24px 0;z-index:100}
.logo{padding:0 20px 24px;border-bottom:1px solid #2563EB}
.logo h1{color:#fff;font-size:22px;font-weight:700}
.logo p{color:#93C5FD;font-size:11px;margin-top:2px}
.nav-item{display:block;padding:10px 20px;color:#93C5FD;cursor:pointer;font-size:13px;border-left:3px solid transparent;transition:.15s}
.nav-item:hover,.nav-item.active{color:#fff;background:#2563EB22;border-left-color:#60A5FA}
.main{margin-left:200px;padding:32px;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
.topbar h2{font-size:20px;font-weight:700;color:#1f2937}
.topbar span{font-size:12px;color:#9ca3af}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px}
.card-title{font-size:14px;font-weight:600;color:#374151;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #f3f4f6}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.stat{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;position:relative;overflow:hidden}
.stat-label{font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px}
.stat-val{font-size:32px;font-weight:700;color:#1f2937;margin:6px 0}
.stat-sub{font-size:11px;color:#9ca3af}
.stat-bar{position:absolute;bottom:0;left:0;right:0;height:3px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:.15s}
.btn-primary{background:#2563EB;color:#fff}.btn-primary:hover{background:#1d4ed8}
.btn-secondary{background:#f3f4f6;color:#374151}.btn-secondary:hover{background:#e5e7eb}
.btn-danger{background:#ef4444;color:#fff}.btn-danger:hover{background:#dc2626}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:500}
.badge-green{background:#f0fdf4;color:#166534}
.badge-red{background:#fef2f2;color:#991b1b}
.badge-blue{background:#eff6ff;color:#1e40af}
.badge-gray{background:#f3f4f6;color:#4b5563}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;background:#f9fafb;border-bottom:1px solid #e5e7eb}
td{padding:12px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f9fafb}
.form-group{margin-bottom:16px}
.form-label{display:block;font-size:12px;color:#6b7280;margin-bottom:6px;font-weight:500}
.form-input{width:100%;padding:9px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;color:#1f2937;outline:none;transition:.15s}
.form-input:focus{border-color:#2563EB;box-shadow:0 0 0 3px #2563eb18}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.result-box{padding:20px;border-radius:8px;margin-top:16px}
.result-verified{background:#f0fdf4;border:1px solid #bbf7d0}
.result-revoked{background:#fef2f2;border:1px solid #fecaca}
.result-error{background:#fefce8;border:1px solid #fde68a}
.result-title{font-size:18px;font-weight:700;margin-bottom:12px}
.result-field{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0000000f;font-size:13px}
.result-field:last-child{border-bottom:none}
.result-key{color:#6b7280}
.result-val{font-weight:500;color:#1f2937}
.code-box{background:#1e293b;border-radius:8px;padding:16px;font-family:monospace;font-size:12px;color:#86efac;word-break:break-all;margin:12px 0;line-height:1.6}
.hidden{display:none}
.screen{display:none}.screen.active{display:block}
.alert{padding:12px 16px;border-radius:6px;font-size:13px;margin-bottom:16px}
.alert-info{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe}
.alert-success{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.alert-error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
#loginScreen{max-width:400px;margin:60px auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 4px 24px #0002}
.login-logo{text-align:center;margin-bottom:24px}
.login-logo h1{font-size:28px;color:#1B4F8A;font-weight:700}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #fff4;border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.mono{font-family:monospace;font-size:11px;color:#6b7280;word-break:break-all}
</style>
</head>
<body>

<!-- LOGIN SCREEN -->
<div id="loginScreen">
  <div class="login-logo">
    <h1>AuthenX</h1>
    <p style="color:#9ca3af;font-size:12px;margin-top:4px">Academic Credential Infrastructure</p>
  </div>
  <div id="loginError" class="alert alert-error hidden"></div>
  <div class="form-group">
    <label class="form-label">Email address</label>
    <input class="form-input" id="loginEmail" type="email" value="admin@authenx.in" placeholder="email">
  </div>
  <div class="form-group">
    <label class="form-label">Password</label>
    <input class="form-input" id="loginPass" type="password" value="Admin@123" placeholder="password">
  </div>
  <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">
    Sign in
  </button>
  <p style="text-align:center;margin-top:20px;font-size:11px;color:#9ca3af">🔒  Ed25519 + AES-256-GCM · Privacy-first</p>
</div>

<!-- APP SHELL -->
<div id="appShell" class="hidden">
  <div class="sidebar">
    <div class="logo"><h1>AuthenX</h1><p id="sidebarRole"></p></div>
    <div style="padding:16px 0">
      <div class="nav-item active" onclick="showScreen('dashboard')">📊  Dashboard</div>
      <div class="nav-item" onclick="showScreen('colleges')">🏛️  Colleges</div>
      <div class="nav-item" onclick="showScreen('credentials')">🎓  Credentials</div>
      <div class="nav-item" onclick="showScreen('verify')">🔍  Verify</div>
      <div class="nav-item" onclick="showScreen('audit')">📋  Audit Log</div>
    </div>
    <div style="position:absolute;bottom:16px;left:0;right:0;padding:0 16px">
      <button class="btn btn-secondary" style="width:100%;justify-content:center;font-size:12px" onclick="doLogout()">Sign out</button>
    </div>
  </div>
  <div class="main">

    <!-- DASHBOARD -->
    <div id="screen-dashboard" class="screen active">
      <div class="topbar"><h2>Dashboard</h2><span id="dashDate"></span></div>
      <div class="stats" id="statsGrid">
        <div class="stat"><div class="stat-label">Colleges</div><div class="stat-val" id="s-colleges">—</div><div class="stat-sub">Active connectors</div><div class="stat-bar" style="background:#2563EB"></div></div>
        <div class="stat"><div class="stat-label">Tokens Issued</div><div class="stat-val" id="s-tokens">—</div><div class="stat-sub">Active credentials</div><div class="stat-bar" style="background:#22c55e"></div></div>
        <div class="stat"><div class="stat-label">Verifications</div><div class="stat-val" id="s-verifs">—</div><div class="stat-sub">Live checks</div><div class="stat-bar" style="background:#f59e0b"></div></div>
        <div class="stat"><div class="stat-label">Revoked</div><div class="stat-val" id="s-revoked">—</div><div class="stat-sub">Cancelled tokens</div><div class="stat-bar" style="background:#ef4444"></div></div>
      </div>
      <div class="card">
        <div class="card-title">Recent Verifications</div>
        <table><thead><tr><th>Employer</th><th>College</th><th>Type</th><th>Result</th><th>Latency</th><th>Time</th></tr></thead>
        <tbody id="recentTable"><tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px">Loading...</td></tr></tbody></table>
      </div>
    </div>

    <!-- COLLEGES -->
    <div id="screen-colleges" class="screen">
      <div class="topbar"><h2>Colleges</h2></div>
      <div id="collegeList"></div>
    </div>

    <!-- CREDENTIALS -->
    <div id="screen-credentials" class="screen">
      <div class="topbar"><h2>Credentials</h2></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <div class="card-title">Issue Credential</div>
          <div class="form-group"><label class="form-label">College</label>
            <select class="form-input" id="issueCollege"></select></div>
          <div class="form-group"><label class="form-label">Student Ref Token</label>
            <input class="form-input" id="issueRef" value="stu_ref_001"></div>
          <div class="form-grid">
            <div class="form-group"><label class="form-label">Full Name</label>
              <input class="form-input" id="issueName" value="SUPREETH K"></div>
            <div class="form-group"><label class="form-label">Degree</label>
              <input class="form-input" id="issueDegree" value="BTECH"></div>
            <div class="form-group"><label class="form-label">Branch</label>
              <input class="form-input" id="issueBranch" value="COMPUTER SCIENCE"></div>
            <div class="form-group"><label class="form-label">CGPA</label>
              <input class="form-input" id="issueCgpa" value="8.9"></div>
            <div class="form-group"><label class="form-label">Graduation Year</label>
              <input class="form-input" id="issueYear" value="2024"></div>
            <div class="form-group"><label class="form-label">Credential Type</label>
              <input class="form-input" id="issueType" value="DEGREE_CERTIFICATE"></div>
          </div>
          <button class="btn btn-primary" onclick="doIssue()">Issue Credential</button>
          <div id="issueResult" class="hidden" style="margin-top:16px"></div>
        </div>
        <div class="card">
          <div class="card-title">Issued Tokens</div>
          <table><thead><tr><th>Ref</th><th>College</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="tokenTable"><tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">Loading...</td></tr></tbody></table>
        </div>
      </div>
    </div>

    <!-- VERIFY -->
    <div id="screen-verify" class="screen">
      <div class="topbar"><h2>Verify Credential</h2></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <div class="card-title">Step 1 — Paste AuthenX Code</div>
          <div class="form-group">
            <label class="form-label">AuthenX Code</label>
            <textarea class="form-input" id="verifyCode" rows="5" placeholder="AX1.eyJ..."></textarea>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" onclick="doDecodeCode()">Decode Code</button>
            <button class="btn btn-primary" onclick="doLiveVerify()">Live Verify (ERP)</button>
          </div>
          <div class="alert alert-info" style="margin-top:16px;font-size:12px">
            💡 <strong>Decode Code</strong> checks the AuthenX registry only.<br>
            <strong>Live Verify</strong> calls the college ERP in real-time.
          </div>
        </div>
        <div class="card">
          <div class="card-title">Result</div>
          <div id="verifyResult"><p style="color:#9ca3af;font-size:13px">Paste an AuthenX Code and click verify.</p></div>
        </div>
      </div>
    </div>

    <!-- AUDIT -->
    <div id="screen-audit" class="screen">
      <div class="topbar"><h2>Audit Log</h2></div>
      <div class="card">
        <div class="card-title">All Verification Events</div>
        <table><thead><tr><th>Time</th><th>Type</th><th>Employer</th><th>College</th><th>Result</th><th>Hash</th><th>Latency</th></tr></thead>
        <tbody id="auditTable"><tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:24px">Loading...</td></tr></tbody></table>
      </div>
    </div>

  </div><!-- /main -->
</div><!-- /appShell -->

<script>
const API = '';
let TOKEN = null, USER = null;

const api = async (method, path, body) => {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body)  opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};

async function doLogin() {
  const email = document.getElementById('loginEmail').value;
  const pass  = document.getElementById('loginPass').value;
  try {
    const d = await api('POST', '/v1/auth/login', { email, password: pass });
    TOKEN = d.token; USER = d.user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    document.getElementById('sidebarRole').textContent = USER.role.replace('_',' ');
    document.getElementById('dashDate').textContent = new Date().toLocaleString();
    loadDashboard(); loadColleges(); loadTokens(); loadAudit();
  } catch(e) {
    const el = document.getElementById('loginError');
    el.textContent = e.message; el.classList.remove('hidden');
  }
}

function doLogout() {
  TOKEN = null; USER = null;
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'dashboard') loadDashboard();
  if (name === 'audit') loadAudit();
  if (name === 'credentials') { loadCollegesDropdown(); loadTokens(); }
}

async function loadDashboard() {
  try {
    const s = await api('GET', '/v1/audit/stats');
    document.getElementById('s-colleges').textContent = s.stats.colleges;
    document.getElementById('s-tokens').textContent   = s.stats.tokens_active;
    document.getElementById('s-verifs').textContent   = s.stats.verifications;
    document.getElementById('s-revoked').textContent  = s.stats.tokens_revoked;
    const a = await api('GET', '/v1/audit?limit=8');
    const tb = document.getElementById('recentTable');
    if (!a.events.length) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px">No events yet</td></tr>'; return; }
    tb.innerHTML = a.events.map(e => {
      const res = e.result === 'verified' ? '<span class="badge badge-green">✓ verified</span>'
                : e.result === 'revoked'  ? '<span class="badge badge-red">✗ revoked</span>'
                : '<span class="badge badge-gray">'+e.result+'</span>';
      return \`<tr><td>\${e.employer_name||'—'}</td><td>\${e.college_name}</td><td>\${e.request_type}</td><td>\${res}</td><td>\${e.latency_ms!=null?e.latency_ms+'ms':'—'}</td><td style="color:#9ca3af">\${relTime(e.created_at)}</td></tr>\`;
    }).join('');
  } catch(e) { console.error(e); }
}

async function loadColleges() {
  try {
    const d = await api('GET', '/v1/colleges');
    const el = document.getElementById('collegeList');
    el.innerHTML = d.colleges.map(c => \`
      <div class="card" style="display:flex;align-items:center;gap:20px">
        <div style="width:48px;height:48px;background:#eff6ff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#1B4F8A">\${c.short_code.slice(0,2)}</div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:15px">\${c.name}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">Connector: \${c.connector_url} &nbsp;·&nbsp; <span class="badge badge-green">● Active</span></div>
          <div class="mono" style="margin-top:6px">pub: \${c.public_key_hex.slice(0,24)}...</div>
        </div>
      </div>\`).join('');
  } catch(e) {}
}

async function loadCollegesDropdown() {
  try {
    const d = await api('GET', '/v1/colleges');
    const sel = document.getElementById('issueCollege');
    sel.innerHTML = d.colleges.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
  } catch(e) {}
}

async function doIssue() {
  try {
    const body = {
      college_id:        document.getElementById('issueCollege').value,
      student_ref_token: document.getElementById('issueRef').value,
      name:              document.getElementById('issueName').value,
      degree:            document.getElementById('issueDegree').value,
      branch:            document.getElementById('issueBranch').value,
      cgpa:              document.getElementById('issueCgpa').value,
      graduation_year:   document.getElementById('issueYear').value,
      credential_type:   document.getElementById('issueType').value,
      // We need an issuance_signature — for web UI demo we call /v1/tokens/sign-demo
      issuance_signature: '__DEMO__',
    };
    // For the web UI: use demo sign endpoint
    const d = await api('POST', '/v1/tokens/issue-demo', body);
    const el = document.getElementById('issueResult');
    el.classList.remove('hidden');
    el.innerHTML = \`<div class="alert alert-success">✓ Token issued</div>
      <div class="code-box">\${d.authenx_code}</div>
      <button class="btn btn-secondary" style="font-size:12px" onclick="document.getElementById('verifyCode').value='\${d.authenx_code}';showScreenDirect('verify')">→ Verify this code</button>\`;
    loadTokens();
  } catch(e) {
    const el = document.getElementById('issueResult');
    el.classList.remove('hidden');
    el.innerHTML = \`<div class="alert alert-error">\${e.message}</div>\`;
  }
}

function showScreenDirect(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
}

async function loadTokens() {
  try {
    const d = await api('GET', '/v1/tokens');
    const tb = document.getElementById('tokenTable');
    if (!d.tokens.length) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">No tokens yet</td></tr>'; return; }
    tb.innerHTML = d.tokens.map(t => {
      const badge = t.status==='active' ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-red">revoked</span>';
      return \`<tr><td class="mono">\${t.student_ref_token}</td><td>\${t.college_name}</td><td style="font-size:11px">\${t.credential_type}</td><td>\${badge}</td><td>\${t.status==='active'?'<button class="btn btn-secondary" style="font-size:11px;padding:4px 8px" onclick="doRevoke(\\''+ t.id +'\\')">Revoke</button>':'—'}</td></tr>\`;
    }).join('');
  } catch(e) {}
}

async function doRevoke(id) {
  const reason = prompt('Reason for revocation:');
  if (!reason) return;
  try {
    await api('POST', '/v1/tokens/revoke', { token_id: id, reason });
    loadTokens(); loadDashboard();
  } catch(e) { alert(e.message); }
}

async function doDecodeCode() {
  const code = document.getElementById('verifyCode').value.trim();
  if (!code) return;
  try {
    const d = await api('POST', '/v1/verify/code', { authenx_code: code });
    showVerifyResult(d, 'decode');
  } catch(e) { showVerifyError(e.message); }
}

async function doLiveVerify() {
  const code = document.getElementById('verifyCode').value.trim();
  if (!code) return;
  try {
    const d = await api('POST', '/v1/verify/live', { authenx_code: code });
    showVerifyResult(d, 'live');
    loadDashboard(); loadAudit();
  } catch(e) { showVerifyError(e.message); }
}

function showVerifyResult(d, type) {
  const el = document.getElementById('verifyResult');
  const isVerified = d.result === 'verified';
  const isRevoked  = d.result === 'revoked';
  const cls = isVerified ? 'result-verified' : isRevoked ? 'result-revoked' : 'result-error';
  const icon = isVerified ? '✓' : '✗';
  const color = isVerified ? '#166534' : '#991b1b';

  let fields = '';
  if (d.live_data) {
    fields = Object.entries(d.live_data).map(([k,v]) =>
      \`<div class="result-field"><span class="result-key">\${k}</span><span class="result-val">\${v||'—'}</span></div>\`).join('');
  }
  if (isRevoked) {
    fields = \`<div class="result-field"><span class="result-key">Reason</span><span class="result-val" style="color:#991b1b">\${d.reason||d.revocation_reason||'—'}</span></div>
               <div class="result-field"><span class="result-key">Revoked at</span><span class="result-val">\${d.revoked_at||'—'}</span></div>\`;
  }
  const sigs = type === 'live' ? \`
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid #0000000f">
      <div class="result-field"><span class="result-key">Hash integrity</span><span class="result-val" style="color:\${d.hash_match?'#166534':'#991b1b'}">\${d.hash_match?'MATCH ✓':'MISMATCH ✗'}</span></div>
      <div class="result-field"><span class="result-key">Issuance signature</span><span class="result-val" style="color:\${d.issuance_sig?'#166534':'#991b1b'}">\${d.issuance_sig?'VALID ✓':'INVALID ✗'}</span></div>
      <div class="result-field"><span class="result-key">Live ERP signature</span><span class="result-val" style="color:\${d.live_sig?'#166534':'#6b7280'}">\${d.live_sig?'VALID ✓':'not signed'}</span></div>
      <div class="result-field"><span class="result-key">Latency</span><span class="result-val">\${d.latency_ms}ms</span></div>
    </div>\` : '';

  el.innerHTML = \`<div class="result-box \${cls}">
    <div class="result-title" style="color:\${color}">\${icon} \${d.result.toUpperCase()}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:12px">Issuer: \${d.college}</div>
    \${fields}\${sigs}
  </div>\`;
}

function showVerifyError(msg) {
  document.getElementById('verifyResult').innerHTML = \`<div class="result-box result-error">
    <div class="result-title" style="color:#92400e">⚠ Error</div>
    <div style="font-size:13px;color:#78350f">\${msg}</div>
  </div>\`;
}

async function loadAudit() {
  try {
    const d = await api('GET', '/v1/audit?limit=20');
    const tb = document.getElementById('auditTable');
    if (!d.events.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:24px">No events yet</td></tr>'; return; }
    tb.innerHTML = d.events.map(e => {
      const res = e.result==='verified'?'<span class="badge badge-green">✓ verified</span>'
                : e.result==='revoked'?'<span class="badge badge-red">✗ revoked</span>'
                : '<span class="badge badge-gray">'+e.result+'</span>';
      const hm = e.hash_match!=null ? (e.hash_match?'<span style="color:#166534">✓</span>':'<span style="color:#991b1b">✗</span>') : '—';
      return \`<tr><td style="color:#9ca3af;font-size:11px">\${relTime(e.created_at)}</td><td><span class="badge badge-blue">\${e.request_type}</span></td><td style="font-size:12px">\${e.employer_name||'—'}</td><td>\${e.college_name}</td><td>\${res}</td><td>\${hm}</td><td style="color:#9ca3af">\${e.latency_ms!=null?e.latency_ms+'ms':'—'}</td></tr>\`;
    }).join('');
  } catch(e) {}
}

function relTime(ts) {
  const d = new Date(ts+'Z'); const s = Math.floor((Date.now()-d)/1000);
  if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago'; return d.toLocaleDateString();
}
</script>
</body>
</html>`;

// ─── Demo issue endpoint (for web UI, handles signing internally) ──────────────
async function issueDemoRoute(req, res, body) {
  const { requireAuth, requireRole } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const {
    college_id, student_ref_token, name, degree, branch,
    cgpa, graduation_year, credential_type, issue_date
  } = body;

  if (!college_id || !student_ref_token || !name || !degree || !branch || !credential_type) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }

  const college = queryOne('SELECT * FROM colleges WHERE id = ? AND active = 1', [college_id]);
  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found' }));
  }

  const privKey = process.env.MOCK_CONNECTOR_PRIV_KEY;
  if (!privKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Mock connector key not initialised' }));
  }

  const fields = {
    schema_version: '1.0', issuer_id: college_id, student_ref_token,
    name, degree, branch, credential_type,
    cgpa: cgpa || '', graduation_year: graduation_year || '',
    issue_date: issue_date || new Date().toISOString().split('T')[0],
  };
  const canonical      = buildCanonicalJson(fields);
  const canonical_hash = sha256(canonical);
  const issuance_signature = signEd25519(canonical_hash, privKey);

  // Re-use the real issue route logic inline
  const existing = queryOne(
    'SELECT id, status FROM verification_tokens WHERE college_id = ? AND student_ref_token = ?',
    [college_id, student_ref_token]
  );

  const token_id = existing ? existing.id : crypto.randomUUID();

  run(`INSERT OR REPLACE INTO verification_tokens
       (id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type, status)
       VALUES (?,?,?,?,?,?,?,'active')`,
    [token_id, college_id, student_ref_token, canonical_hash, issuance_signature, '1.0', credential_type]);

  const authenx_code = encryptCode({
    v: 1, token_id, college_id, student_ref_token, credential_type,
    issued_at: new Date().toISOString(),
  });

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Token issued', token_id, canonical_hash, authenx_code }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔷 AuthenX — Academic Credential Infrastructure');
  console.log('━'.repeat(50));

  console.log('→ Initialising database...');
  getDb(); // runs schema migration
  await seedDatabase();

  // Inject demo route into router (after routes are loaded)
  const originalRouter = router;
  const wrappedRouter = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    if (urlObj.pathname === '/v1/tokens/issue-demo' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch {}
      return issueDemoRoute(req, res, body);
    }
    return originalRouter(req, res);
  };

  const server = http.createServer(wrappedRouter);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Server running → http://localhost:${PORT}`);
    console.log('\n📋 Test credentials:');
    console.log('   admin@authenx.in  / Admin@123    (super_admin)');
    console.log('   iitb@authenx.in   / College@123  (college_admin)');
    console.log('\n📄 Seed AuthenX Codes saved to → seed_codes.json');
    console.log('\n🔗 API endpoints:');
    console.log('   POST /v1/auth/login');
    console.log('   GET  /v1/colleges');
    console.log('   GET  /v1/tokens');
    console.log('   POST /v1/tokens/issue');
    console.log('   POST /v1/tokens/revoke');
    console.log('   POST /v1/verify/code');
    console.log('   POST /v1/verify/live');
    console.log('   GET  /v1/audit');
    console.log('   GET  /v1/audit/stats');
    console.log('━'.repeat(50));
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
