'use strict';
/**
 * AuthenX Wave 2 — End-to-End Test
 * Tests MFA Enrollment, MFA Login, and Zero-Trust HMAC Connector calls.
 * Self-cleaning: resets MFA state before running.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { generateTOTP, base32Decode } = require('./authenx-node/src/middleware/totp.js');

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

// ─── Clean MFA state before running ─────────────────────────────────
function cleanMfaState() {
  try {
    const db = new DatabaseSync(path.join(__dirname, 'authenx-node', 'authenx.db'));
    db.exec('DELETE FROM mfa_secrets; DELETE FROM mfa_backup_codes;');
    db.close();
    console.log('  🧹 Cleaned MFA state\n');
  } catch (e) {
    console.log('  ⚠️  Could not clean MFA state:', e.message, '\n');
  }
}

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('Request timed out')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(label, condition) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.error(`  ❌ ${label}`); }
}

async function run() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  AuthenX Wave 2 — E2E Security Suite');
  console.log('═══════════════════════════════════════════════\n');

  cleanMfaState();

  // --- Step 1: Initial Login ---
  console.log('📌 Test: Initial Login (No MFA)');
  const login1 = await req('POST', '/v1/auth/login', { email: 'recruiter@infosys.com', password: 'Employer@123' });
  assert('Initial login succeeds', login1.status === 200 && login1.data.token);
  if (login1.status !== 200) {
    console.log('     Login response:', JSON.stringify(login1.data));
    console.log('\n❌ Cannot continue without successful login');
    process.exit(1);
  }
  let empToken = login1.data.token;

  // --- Step 2: MFA Enrollment ---
  console.log('\n📌 Test: MFA Enrollment');
  const enroll = await req('POST', '/v1/auth/mfa/enroll', null, empToken);
  assert('MFA enrollment yields URI', enroll.status === 200 && enroll.data.uri && enroll.data.base32_secret);
  if (enroll.status !== 200) {
    console.log('     Enroll response:', JSON.stringify(enroll.data));
    process.exit(1);
  }

  const base32Secret = enroll.data.base32_secret;
  const secretBuf = base32Decode(base32Secret);
  const totpCode = generateTOTP(secretBuf);

  const confirm = await req('POST', '/v1/auth/mfa/confirm', { code: totpCode }, empToken);
  assert('MFA confirmation succeeds', confirm.status === 200 && confirm.data.backup_codes);
  const backupCodes = confirm.data.backup_codes;

  // --- Step 3: MFA Login Flow ---
  console.log('\n📌 Test: MFA Login Flow');
  const login2 = await req('POST', '/v1/auth/login', { email: 'recruiter@infosys.com', password: 'Employer@123' });
  assert('Login now requires MFA', login2.status === 200 && login2.data.mfa_required === true);

  const mfaToken = login2.data.mfa_token;

  // Wait 1 second to ensure TOTP window is fresh
  await new Promise(r => setTimeout(r, 1000));
  const totpCode2 = generateTOTP(secretBuf);
  const mfaVerify = await req('POST', '/v1/auth/mfa/verify', { code: totpCode2, mfa_token: mfaToken });
  assert('MFA verify returns full token', mfaVerify.status === 200 && mfaVerify.data.token);
  empToken = mfaVerify.data.token;

  // --- Step 4: Backup Code Fallback ---
  console.log('\n📌 Test: MFA Backup Code Fallback');
  const login3 = await req('POST', '/v1/auth/login', { email: 'recruiter@infosys.com', password: 'Employer@123' });
  const mfaVerify2 = await req('POST', '/v1/auth/mfa/verify', { code: backupCodes[0], mfa_token: login3.data.mfa_token });
  assert('Backup code login succeeds', mfaVerify2.status === 200 && mfaVerify2.data.token);

  // Re-use same mfa_token — should fail because the token can only be used once (backup code consumed)
  const login4 = await req('POST', '/v1/auth/login', { email: 'recruiter@infosys.com', password: 'Employer@123' });
  const mfaVerifyFail = await req('POST', '/v1/auth/mfa/verify', { code: backupCodes[0], mfa_token: login4.data.mfa_token });
  assert('Backup code is single-use', mfaVerifyFail.status === 401);

  // --- Step 5: Zero-Trust Connectors (HMAC) ---
  console.log('\n📌 Test: Zero-Trust Connector Auth (HMAC)');
  const fs = require('node:fs');
  const codes = JSON.parse(fs.readFileSync(path.join(__dirname, 'authenx-node', 'seed_codes.json'), 'utf8'));
  const targetCode = codes[0];

  const liveResult = await req('POST', '/v1/verify/live', { authenx_code: targetCode.authenx_code }, empToken);
  const isLiveOk = liveResult.status === 200 && liveResult.data.result === 'verified';
  assert('Live Verify with HMAC Auth succeeds', isLiveOk);

  if (isLiveOk) {
    console.log(`     ✓ Result: ${liveResult.data.result} | College: ${liveResult.data.college}`);
    console.log(`     ✓ Hash match: ${liveResult.data.hash_match} | Sig valid: ${liveResult.data.live_sig}`);
    console.log(`     ✓ Latency: ${liveResult.data.latency_ms}ms`);
  } else {
    console.log(`     ✗ Status: ${liveResult.status}`);
    console.log(`     ✗ Response:`, JSON.stringify(liveResult.data, null, 2));
  }

  // --- Step 6: HMAC Rejection Test ---
  console.log('\n📌 Test: HMAC Rejection (Unsigned Request)');
  // Direct call to connector without HMAC headers should be rejected
  const directResult = await new Promise((resolve) => {
    const body = JSON.stringify({ student_ref_token: 'stu_ref_001', nonce: 'attack_nonce' });
    const r = http.request({ hostname: 'localhost', port: 9001, path: '/verify', method: 'POST', 
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    });
    r.on('error', () => resolve({ status: 0, data: 'Connection refused' }));
    r.setTimeout(3000, () => { r.destroy(); resolve({ status: 0, data: 'timeout' }); });
    r.write(body); r.end();
  });
  assert('Unsigned request rejected by connector', directResult.status === 401);
  if (directResult.status === 401) {
    console.log(`     ✓ Connector correctly rejected: "${directResult.data.error}"`);
  } else {
    console.log(`     ✗ Got status ${directResult.status}:`, directResult.data);
  }

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
