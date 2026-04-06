'use strict';
/**
 * AuthenX Wave 3 — E2E Test Suite
 * Tests DPDP Compliance (Privacy, Consent, Erasure, Data Access).
 */

const http = require('node:http');
const path = require('node:path');

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

// Self-clean MFA state
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
    if (body) {
      const bStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bStr);
      body = bStr;
    }
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
    r.setTimeout(10000, () => { r.destroy(); reject(new Error('Request timed out')); });
    if (body) r.write(body);
    r.end();
  });
}

function assert(label, condition) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.error(`  ❌ ${label}`); }
}

async function run() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  AuthenX Wave 3 — DPDP Compliance Suite');
  console.log('═══════════════════════════════════════════════\n');

  // Login
  const login = await req('POST', '/v1/auth/login', { email: 'recruiter@infosys.com', password: 'Employer@123' });
  const empToken = login.data.token;
  const adminLogin = await req('POST', '/v1/auth/login', { email: 'admin@authenx.in', password: 'Admin@123' });
  const adminToken = adminLogin.data.token;

  // --- Privacy Notice (Public) ---
  console.log('📌 Test: Privacy Notice');
  const notice = await req('GET', '/v1/privacy/notice');
  assert('Privacy notice returns DPDP policy', notice.status === 200 && notice.data.dpdp_act_reference);
  assert('Includes data processing purposes', notice.data.purposes && notice.data.purposes.length >= 3);
  assert('Includes data subject rights', notice.data.rights && notice.data.rights.access);
  if (notice.data.purposes) {
    console.log(`     Purposes: ${notice.data.purposes.map(p => p.code).join(', ')}`);
  }

  // --- Consent Management ---
  console.log('\n📌 Test: Consent Management');
  const grant = await req('POST', '/v1/privacy/consent', { purpose: 'credential_verification', scope: 'full' }, empToken);
  assert('Consent granted', grant.status === 200 && grant.data.consent_id);

  const grant2 = await req('POST', '/v1/privacy/consent', { purpose: 'analytics', scope: 'anonymized' }, empToken);
  assert('Multiple consents supported', grant2.status === 200);

  const consents = await req('GET', '/v1/privacy/consent', null, empToken);
  assert('Consent records retrievable', consents.status === 200 && consents.data.consents.length >= 2);
  console.log(`     Active consents: ${consents.data.consents.length}`);

  // Revoke one
  const revoke = await req('DELETE', '/v1/privacy/consent', { purpose: 'analytics' }, empToken);
  assert('Consent revocation works', revoke.status === 200 && revoke.data.status === 'revoked');

  // --- Data Access Request (DSAR) ---
  console.log('\n📌 Test: Data Access Request (DSAR)');
  const dsar = await req('GET', '/v1/privacy/data-access', null, empToken);
  assert('DSAR report generated', dsar.status === 200 && dsar.data.report_id);
  assert('DSAR includes DPDP notice', dsar.data.dpdp_notice && dsar.data.dpdp_notice.includes('Section 11'));
  assert('DSAR confirms zero PII', dsar.data.pii_stored && dsar.data.pii_stored.note.includes('ZERO'));
  assert('DSAR includes consent records', dsar.data.consent_records && dsar.data.consent_records.length >= 1);
  console.log(`     Report ID: ${dsar.data.report_id}`);
  console.log(`     PII stored: ${JSON.stringify(dsar.data.pii_stored.fields)}`);
  console.log(`     MFA enabled: ${dsar.data.mfa.enabled}`);

  // --- Data Retention Enforcement ---
  console.log('\n📌 Test: Data Retention Policy');
  const retention = await req('POST', '/v1/privacy/retention/enforce', null, adminToken);
  assert('Retention enforcement runs', retention.status === 200 && retention.data.retention_enforcement);
  if (retention.data.retention_enforcement) {
    const tables = Object.keys(retention.data.retention_enforcement);
    console.log(`     Tables enforced: ${tables.join(', ')}`);
  }

  // Non-admin cannot run retention
  const retentionFail = await req('POST', '/v1/privacy/retention/enforce', null, empToken);
  assert('Non-admin blocked from retention', retentionFail.status === 403);

  // --- Data Erasure (Right to be Forgotten) ---
  // Use a separate test user to avoid breaking other tests
  console.log('\n📌 Test: Data Erasure (Right to be Forgotten)');
  const testLogin = await req('POST', '/v1/auth/login', { email: 'hr@tcs.com', password: 'Employer@123' });
  const testToken = testLogin.data.token;

  // Grant consent first so it can be erased
  await req('POST', '/v1/privacy/consent', { purpose: 'test_purpose' }, testToken);

  const erasure = await req('POST', '/v1/privacy/erasure', { reason: 'User requested deletion' }, testToken);
  assert('Erasure request processed', erasure.status === 200 && erasure.data.status === 'completed');
  console.log(`     Erasure ID: ${erasure.data.request_id}`);

  // Verify consent was erased
  const postErasure = await req('GET', '/v1/privacy/consent', null, testToken);
  assert('Consent records erased', postErasure.status === 200 && postErasure.data.consents.length === 0);

  // --- Docker Configuration ---
  console.log('\n📌 Test: Docker Configuration');
  const fs = require('fs');
  assert('Dockerfile exists', fs.existsSync(path.join(__dirname, 'Dockerfile')));
  assert('Dockerfile.connector exists', fs.existsSync(path.join(__dirname, 'Dockerfile.connector')));
  assert('docker-compose.yml exists', fs.existsSync(path.join(__dirname, 'docker-compose.yml')));
  assert('.dockerignore exists', fs.existsSync(path.join(__dirname, '.dockerignore')));

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
