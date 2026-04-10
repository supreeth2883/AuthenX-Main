'use strict';
/**
 * AuthenX End-to-End Test Suite
 * Tests the complete workflow: Login → Colleges → Connector → Issue → Verify → Revoke → Audit
 *
 * Prerequisites:
 *   node authenx-hsm/server.js        (HSM at :9099)
 *   node authenx-node/src/server.js   (API at :3000, cwd = authenx-node/)
 *   node authenx-connector/connector.js  (Connector at :9001, COLLEGE_ID = IITB)
 */
const http   = require('node:http');
const crypto = require('node:crypto');

// ─── IITB shared secret (matches colleges/registry.json + authenx-connector/.env) ──
const IITB_SHARED_SECRET = '1dad195847665d340b5a33d7c3fd0abd96064ac4adb3e6b560bd12729b76fa34';
const CONNECTOR_PORT     = 9001;

// ─── HTTP helpers ──────────────────────────────────────────────────────────────
function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port, path, method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * POST to a connector endpoint with HMAC authentication.
 * The connector requires X-AuthenX-Timestamp + X-AuthenX-Signature headers.
 * HMAC message: POST:<path>:<timestamp>:<sha256(body)>
 */
function postConnector(port, path, body, sharedSecretHex) {
  const bodyStr   = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash  = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const message   = `POST:${path}:${timestamp}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', Buffer.from(sharedSecretHex, 'hex'))
    .update(message).digest('hex');

  return post(port, path, body, {
    'X-AuthenX-Timestamp': timestamp,
    'X-AuthenX-Signature': signature,
  });
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       AuthenX — End-to-End Test Suite                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: Health checks
  // ═══════════════════════════════════════════════════════════════════
  console.log('── 1. Health Checks ──────────────────────────────────────');
  const serverHealth = await get(3000, '/health');
  assert(serverHealth.status === 200 && serverHealth.body.status === 'ok', 'Server /health returns OK');

  const connectorHealth = await get(CONNECTOR_PORT, '/health');
  assert(connectorHealth.status === 200 && connectorHealth.body.status === 'ok', 'Connector /health returns OK');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: Login — Super Admin
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 2. Login (Super Admin) ────────────────────────────────');
  const adminLogin = await post(3000, '/v1/auth/login', { email: 'admin@authenx.in', password: 'Admin@123' });
  assert(adminLogin.status === 200, 'Admin login returns 200');
  assert(!!adminLogin.body.token, 'Admin login returns JWT token');
  assert(adminLogin.body.user.role === 'super_admin', 'Admin role is super_admin');
  const adminToken = adminLogin.body.token;
  const adminAuth = { 'Authorization': `Bearer ${adminToken}` };

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: Login — College Admin
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 3. Login (College Admin — IIT Bombay) ─────────────────');
  const collegeLogin = await post(3000, '/v1/auth/login', { email: 'iitb@authenx.in', password: 'College@123' });
  assert(collegeLogin.status === 200, 'College login returns 200');
  assert(!!collegeLogin.body.token, 'College login returns JWT token');
  assert(collegeLogin.body.user.role === 'college_admin', 'College role is college_admin');
  assert(!!collegeLogin.body.user.college_id, 'College admin has college_id');
  const collegeToken = collegeLogin.body.token;
  const collegeAuth = { 'Authorization': `Bearer ${collegeToken}` };
  const collegeId = collegeLogin.body.user.college_id;
  const issueStudentRef = 'stu_iitb_001';

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4: Login — Invalid credentials
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 4. Login — Invalid Credentials ────────────────────────');
  const badLogin = await post(3000, '/v1/auth/login', { email: 'admin@authenx.in', password: 'wrongpass' });
  assert(badLogin.status === 401, 'Invalid password returns 401');

  const noUser = await post(3000, '/v1/auth/login', { email: 'nobody@authenx.in', password: 'Test123' });
  assert(noUser.status === 401, 'Unknown user returns 401');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 5: List Colleges
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 5. List Colleges ──────────────────────────────────────');
  const colleges = await get(3000, '/v1/colleges', adminAuth);
  assert(colleges.status === 200, 'List colleges returns 200');
  assert(Array.isArray(colleges.body.colleges), 'Returns an array of colleges');
  const iitb = colleges.body.colleges.find(c => c.short_code === 'IITB');
  assert(!!iitb, 'IIT Bombay found in colleges');
  assert(iitb.connector_url === `http://localhost:${CONNECTOR_PORT}`, 'IIT Bombay has correct connector URL');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 6: Auth required
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 6. Auth Required ──────────────────────────────────────');
  const noAuth = await get(3000, '/v1/colleges');
  assert(noAuth.status === 401, 'Unauthenticated request returns 401');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 7: List Tokens
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 7. List Tokens ───────────────────────────────────────');
  const tokens = await get(3000, '/v1/tokens', adminAuth);
  assert(tokens.status === 200, 'List tokens returns 200');
  assert(Array.isArray(tokens.body.tokens), 'Returns token array');
  assert(tokens.body.tokens.length >= 3, 'Has at least 3 seeded tokens');
  console.log(`    → Found ${tokens.body.tokens.length} tokens`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 8: Connector /verify (HMAC-authenticated)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 8. Connector /verify (stu_ref_001) ───────────────────');
  const connVerify = await postConnector(CONNECTOR_PORT, '/verify', {
    student_ref_token: 'stu_ref_001',
    nonce: 'e2e_test_' + Date.now(),
  }, IITB_SHARED_SECRET);
  assert(connVerify.status === 200, 'Connector verify returns 200');
  assert(connVerify.body.name === 'SUPREETH K', 'Returns correct student name');
  assert(connVerify.body.degree === 'BTECH', 'Returns correct degree');
  assert(connVerify.body.branch === 'COMPUTER SCIENCE', 'Returns correct branch');
  assert(!!connVerify.body.live_signature, 'Returns live_signature');
  assert(!!connVerify.body.issuance_signature, 'Returns issuance_signature');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 9: Issue a NEW token via connector + server
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n── 9. Issue Token (${issueStudentRef} via connector) ───────────`);
  const connData = await postConnector(CONNECTOR_PORT, '/verify', {
    student_ref_token: issueStudentRef,
    nonce: 'issue_test_' + Date.now(),
  }, IITB_SHARED_SECRET);
  assert(connData.status === 200, 'Connector returns data for issue student');

  const issuePayload = {
    college_id: collegeId,
    student_ref_token: issueStudentRef,
    name: connData.body.name,
    degree: connData.body.degree,
    branch: connData.body.branch,
    credential_type: connData.body.credential_type,
    cgpa: String(connData.body.cgpa),
    graduation_year: String(connData.body.graduation_year),
    issue_date: connData.body.issue_date,
    issuance_signature: connData.body.issuance_signature,
  };

  let issueRes = await post(3000, '/v1/tokens/issue', issuePayload, collegeAuth);
  if (issueRes.status === 409) {
    const tokensRes = await get(3000, '/v1/tokens', collegeAuth);
    assert(tokensRes.status === 200, 'List tokens for reissue flow returns 200');

    const existing = (tokensRes.body.tokens || []).find(t =>
      t.college_id === collegeId &&
      t.student_ref_token === issueStudentRef &&
      t.status === 'active'
    );
    assert(!!existing, 'Existing active token found for reissue flow');

    if (existing) {
      const revokeExisting = await post(3000, '/v1/tokens/revoke', {
        token_id: existing.id,
        reason: 'E2E test: force reissue in test 9',
      }, collegeAuth);
      assert(revokeExisting.status === 200, 'Revoke existing token for reissue flow returns 200');

      issueRes = await post(3000, '/v1/tokens/issue', issuePayload, collegeAuth);
    }
  }

  assert(issueRes.status === 201, 'Token issued successfully (201)');
  assert(typeof issueRes.body.authenx_code === 'string', 'AuthenX Code returned');
  assert(typeof issueRes.body.authenx_code === 'string' && issueRes.body.authenx_code.startsWith('AX1.'), 'Code has AX1. prefix');
  const newCode = issueRes.body.authenx_code || '';
  if (newCode) console.log(`    → AuthenX Code: ${newCode.slice(0, 40)}...`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 10: Decode AuthenX Code (registry-only check)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 10. Decode AuthenX Code ───────────────────────────────');
  const decode = await post(3000, '/v1/verify/code', { authenx_code: newCode }, adminAuth);
  assert(decode.status === 200, 'Decode returns 200');
  assert(decode.body.status === 'active', 'Token status is active');
  assert(decode.body.college === 'IIT Bombay', 'College name is IIT Bombay');
  console.log(`    → Token status: ${decode.body.status}, College: ${decode.body.college}`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 11: Live Verify (full ERP round-trip)
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n── 11. Live Verify (ERP round-trip — ${issueStudentRef}) ────────`);
  const live = await post(3000, '/v1/verify/live', { authenx_code: newCode }, adminAuth);
  assert(live.status === 200, 'Live verify returns 200');
  assert(live.body.result === 'verified', 'Result is VERIFIED');
  assert(live.body.hash_match === true, 'Hash MATCH ✓');
  assert(live.body.issuance_sig === true, 'Issuance signature VALID ✓');
  assert(live.body.live_sig === true, 'Live ERP signature VALID ✓');
  assert(live.body.latency_ms < 1000, `Latency acceptable: ${live.body.latency_ms}ms`);
  assert(!!live.body.live_data, 'Live data returned (transient)');
  assert(live.body.live_data.name === connData.body.name, 'Live student name correct');
  console.log(`    → ${String(live.body.result || '').toUpperCase()} | Hash: ✓ | Sig: ✓ | Live: ✓ | ${live.body.latency_ms}ms`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 12: Live Verify the NEWLY issued code (repeat)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 12. Live Verify (newly issued — repeat check) ───────');
  const live2 = await post(3000, '/v1/verify/live', { authenx_code: newCode }, adminAuth);
  assert(live2.status === 200, 'Live verify returns 200');
  assert(live2.body.result === 'verified', 'Result is VERIFIED');
  assert(live2.body.hash_match === true, 'Hash MATCH ✓');
  assert(live2.body.issuance_sig === true, 'Issuance signature VALID ✓');
  assert(!live2.body.live_data || live2.body.live_data?.name === connData.body.name, 'Live student name correct (or omitted from cache)');
  console.log(`    → ${live2.body.result.toUpperCase()} | ${live2.body.live_data?.name} | ${live2.body.latency_ms}ms`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 13: Verify active token via decode endpoint
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 13. Decode Active Token (consistency check) ───────────');
  const decode2 = await post(3000, '/v1/verify/code', { authenx_code: newCode }, adminAuth);
  assert(decode2.status === 200, 'Decode active code returns 200');
  assert(decode2.body.status === 'active', 'Decoded status remains active');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 14: Revoke a token
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n── 14. Revoke Token (${issueStudentRef}) ────────────────────────`);
  const newTokenId = issueRes.body.token_id;
  const revokeRes = await post(3000, '/v1/tokens/revoke', {
    token_id: newTokenId,
    reason: 'E2E test: revocation test',
  }, adminAuth);
  assert(revokeRes.status === 200, 'Revoke returns 200');
  assert(revokeRes.body.message === 'Token revoked', 'Revocation confirmed');

  const revokeCheck = await post(3000, '/v1/verify/live', { authenx_code: newCode }, adminAuth);
  assert(revokeCheck.body.result === 'revoked', 'Previously active token now shows REVOKED');
  console.log(`    → Token ${newTokenId.slice(0, 8)}... now revoked`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 15: Re-issue after revocation
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\n── 15. Re-issue After Revocation (${issueStudentRef}) ──────────`);
  const connData2 = await postConnector(CONNECTOR_PORT, '/verify', {
    student_ref_token: issueStudentRef,
    nonce: 'reissue_test_' + Date.now(),
  }, IITB_SHARED_SECRET);
  assert(connData2.status === 200, 'Connector returns data for reissue');
  const reissueRes = await post(3000, '/v1/tokens/issue', {
    college_id: collegeId,
    student_ref_token: issueStudentRef,
    name: connData2.body.name,
    degree: connData2.body.degree,
    branch: connData2.body.branch,
    credential_type: connData2.body.credential_type,
    cgpa: String(connData2.body.cgpa),
    graduation_year: String(connData2.body.graduation_year),
    issue_date: connData2.body.issue_date,
    issuance_signature: connData2.body.issuance_signature,
  }, collegeAuth);
  assert(reissueRes.status === 201, 'Re-issue after revocation succeeds (201)');
  assert(!!reissueRes.body.authenx_code, 'New AuthenX Code returned');
  console.log(`    → Re-issued: ${reissueRes.body.authenx_code.slice(0, 40)}...`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 16: Invalid/Tampered code
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 16. Invalid/Tampered Code ─────────────────────────────');
  const tampered = await post(3000, '/v1/verify/code', { authenx_code: 'AX1.TAMPERED_CODE_DATA' }, adminAuth);
  assert(tampered.status === 422, 'Tampered code returns 422');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 17: Audit Log
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 17. Audit Log ─────────────────────────────────────────');
  const audit = await get(3000, '/v1/audit?limit=50', adminAuth);
  assert(audit.status === 200, 'Audit log returns 200');
  assert(Array.isArray(audit.body.events), 'Audit events is an array');
  assert(audit.body.events.length > 0, 'Has audit events recorded');
  const liveEvents = audit.body.events.filter(e => e.request_type === 'live_verify');
  assert(liveEvents.length > 0, 'Live verification events recorded');
  console.log(`    → ${audit.body.events.length} total events, ${liveEvents.length} live verifications`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 18: Dashboard Stats
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 18. Dashboard Stats ───────────────────────────────────');
  const stats = await get(3000, '/v1/audit/stats', adminAuth);
  assert(stats.status === 200, 'Stats returns 200');
  assert(stats.body.stats.verifications > 0, 'Has verifications recorded');
  console.log(`    → Colleges: ${stats.body.stats.colleges}, Active: ${stats.body.stats.tokens_active}, Revoked: ${stats.body.stats.tokens_revoked}, Verifications: ${stats.body.stats.verifications}`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 19: Connector replay prevention
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 19. Replay Prevention ─────────────────────────────────');
  const replayNonce = 'replay_test_' + Date.now();
  const first  = await postConnector(CONNECTOR_PORT, '/verify', { student_ref_token: 'stu_ref_001', nonce: replayNonce }, IITB_SHARED_SECRET);
  assert(first.status === 200, 'First request with nonce succeeds');
  const replay = await postConnector(CONNECTOR_PORT, '/verify', { student_ref_token: 'stu_ref_001', nonce: replayNonce }, IITB_SHARED_SECRET);
  assert(replay.status === 409, 'Replay with same nonce returns 409');

  // ═══════════════════════════════════════════════════════════════════
  // TEST 20: Demo Issue + Live Verify (via HSM signing)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 20. Demo Issue Endpoint (HSM-signed) ──────────────────');
  const demoIssue = await post(3000, '/v1/tokens/issue-demo', {
    college_id: collegeId,
    student_ref_token: 'stu_iitb_002',
    name: 'PRIYA PATEL',
    degree: 'MTECH',
    branch: 'ELECTRICAL ENGINEERING',
    credential_type: 'DEGREE_CERTIFICATE',
    cgpa: '8.8',
    graduation_year: '2024',
    issue_date: '2024-06-15',
  }, adminAuth);
  assert(demoIssue.status === 201, 'Demo issue returns 201');
  assert(!!demoIssue.body.authenx_code, 'Demo issue returns AuthenX code');

  const demoVerify = await post(3000, '/v1/verify/live', { authenx_code: demoIssue.body.authenx_code }, adminAuth);
  assert(demoVerify.body.result === 'verified', 'Demo-issued code verifies successfully');
  assert(demoVerify.body.issuance_sig === true, 'Demo issuance signature valid');
  console.log(`    → Demo issue + verify: ${demoVerify.body.result?.toUpperCase()} ✓`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 21: HMAC rejection — connector rejects unsigned requests
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── 21. HMAC Rejection ────────────────────────────────────');
  const noHmac = await post(CONNECTOR_PORT, '/verify', { student_ref_token: 'stu_ref_001', nonce: 'nonce_no_hmac_' + Date.now() });
  assert(noHmac.status === 401, 'Request without HMAC headers returns 401');

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (failed === 0) {
    console.log('  🎉 ALL TESTS PASSED — End-to-end workflow fully operational!');
  } else {
    console.log('  ⚠️  Some tests failed — review above for details.');
  }
  console.log('═══════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\n  ❌ Fatal error:', err.message);
  process.exit(1);
});
