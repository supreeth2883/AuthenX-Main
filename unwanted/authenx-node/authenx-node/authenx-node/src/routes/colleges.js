'use strict';
const { query, queryOne, run } = require('../db/client.js');
const { requireAuth, requireRole } = require('../middleware/auth.js');
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

module.exports = { listColleges, getCollege, createCollege };
