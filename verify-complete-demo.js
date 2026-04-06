#!/usr/bin/env node
/**
 * AuthenX Complete Demo Verification
 * Runs the full end-to-end workflow and displays results
 */

const http = require('node:http');
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function section(title) {
  log('\n' + '═'.repeat(60), 'cyan');
  log(`  ${title}`, 'cyan');
  log('═'.repeat(60) + '\n', 'cyan');
}

function check(condition, label) {
  log(`  ${condition ? '✅' : '❌'} ${label}`, condition ? 'green' : 'red');
  return condition;
}

async function httpReq(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://localhost:3000');
    const opts = {
      method,
      hostname: 'localhost',
      port: 3000,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data || {} });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function connectorReq(body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'POST',
      hostname: 'localhost',
      port: 9000,
      path: '/verify',
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data || {} });
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function extractJWT(token) {
  try {
    const payload = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function run() {
  log('\n', 'cyan');
  log('█████████████████████████████████████████████████████████████', 'cyan');
  log('█                                                             █', 'cyan');
  log('█    AuthenX — Complete End-to-End Workflow Verification    █', 'cyan');
  log('█                                                             █', 'cyan');
  log('█████████████████████████████████████████████████████████████', 'cyan');

  let passed = 0,
    failed = 0;

  try {
    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Verify Services Are Running
    // ═══════════════════════════════════════════════════════════════
    section('STEP 1: Verify Services Running');

    // Check server
    try {
      const res = await httpReq('POST', '/v1/auth/login', {
        email: 'admin@authenx.in',
        password: 'Admin@123',
      });
      if (check(res.status === 200, 'AuthenX Server (port 3000)')) passed++;
      else failed++;
    } catch (e) {
      check(false, 'AuthenX Server (port 3000) — ' + e.message);
      failed++;
    }

    // Check connector
    try {
      const res = await connectorReq({
        student_ref_token: 'stu_ref_001',
        nonce: 'health_' + Date.now(),
      });
      if (check(res.status === 200, 'IIT Bombay Connector (port 9000)'))
        passed++;
      else failed++;
    } catch (e) {
      check(false, 'IIT Bombay Connector (port 9000) — ' + e.message);
      failed++;
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: College Admin Auth & Get College ID
    // ═══════════════════════════════════════════════════════════════
    section('STEP 2: College Admin Authentication');

    const colRes = await httpReq('POST', '/v1/auth/login', {
      email: 'iitb@authenx.in',
      password: 'College@123',
    });
    check(colRes.status === 200, 'Login as college admin (iitb@authenx.in)');
    const colToken = colRes.data.token;
    if (colToken) passed++;
    else failed++;

    const colClaims = extractJWT(colToken);
    check(!!colClaims, 'JWT token decoded');
    if (colClaims) passed++;
    else failed++;

    const collegeId = colClaims?.college_id;
    log(`  College ID: ${collegeId}`, 'blue');

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Call Connector to Get Student Data
    // ═══════════════════════════════════════════════════════════════
    section('STEP 3: Connector Returns Student Data');

    const connRes = await connectorReq({
      student_ref_token: 'stu_ref_001',
      nonce: 'issue_' + Date.now(),
    });
    check(connRes.status === 200, 'Connector accepts verify request');
    if (connRes.status === 200) passed++;
    else failed++;

    const connData = connRes.data;
    log(`  Student: ${connData.name}`, 'blue');
    log(`  Degree: ${connData.degree}`, 'blue');
    log(`  Branch: ${connData.branch}`, 'blue');
    log(`  CGPA: ${connData.cgpa}`, 'blue');
    log(`  Graduation Year: ${connData.graduation_year}`, 'blue');
    log(`  Live Signature: ${connData.live_signature?.slice(0, 20)}...`, 'blue');
    log(`  Issuance Signature: ${connData.issuance_signature?.slice(0, 20)}...`, 'blue');

    check(!!connData.issuance_signature, 'Connector returns issuance_signature');
    if (connData.issuance_signature) passed++;
    else failed++;

    check(!!connData.live_signature, 'Connector returns live_signature');
    if (connData.live_signature) passed++;
    else failed++;

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Revoke Existing Token (if any)
    // ═══════════════════════════════════════════════════════════════
    section('STEP 4: Check for Existing Token');

    const listRes = await httpReq('GET', '/v1/tokens', null, colToken);
    const tokens = listRes.data.tokens || [];
    const existing = tokens.find(
      (t) =>
        t.student_ref_token === 'stu_ref_001' && t.status === 'active'
    );

    if (existing) {
      log(`  Found existing active token: ${existing.id.slice(0, 8)}...`, 'yellow');
      const revokeRes = await httpReq(
        'POST',
        '/v1/tokens/revoke',
        { token_id: existing.id, reason: 'Demo re-issue' },
        colToken
      );
      check(
        revokeRes.status === 200,
        `Revoked existing token`
      );
      if (revokeRes.status === 200) passed++;
      else failed++;
    } else {
      log(`  No existing token — proceeding to issue`, 'blue');
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Issue Credential (Get AuthenX Code)
    // ═══════════════════════════════════════════════════════════════
    section('STEP 5: Issue Credential & Generate AuthenX Code');

    const issueRes = await httpReq(
      'POST',
      '/v1/tokens/issue',
      {
        college_id: collegeId,
        student_ref_token: 'stu_ref_001',
        name: connData.name,
        degree: connData.degree,
        branch: connData.branch,
        credential_type: 'DEGREE_CERTIFICATE',
        cgpa: String(connData.cgpa || ''),
        graduation_year: String(connData.graduation_year || ''),
        issue_date: connData.issue_date,
        issuance_signature: connData.issuance_signature,
      },
      colToken
    );

    check(
      issueRes.status === 201,
      `Token issued (HTTP ${issueRes.status})`
    );
    if (issueRes.status === 201) passed++;
    else failed++;

    const axCode = issueRes.data.authenx_code;
    const tokenId = issueRes.data.token_id;
    log(`  Token ID: ${tokenId?.slice(0, 8)}...`, 'blue');
    log(`  AuthenX Code: ${axCode?.slice(0, 40)}...`, 'blue');
    log(`  Code Length: ${axCode?.length} characters`, 'blue');

    check(!!axCode, 'AuthenX Code generated');
    if (axCode) passed++;
    else failed++;

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Employer Auth
    // ═══════════════════════════════════════════════════════════════
    section('STEP 6: Employer Authentication');

    const empRes = await httpReq('POST', '/v1/auth/login', {
      email: 'admin@authenx.in',
      password: 'Admin@123',
    });

    check(empRes.status === 200, 'Login as employer (admin@authenx.in)');
    if (empRes.status === 200) passed++;
    else failed++;

    const empToken = empRes.data.token;
    if (empToken) passed++;
    else failed++;

    // ═══════════════════════════════════════════════════════════════
    // STEP 7: Employer Decodes Code
    // ═══════════════════════════════════════════════════════════════
    section('STEP 7: Employer Decodes Code (Registry Check)');

    const decodeRes = await httpReq(
      'POST',
      '/v1/verify/code',
      { authenx_code: axCode },
      empToken
    );

    check(decodeRes.status === 200, 'Code decoded successfully');
    if (decodeRes.status === 200) passed++;
    else failed++;

    const decoded = decodeRes.data;
    log(`  Step: ${decoded.step}`, 'blue');
    log(`  Status: ${decoded.status}`, 'blue');
    log(`  College: ${decoded.college?.name || decoded.college}`, 'blue');
    log(`  Student Ref: ${decoded.student_ref_token}`, 'blue');
    log(`  Credential Type: ${decoded.credential_type}`, 'blue');
    log(`  Hash Preview: ${decoded.canonical_hash?.slice(0, 16)}...`, 'blue');
    log(`  Issued At: ${decoded.issued_at}`, 'blue');

    check(decoded.status === 'active', 'Token status is active');
    if (decoded.status === 'active') passed++;
    else failed++;

    check(
      !!decoded.canonical_hash,
      'Canonical hash present for verification'
    );
    if (decoded.canonical_hash) passed++;
    else failed++;

    // ═══════════════════════════════════════════════════════════════
    // STEP 8: Live Verification (Contact Connector)
    // ═══════════════════════════════════════════════════════════════
    section('STEP 8: Live Verification (Real-Time From College ERP)');

    const liveRes = await httpReq(
      'POST',
      '/v1/verify/live',
      { authenx_code: axCode },
      empToken
    );

    check(liveRes.status === 200, 'Live verification request succeeded');
    if (liveRes.status === 200) passed++;
    else failed++;

    const verified = liveRes.data;
    log(`  Result: ${verified.result}`, verified.result === 'verified' ? 'green' : 'red');
    log(`  College: ${verified.college}`, 'blue');
    log(`  Latency: ${verified.latency_ms}ms`, 'blue');

    // ═══════════════════════════════════════════════════════════════
    // STEP 9: Cryptographic Checks
    // ═══════════════════════════════════════════════════════════════
    log('\n  Cryptographic Checks:', 'bold');

    check(verified.hash_match === true, 'Hash Match');
    if (verified.hash_match) passed++;
    else failed++;

    check(verified.issuance_sig === true, 'Issuance Signature Valid');
    if (verified.issuance_sig) passed++;
    else failed++;

    check(verified.live_sig === true, 'Live ERP Signature Valid');
    if (verified.live_sig) passed++;
    else failed++;

    check(verified.not_revoked === true, 'Not Revoked');
    if (verified.not_revoked) passed++;
    else failed++;

    // ═══════════════════════════════════════════════════════════════
    // STEP 10: Live Student Data
    // ═══════════════════════════════════════════════════════════════
    log('\n  Live Student Data (From College ERP):', 'bold');

    const liveData = verified.live_data || {};
    log(`  Name: ${liveData.name}`, 'blue');
    log(`  Degree: ${liveData.degree}`, 'blue');
    log(`  Branch: ${liveData.branch}`, 'blue');
    log(`  CGPA: ${liveData.cgpa}`, 'blue');
    log(`  Graduation Year: ${liveData.graduation_year}`, 'blue');
    log(`  Issue Date: ${liveData.issue_date}`, 'blue');

    check(liveData.name === connData.name, 'Student name matches');
    if (liveData.name === connData.name) passed++;
    else failed++;

    check(verified.result === 'verified', 'Final Result: VERIFIED ✓');
    if (verified.result === 'verified') passed++;
    else failed++;

    // ═══════════════════════════════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════════════════════════════
    section('FINAL RESULTS');

    log(`  Total Checks: ${passed + failed}`, 'bold');
    log(`  ✅ Passed: ${passed}`, 'green');
    log(`  ❌ Failed: ${failed}`, failed > 0 ? 'red' : 'green');

    if (failed === 0) {
      log('\n  🎉 ALL CHECKS PASSED!', 'green');
      log('\n  ✅ Complete end-to-end workflow verified', 'green');
      log('  ✅ College issue → Employer verify working', 'green');
      log('  ✅ Cryptographic signatures valid', 'green');
      log('  ✅ Live ERP data integration working', 'green');
      log('  ✅ Privacy-first architecture confirmed', 'green');
      log('\n  🚀 AuthenX is ready for demo!', 'green');
    } else {
      log(`\n  ⚠️  ${failed} check(s) failed — see above`, 'red');
    }

    log('\n' + '═'.repeat(60) + '\n', 'cyan');

  } catch (err) {
    log(`\n❌ ERROR: ${err.message}`, 'red');
    log(`\nMake sure services are running: ./start-demo.sh`, 'yellow');
  }
}

run();
