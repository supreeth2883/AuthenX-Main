'use strict';
/**
 * AuthenX Smoke Test — Critical Path CI Check
 *
 * Validates the minimum viable workflow:
 *   login → connector verify → issue → decode → live verify → revoke
 *
 * Exit code 0 = pass, 1 = fail.
 *
 * Prerequisites:
 *   node authenx-hsm/server.js          (HSM at :9099)
 *   node authenx-node/src/server.js     (API at :3000, cwd = authenx-node/)
 *   node authenx-connector/connector.js (Connector at :9001)
 */
const http   = require('node:http');
const crypto = require('node:crypto');

const API_PORT       = parseInt(process.env.API_PORT       || '3000',  10);
const CONNECTOR_PORT = parseInt(process.env.CONNECTOR_PORT || '9001',  10);
const SHARED_SECRET  = process.env.IITB_SHARED_SECRET
  || '1dad195847665d340b5a33d7c3fd0abd96064ac4adb3e6b560bd12729b76fa34';

// ─── HTTP helpers ──────────────────────────────────────────────────────────────
function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    if (data) reqHeaders['Content-Length'] = Buffer.byteLength(data);

    const req = http.request({ hostname: 'localhost', port, path, method, headers: reqHeaders }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`Timeout: ${method} ${path}`)); });
    if (data) req.write(data);
    req.end();
  });
}

function postConnector(path, body) {
  const bodyStr   = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash  = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const message   = `POST:${path}:${timestamp}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', Buffer.from(SHARED_SECRET, 'hex'))
    .update(message).digest('hex');
  return request(CONNECTOR_PORT, 'POST', path, body, {
    'X-AuthenX-Timestamp': timestamp,
    'X-AuthenX-Signature': signature,
  });
}

// ─── Assertions ───────────────────────────────────────────────────────────────
let failures = 0;
function check(condition, label, detail = '') {
  if (!condition) {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  } else {
    console.log(`  pass  ${label}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== AuthenX Smoke Test ===\n');

  // 1. Service health
  const apiHealth = await request(API_PORT, 'GET', '/health');
  check(apiHealth.status === 200, 'API /health');

  const connHealth = await request(CONNECTOR_PORT, 'GET', '/health');
  check(connHealth.status === 200, 'Connector /health');

  if (failures > 0) {
    console.error('\nServices unreachable — aborting smoke test.\n');
    process.exit(1);
  }

  // 2. Login
  const loginRes = await request(API_PORT, 'POST', '/v1/auth/login',
    { email: 'admin@authenx.in', password: 'Admin@123' });
  check(loginRes.status === 200, 'POST /v1/auth/login');
  check(!!loginRes.body.token, 'Login returns JWT');
  const token = loginRes.body.token;
  const auth  = { Authorization: `Bearer ${token}` };

  // 3. Fetch college list & extract IITB ID
  const collegeRes = await request(API_PORT, 'GET', '/v1/colleges', null, auth);
  check(collegeRes.status === 200, 'GET /v1/colleges');
  const iitb = (collegeRes.body.colleges || []).find(c => c.short_code === 'IITB');
  check(!!iitb, 'IITB found in colleges');
  const collegeId = iitb?.id;

  // 4. Get credential data from connector
  const connRes = await postConnector('/verify', {
    student_ref_token: 'stu_ref_001',
    nonce: 'smoke_' + crypto.randomBytes(8).toString('hex'),
  });
  check(connRes.status === 200, 'Connector /verify (stu_ref_001)');
  check(!!connRes.body.issuance_signature, 'Connector returns issuance_signature');

  // 5. Issue token via API (college admin login first)
  const caLogin = await request(API_PORT, 'POST', '/v1/auth/login',
    { email: 'iitb@authenx.in', password: 'College@123' });
  check(caLogin.status === 200, 'College admin login');
  const caAuth = { Authorization: `Bearer ${caLogin.body.token}` };

  const issuePayload = {
    college_id:         collegeId,
    student_ref_token:  'stu_ref_001',
    name:               connRes.body.name,
    degree:             connRes.body.degree,
    branch:             connRes.body.branch,
    credential_type:    connRes.body.credential_type,
    cgpa:               String(connRes.body.cgpa),
    graduation_year:    String(connRes.body.graduation_year),
    issue_date:         connRes.body.issue_date,
    issuance_signature: connRes.body.issuance_signature,
  };

  let issueRes = await request(API_PORT, 'POST', '/v1/tokens/issue', issuePayload, caAuth);

  // If a token already exists, revoke it and re-issue to obtain a fresh AuthenX Code.
  if (issueRes.status === 409) {
    const tokensRes = await request(API_PORT, 'GET', '/v1/tokens', null, caAuth);
    check(tokensRes.status === 200, 'GET /v1/tokens (reissue flow)');

    const existing = (tokensRes.body.tokens || []).find(t =>
      t.college_id === collegeId &&
      t.student_ref_token === 'stu_ref_001' &&
      t.status === 'active'
    );
    check(!!existing, 'Existing active token found');

    if (existing) {
      const revokeRes = await request(API_PORT, 'POST', '/v1/tokens/revoke', {
        token_id: existing.id,
        reason: 'smoke_test_reissue'
      }, caAuth);
      check(revokeRes.status === 200, 'POST /v1/tokens/revoke (reissue flow)');

      issueRes = await request(API_PORT, 'POST', '/v1/tokens/issue', issuePayload, caAuth);
    }
  }

  // 201 = newly issued, 409 = still conflicting after retry
  check(issueRes.status === 201 || issueRes.status === 409, 'POST /v1/tokens/issue');
  const authenxCode = issueRes.body.authenx_code || null;
  check(!!authenxCode, 'AuthenX Code available');

  if (!authenxCode) {
    console.error('\nNo AuthenX Code — cannot continue verification checks.\n');
    process.exit(1);
  }

  // 6. Decode code
  const decodeRes = await request(API_PORT, 'POST', '/v1/verify/code',
    { authenx_code: authenxCode }, auth);
  check(decodeRes.status === 200, 'POST /v1/verify/code (decode)');
  check(decodeRes.body.status === 'active', 'Decoded token is active');

  // 7. Live verify
  const liveRes = await request(API_PORT, 'POST', '/v1/verify/live',
    { authenx_code: authenxCode }, auth);
  check(liveRes.status === 200, 'POST /v1/verify/live');
  check(liveRes.body.result === 'verified', `Live verify result: ${liveRes.body.result}`);
  check(liveRes.body.hash_match === true, 'Hash match');
  check(liveRes.body.issuance_sig === true, 'Issuance signature valid');
  check(liveRes.body.live_sig === true, 'Live signature valid');

  // 8. HMAC rejection
  const noHmac = await request(CONNECTOR_PORT, 'POST', '/verify',
    { student_ref_token: 'stu_ref_001', nonce: 'smoke_nohm_' + Date.now() });
  check(noHmac.status === 401, 'Unsigned connector request rejected (401)');

  // ─── Result ─────────────────────────────────────────────────────────────────
  console.log('');
  if (failures === 0) {
    console.log('=== SMOKE TEST PASSED ===\n');
    process.exit(0);
  } else {
    console.error(`=== SMOKE TEST FAILED: ${failures} check(s) failed ===\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
