#!/usr/bin/env node
'use strict';
/**
 * Seed script for the CVR College data in the central PostgreSQL erp.students table.
 * Safe to run multiple times — student rows use ON CONFLICT (college_id, student_id).
 * Also sets a known password for the CVR admin account.
 *
 * PostgreSQL connection uses the same env vars as start-backend-stack.ps1:
 *   AUTHENX_PG_HOST     (default: localhost)
 *   AUTHENX_PG_PORT     (default: 5432)
 *   AUTHENX_PG_USER     (default: postgres)
 *   AUTHENX_PG_PASSWORD (default: Postgres@123)
 *   AUTHENX_PG_DATABASE (default: postgres)
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
const { CVR_COLLEGE_ID } = require('./src/mock-erp/cvr-erp.js');
const crypto = require('node:crypto');

(async () => {
  // ── 1. Seed CVR students into PostgreSQL erp.students ───────────────────
  console.log('CVR Central PostgreSQL — seeding student records…');
  console.log(`  host: ${process.env.AUTHENX_PG_HOST || 'localhost'}:${process.env.AUTHENX_PG_PORT || 5432}`);
  console.log(`  db:   ${process.env.AUTHENX_PG_DATABASE || 'postgres'}`);

  let result;
  try {
    await initDb();
    await run(
      `INSERT INTO public.colleges (id, name, short_code, public_key_hex, connector_url, shared_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        CVR_COLLEGE_ID,
        'CVR College of Engineering',
        'CVRH',
        '',
        'mock',
        crypto.randomBytes(32).toString('hex'),
      ]
    );
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
    host:     process.env.AUTHENX_PG_HOST     || 'localhost',
    port:     Number(process.env.AUTHENX_PG_PORT) || 5432,
    user:     process.env.AUTHENX_PG_USER     || 'postgres',
    password: process.env.AUTHENX_PG_PASSWORD || 'Postgres@123',
    database: process.env.AUTHENX_PG_DATABASE || 'postgres',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const rows = (await client.query(
    'SELECT college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status FROM erp.students WHERE college_id = $1 ORDER BY student_id',
    [CVR_COLLEGE_ID]
  )).rows;
  await client.end();

  console.log('\nCurrent students in central postgres.erp.students:');
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
