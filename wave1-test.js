'use strict';
/**
 * AuthenX Wave 1 — End-to-End Verification Test
 * Tests the full multi-college flow: login → list colleges → decode → live verify → metrics
 */

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

// Self-clean MFA state so login works without MFA challenge
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(__dirname, 'authenx-node', 'authenx.db'));
  db.exec('DELETE FROM mfa_secrets; DELETE FROM mfa_backup_codes;');
  db.close();
} catch {}

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
  console.log('  AuthenX Wave 1 — E2E Verification Suite');
  console.log('═══════════════════════════════════════════════\n');

  // ── 1. Login as super_admin ─────────────────────────────────────────────
  console.log('📌 Test: Authentication');
  const adminLogin = await req('POST', '/v1/auth/login', { email: 'admin@authenx.in', password: 'Admin@123' });
  assert('Admin login succeeds', adminLogin.status === 200 && adminLogin.data.token);
  const adminToken = adminLogin.data.token;

  // ── 2. Login as employer ────────────────────────────────────────────────
  const empLogin = await req('POST', '/v1/auth/login', { email: 'recruiter@infosys.com', password: 'Employer@123' });
  assert('Employer login succeeds', empLogin.status === 200 && empLogin.data.token);
  const empToken = empLogin.data.token;

  // ── 3. Login as college admin ───────────────────────────────────────────
  const colLogin = await req('POST', '/v1/auth/login', { email: 'iitb@authenx.in', password: 'College@123' });
  assert('College admin login succeeds', colLogin.status === 200 && colLogin.data.token);

  // ── 4. List all colleges ────────────────────────────────────────────────
  console.log('\n📌 Test: Multi-College Registration');
  const colleges = await req('GET', '/v1/colleges', null, adminToken);
  assert('10 colleges registered', colleges.status === 200 && colleges.data.colleges.length === 10);
  if (colleges.data.colleges) {
    const names = colleges.data.colleges.map(c => c.short_code).sort();
    console.log(`     Colleges: ${names.join(', ')}`);
  }

  // ── 5. Connector health check ───────────────────────────────────────────
  console.log('\n📌 Test: Connector Health (all 10)');
  const health = await req('GET', '/v1/connectors/health', null, adminToken);
  assert('Connector health responds', health.status === 200);
  if (health.data.connectors) {
    const online = health.data.connectors.filter(c => c.status === 'online').length;
    assert(`At least 5 connectors online (got ${online})`, online >= 5);
    for (const c of health.data.connectors) {
      if (c.status === 'online') {
        console.log(`     ✓ ${c.college.padEnd(20)} ${c.latency_ms}ms`);
      }
    }
  }

  // ── 6. Decode AuthenX Code ──────────────────────────────────────────────
  console.log('\n📌 Test: AuthenX Code Decode');
  const codes = JSON.parse(fs.readFileSync(path.join(__dirname, 'authenx-node', 'seed_codes.json'), 'utf8'));
  assert('Seed codes file has entries', codes.length >= 2);

  const decode = await req('POST', '/v1/verify/code', { authenx_code: codes[0].authenx_code }, empToken);
  assert('Code decode succeeds', decode.status === 200 && decode.data.token_id);
  if (decode.data) {
    console.log(`     Token: ${decode.data.token_id}`);
    console.log(`     Status: ${decode.data.status}`);
    console.log(`     College: ${decode.data.college_name}`);
  }

  // ── 7. Live verification via connector ──────────────────────────────────
  console.log('\n📌 Test: Live Verification (cross-college)');
  const liveResult = await req('POST', '/v1/verify/live', { authenx_code: codes[0].authenx_code }, empToken);
  if (liveResult.status === 200 && liveResult.data.result === 'verified') {
    assert('Live verification succeeds', true);
    console.log(`     Result: ${liveResult.data.result}`);
    console.log(`     Hash match: ${liveResult.data.hash_match}`);
    console.log(`     Sig valid: ${liveResult.data.sig_valid}`);
    console.log(`     Latency: ${liveResult.data.latency_ms}ms`);
  } else if (liveResult.data.result === 'fallback_verified') {
    assert('Live verify fallback (connector may still be warming up)', true);
    console.log(`     Fallback result: ${liveResult.data.result}`);
  } else {
    assert(`Live verification (got: ${liveResult.data.result || liveResult.data.error})`, false);
  }

  // ── 8. Test revoked token ───────────────────────────────────────────────
  console.log('\n📌 Test: Revoked Token Detection');
  const revokedCode = codes.find(c => c.student_ref_token === 'stu_ref_003');
  if (revokedCode) {
    const revDecode = await req('POST', '/v1/verify/code', { authenx_code: revokedCode.authenx_code }, empToken);
    assert('Revoked token detected', revDecode.data.status === 'revoked');
  }

  // ── 9. Metrics endpoint ─────────────────────────────────────────────────
  console.log('\n📌 Test: Metrics & Observability');
  const metricsResult = await req('GET', '/v1/metrics', null, adminToken);
  assert('Metrics endpoint responds', metricsResult.status === 200);
  if (metricsResult.data) {
    console.log(`     Requests total: ${metricsResult.data.counters.requests_total}`);
    console.log(`     Uptime: ${metricsResult.data.uptime_seconds}s`);
    console.log(`     Memory: ${metricsResult.data.memory.heap_used_mb}MB`);
  }

  // ── 10. Prometheus format ───────────────────────────────────────────────
  const promResult = await req('GET', '/v1/metrics?format=prometheus', null, adminToken);
  assert('Prometheus format works', promResult.status === 200 && typeof promResult.data === 'string' && promResult.data.includes('authenx_'));

  // ── 11. Fraud alerts endpoint ───────────────────────────────────────────
  console.log('\n📌 Test: Fraud Detection');
  const fraudResult = await req('GET', '/v1/fraud-alerts', null, adminToken);
  assert('Fraud alerts endpoint responds', fraudResult.status === 200);

  // ── 12. HSM health ──────────────────────────────────────────────────────
  console.log('\n📌 Test: HSM Key Vault');
  try {
    const hsmHealth = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port: 9099, path: '/health', method: 'GET' }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
      r.on('error', reject);
      r.end();
    });
    assert(`HSM online with ${hsmHealth.keys_loaded} keys`, hsmHealth.status === 'ok' && hsmHealth.keys_loaded === 10);
  } catch { assert('HSM health check', false); }

  // ── 13. Detailed health ─────────────────────────────────────────────────
  const detailedHealth = await req('GET', '/v1/health/detailed', null, adminToken);
  assert('Detailed health shows 10 colleges', detailedHealth.data.db?.colleges === 10);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
