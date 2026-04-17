#!/usr/bin/env node
'use strict';
/**
 * Seed script for the CVR College mock ERP (PostgreSQL).
 * Safe to run multiple times — student rows use ON CONFLICT DO NOTHING.
 * Also sets a known password for the CVR admin account.
 *
 * PostgreSQL connection uses the same env vars as start-backend-stack.ps1:
 *   PG_PROVISION_HOST     (default: localhost)
 *   PG_PROVISION_PORT     (default: 5432)
 *   PG_PROVISION_USER     (default: postgres)
 *   PG_PROVISION_PASSWORD (default: Postgres@123)
 *   CVR_ERP_PG_DB         (default: postgres)
 *
 * Usage (from authenx-node/ directory):
 *   node mock-erp-cvr-seed.js
 *
 * Or with explicit credentials:
 *   PG_PROVISION_HOST=localhost PG_PROVISION_PASSWORD=secret node mock-erp-cvr-seed.js
 */

const { seed } = require('./src/mock-erp/cvr-erp.js');
const { hashPassword } = require('./src/crypto/index.js');
const { run, queryOne, initDb } = require('./src/db/client.js');

(async () => {
  // ── 1. Seed CVR students into PostgreSQL ─────────────────────────────────
  console.log('CVR Mock ERP (PostgreSQL) — seeding student records…');
  console.log(`  host: ${process.env.PG_PROVISION_HOST || 'localhost'}:${process.env.PG_PROVISION_PORT || 5432}`);
  console.log(`  db:   ${process.env.CVR_ERP_PG_DB || 'postgres'}`);

  let result;
  try {
    result = await seed();
  } catch (err) {
    console.error('\nPostgreSQL seed failed:', err.message);
    console.error('Make sure PostgreSQL is running and env vars are set correctly.');
    process.exit(1);
  }

  console.log(`\nStudents: ${result.seeded} new rows inserted, ${result.total - result.seeded} already existed.`);

  // Verify by reading back the table
  const { Client } = require('pg');
  const client = new Client({
    host:     process.env.PG_PROVISION_HOST     || 'localhost',
    port:     Number(process.env.PG_PROVISION_PORT) || 5432,
    user:     process.env.PG_PROVISION_USER     || 'postgres',
    password: process.env.PG_PROVISION_PASSWORD || 'Postgres@123',
    database: process.env.CVR_ERP_PG_DB         || 'postgres',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const rows = (await client.query(
    'SELECT student_id, full_name, dept_name, cgpa, grad_year, student_status FROM cvr_mock_erp_students ORDER BY student_id'
  )).rows;
  await client.end();

  console.log('\nCurrent students in mock ERP:');
  console.table(rows);

  // ── 2. Set a known password for the CVR admin account (main AuthenX DB) ──
  // This is idempotent — safe to rerun.
  await initDb();
  const cvrAdmin = await queryOne(
    "SELECT id FROM users WHERE email = 'cvradmin@authenx.in'"
  );
  if (cvrAdmin) {
    const hash = await hashPassword('CVRAdmin@123');
    await run(
      'UPDATE users SET password_hash = $1, must_change_password = 0 WHERE email = $2',
      [hash, 'cvradmin@authenx.in']
    );
    console.log('CVR admin credentials set (PostgreSQL main DB):');
    console.log('  email:    cvradmin@authenx.in');
    console.log('  password: CVRAdmin@123');
  } else {
    console.log('\n[warn] cvradmin@authenx.in not found in users table — skipping password step.');
    console.log('       Run college onboarding first, then re-run this seed.');
  }
})().catch(err => {
  console.error('Fatal seed error:', err.message);
  process.exit(1);
});
