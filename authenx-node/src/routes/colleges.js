'use strict';
const { query, queryOne, run } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
const {
  generateEd25519KeyPair,
  encryptSecret,
  hashPassword,
  generateTempPassword,
} = require('../crypto/index.js');
const { seedDefaultStudentsForCollege } = require('../db/students.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** GET /v1/colleges — list all active colleges */
async function listColleges(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const rows = await query(`
    SELECT id, name, short_code, public_key_hex, connector_url, active, created_at
    FROM colleges WHERE active = 1 ORDER BY name
  `);

  // Only expose internal connector_url to admins
  const colleges = claims.role === 'super_admin'
    ? rows
    : rows.map(({ connector_url, ...rest }) => rest);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ colleges }));
}

/** GET /v1/colleges/:id — single college details */
async function getCollege(req, res, id) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = await queryOne(`
    SELECT id, name, short_code, public_key_hex, connector_url, active, created_at
    FROM colleges WHERE id = $1
  `, [id]);

  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ college }));
}

/** POST /v1/colleges — register a new college (super_admin only) */
async function createCollege(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, 'super_admin', res)) return;

  const { name, short_code, public_key_hex, connector_url } = body;
  if (!name || !short_code || !public_key_hex || !connector_url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'name, short_code, public_key_hex, connector_url required' }));
  }

  const existing = await queryOne('SELECT id FROM colleges WHERE short_code = $1', [short_code]);
  if (existing) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College with this short_code already exists' }));
  }

  const id = crypto.randomUUID();
  const shared_secret = crypto.randomBytes(32).toString('hex');

  await run(`INSERT INTO colleges (id, name, short_code, public_key_hex, connector_url, shared_secret)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, name, short_code.toUpperCase(), public_key_hex, connector_url, shared_secret]);

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'College registered',
    college_id: id,
    shared_secret,   // shown only once — college stores this for connector auth
  }));
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
  const existingCode = await queryOne('SELECT id FROM colleges WHERE short_code = $1', [sc]);
  if (existingCode) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: `A college with short_code '${sc}' already exists`,
    }));
  }

  const existingEmail = await queryOne(
    "SELECT id FROM users WHERE email = $1 AND role = 'college_admin'",
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
    await run(
      `INSERT INTO public.colleges
         (id, name, short_code, admin_email, public_key_hex, connector_url, connector_port, shared_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [college_id, name, sc, admin_email.toLowerCase(), publicKeyHex, connector_url, connector_port, shared_secret]
    );

    // ── Persist keys ──────────────────────────────────────────────────────
    await run(
      `INSERT INTO college_keys (college_id, public_key_hex, private_key_enc)
       VALUES ($1, $2, $3)`,
      [college_id, publicKeyHex, private_key_enc]
    );

    try {
      const hsmKeysDir = path.join(process.cwd(), '..', 'authenx-hsm', 'keys');
      if (!fs.existsSync(hsmKeysDir)) {
        fs.mkdirSync(hsmKeysDir, { recursive: true });
      }
      fs.writeFileSync(path.join(hsmKeysDir, `${college_id}.json`), JSON.stringify({
        college_id,
        private_key_hex: privateKeyHex,
        public_key_hex: publicKeyHex,
        version: 1,
        created_at: new Date().toISOString(),
      }, null, 2));
      console.log(`HSM key created: ${college_id}`);
    } catch (keySyncErr) {
      console.warn('[onboard] HSM key file sync skipped:', keySyncErr.message);
    }

    // ── Persist college admin user ────────────────────────────────────────
    await run(
      `INSERT INTO users (id, email, password_hash, role, college_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), admin_email.toLowerCase(), password_hash, 'college_admin', college_id, 1]
    );

    // ── D) Seed shared ERP students table (erp.students) in central PostgreSQL ──
    try {
      await seedDefaultStudentsForCollege(college_id);
    } catch (seedErr) {
      console.warn('[onboard] shared student seed skipped:', seedErr.message);
    }

    // ── E) Connector config metadata ──────────────────────────────────────
    if (connector_config) {
      const { field_mapping, ...cfgWithoutMapping } = connector_config;
      await run(
        `INSERT INTO college_connector_configs
           (college_id, erp_type, connector_url, connector_config_json, field_mapping_json, onboarding_completed)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (college_id) DO UPDATE SET
           erp_type = EXCLUDED.erp_type,
           connector_url = EXCLUDED.connector_url,
           connector_config_json = EXCLUDED.connector_config_json,
           field_mapping_json = EXCLUDED.field_mapping_json,
           onboarding_completed = 1,
           updated_at = NOW()`,
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
    try { await run('DELETE FROM college_keys WHERE college_id = $1', [college_id]); } catch {}
    try { await run('DELETE FROM users WHERE college_id = $1', [college_id]); } catch {}
    try { await run('DELETE FROM public.colleges WHERE id = $1', [college_id]); } catch {}
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
