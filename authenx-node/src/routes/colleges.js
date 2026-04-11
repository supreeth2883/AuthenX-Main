'use strict';
const { query, queryOne, run } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
const {
  generateEd25519KeyPair,
  encryptSecret,
  hashPassword,
  generateTempPassword,
} = require('../crypto/index.js');
const crypto = require('node:crypto');

/** GET /v1/colleges — list all active colleges */
function listColleges(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const colleges = query(`
    SELECT id, name, short_code, public_key_hex, connector_url, active, created_at
    FROM colleges WHERE active = 1 ORDER BY name
  `);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ colleges }));
}

/** GET /v1/colleges/:id — single college details */
function getCollege(req, res, id) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = queryOne(`
    SELECT id, name, short_code, public_key_hex, connector_url, active, created_at
    FROM colleges WHERE id = ?
  `, [id]);

  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ college }));
}

/** POST /v1/colleges — register a new college (super_admin only) */
function createCollege(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, 'super_admin', res)) return;

  const { name, short_code, public_key_hex, connector_url } = body;
  if (!name || !short_code || !public_key_hex || !connector_url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'name, short_code, public_key_hex, connector_url required' }));
  }

  const existing = queryOne('SELECT id FROM colleges WHERE short_code = ?', [short_code]);
  if (existing) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College with this short_code already exists' }));
  }

  const id = crypto.randomUUID();
  const shared_secret = crypto.randomBytes(32).toString('hex');

  run(`INSERT INTO colleges (id, name, short_code, public_key_hex, connector_url, shared_secret)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, short_code.toUpperCase(), public_key_hex, connector_url, shared_secret]);

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'College registered',
    college_id: id,
    shared_secret,   // shown only once — college stores this for connector auth
  }));
}

// ─── PostgreSQL Provisioning ──────────────────────────────────────────────────
/**
 * Attempt to create a PostgreSQL database + role for the college.
 * Requires PG_PROVISION_HOST (and PG_PROVISION_USER / PG_PROVISION_PASSWORD)
 * env vars to be set.  If pg is not installed or the connection fails,
 * metadata is stored anyway and provisioned=0.
 */
async function provisionCollegePostgres(college_id, short_code) {
  // Derive safe DB name / user from short_code
  const safe      = short_code.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const db_name   = `authenx_${safe}`;
  const db_user   = `authenx_${safe}_user`;
  const db_password     = crypto.randomBytes(20).toString('hex');
  const db_password_enc = encryptSecret(db_password);

  let provisioned = 0;
  let provisioned_at = null;

  if (process.env.PG_PROVISION_HOST) {
    try {
      const { Client } = require('pg'); // optional dep — OK if missing
      const admin = new Client({
        host:     process.env.PG_PROVISION_HOST,
        port:     Number(process.env.PG_PROVISION_PORT) || 5432,
        database: 'postgres',
        user:     process.env.PG_PROVISION_USER     || 'postgres',
        password: process.env.PG_PROVISION_PASSWORD || '',
        connectionTimeoutMillis: 5000,
      });
      await admin.connect();
      // Create role first (ignore if exists)
      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${db_user}') THEN
             EXECUTE 'CREATE ROLE "${db_user}" LOGIN PASSWORD ''${db_password}''';
           END IF;
         END $$`
      );
      // Create database (ignore if exists)
      const dbExists = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = '${db_name}'`
      );
      if (dbExists.rowCount === 0) {
        await admin.query(`CREATE DATABASE "${db_name}" OWNER "${db_user}"`);
      }
      await admin.query(
        `GRANT ALL PRIVILEGES ON DATABASE "${db_name}" TO "${db_user}"`
      );
      await admin.end();
      provisioned    = 1;
      provisioned_at = new Date().toISOString();
    } catch (err) {
      // Non-fatal: store metadata, mark not provisioned
      console.warn('[onboard] PostgreSQL provisioning skipped:', err.message);
    }
  }

  run(
    `INSERT OR REPLACE INTO college_postgres_provisioning
       (college_id, db_name, db_user, db_password_enc, provisioned, provisioned_at)
     VALUES (?,?,?,?,?,?)`,
    [college_id, db_name, db_user, db_password_enc, provisioned, provisioned_at]
  );

  return { db_name, db_user, provisioned: !!provisioned };
}

// ─── POST /v1/colleges/onboard ────────────────────────────────────────────────
/**
 * Super-admin-only endpoint that performs the full college onboarding in one
 * atomic call:
 *   A) Creates the college record
 *   B) Generates + stores Ed25519 keypair
 *   C) Creates college-admin login credentials (hashed password)
 *   D) Provisions default PostgreSQL storage
 *   E) Stores connector_config + field_mapping metadata
 */
async function onboardCollege(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, 'super_admin', res)) return;

  const { name, short_code, admin_email, connector_url, connector_config } = body;

  // ── Validate required fields ──────────────────────────────────────────────
  if (!name || !short_code || !admin_email || !connector_url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'name, short_code, admin_email, and connector_url are required',
    }));
  }
  if (!admin_email.includes('@')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid admin_email format' }));
  }

  const sc = short_code.toUpperCase().slice(0, 10);

  // ── Uniqueness checks ─────────────────────────────────────────────────────
  const existingCode = queryOne('SELECT id FROM colleges WHERE short_code = ?', [sc]);
  if (existingCode) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: `A college with short_code '${sc}' already exists`,
    }));
  }

  const existingEmail = queryOne(
    "SELECT id FROM users WHERE email = ? AND role = 'college_admin'",
    [admin_email.toLowerCase()]
  );
  if (existingEmail) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: `A college admin account already exists for '${admin_email}'`,
    }));
  }

  // ── A) Generate identifiers ───────────────────────────────────────────────
  const college_id    = crypto.randomUUID();
  const shared_secret = crypto.randomBytes(32).toString('hex');
  const connector_port = Number(connector_config?.port || connector_config?.connector_port) || 9000;

  // ── B) Ed25519 keypair ────────────────────────────────────────────────────
  const { publicKeyHex, privateKeyHex } = generateEd25519KeyPair();
  const private_key_enc = encryptSecret(privateKeyHex);

  // ── C) College-admin credentials ─────────────────────────────────────────
  const admin_temp_password = generateTempPassword();
  const password_hash       = await hashPassword(admin_temp_password);

  try {
    // ── Persist college ───────────────────────────────────────────────────
    run(
      `INSERT INTO colleges
         (id, name, short_code, admin_email, public_key_hex, connector_url, connector_port, shared_secret)
       VALUES (?,?,?,?,?,?,?,?)`,
      [college_id, name, sc, admin_email.toLowerCase(), publicKeyHex, connector_url, connector_port, shared_secret]
    );

    // ── Persist keys ──────────────────────────────────────────────────────
    run(
      `INSERT INTO college_keys (college_id, public_key_hex, private_key_enc)
       VALUES (?,?,?)`,
      [college_id, publicKeyHex, private_key_enc]
    );

    // ── Persist college admin user ────────────────────────────────────────
    run(
      `INSERT INTO users (id, email, password_hash, role, college_id, must_change_password)
       VALUES (?,?,?,?,?,?)`,
      [crypto.randomUUID(), admin_email.toLowerCase(), password_hash, 'college_admin', college_id, 1]
    );

    // ── D) PostgreSQL provisioning (non-fatal) ────────────────────────────
    await provisionCollegePostgres(college_id, sc);

    // ── E) Connector config metadata ──────────────────────────────────────
    if (connector_config) {
      const { field_mapping, ...cfgWithoutMapping } = connector_config;
      run(
        `INSERT OR REPLACE INTO college_connector_configs
           (college_id, erp_type, connector_url, connector_config_json, field_mapping_json, onboarding_completed)
         VALUES (?,?,?,?,?,1)`,
        [
          college_id,
          connector_config.db_type || 'unknown',
          connector_url,
          JSON.stringify(cfgWithoutMapping),
          field_mapping ? JSON.stringify(field_mapping) : null,
        ]
      );
    }
  } catch (err) {
    console.error('[onboard] DB error:', err.message);
    // Attempt rollback by deleting the partial college record
    try { run('DELETE FROM college_keys WHERE college_id = ?', [college_id]); } catch {}
    try { run('DELETE FROM users WHERE college_id = ?', [college_id]); } catch {}
    try { run('DELETE FROM colleges WHERE id = ?', [college_id]); } catch {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Failed to onboard college: ' + err.message }));
  }

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    college_id,
    college_name:        name,
    short_code:          sc,
    admin_email:         admin_email.toLowerCase(),
    connector_url,
    connector_port,
    public_key_hex:      publicKeyHex,
    admin_temp_password, // shown only once — must be shared with the college admin
    shared_secret,       // for connector HMAC authentication
  }));
}

module.exports = { listColleges, getCollege, createCollege, onboardCollege };
