'use strict';
/**
 * AuthenX Database Client
 * Wraps node:sqlite with helper methods
 */

const { DatabaseSync } = require('node:sqlite');
const { SQL_SCHEMA } = require('./schema.js');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'authenx.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  // Enable WAL mode for better concurrent read performance
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA foreign_keys=ON');
  _db.exec(SQL_SCHEMA);
  runMigrations(_db);
  return _db;
}

/** Add columns/tables that may not exist in older databases */
function runMigrations(db) {
  const existingCols = db.prepare("PRAGMA table_info(verification_tokens)").all().map(r => r.name);
  const addIfMissing = (col, def) => {
    if (!existingCols.includes(col)) {
      try { db.exec(`ALTER TABLE verification_tokens ADD COLUMN ${col} ${def}`); } catch {}
    }
  };
  addIfMissing('superseded_by',       'TEXT');
  addIfMissing('correction_token_id', 'TEXT');
  addIfMissing('verification_count',  'INTEGER NOT NULL DEFAULT 0');
  addIfMissing('last_verified_at',    'TEXT');
  addIfMissing('last_result',         'TEXT');

  // ── College registry sync migration ───────────────────────────────────────
  // If the DB was seeded before colleges/registry.json existed, it may contain
  // fallback college IDs/secrets that will not match connectors/HSM.
  // We sync by short_code and update FK references.
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const registryPath = path.join(process.cwd(), '..', 'colleges', 'registry.json');
    if (!fs.existsSync(registryPath)) return;

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!Array.isArray(registry) || registry.length === 0) return;

    db.exec('PRAGMA foreign_keys=OFF');
    for (const r of registry) {
      if (!r?.id || !r?.short_code) continue;

      const existing = db.prepare('SELECT id, short_code FROM colleges WHERE short_code = ?').get(r.short_code);
      if (!existing) {
        // Insert if missing
        db.prepare(`INSERT INTO colleges (id,name,short_code,public_key_hex,connector_url,shared_secret,active)
                    VALUES (?,?,?,?,?,?,1)`)
          .run(r.id, r.name, r.short_code, r.public_key_hex, r.connector_url, r.shared_secret);
        continue;
      }

      if (existing.id !== r.id) {
        const oldId = existing.id;
        // Update FK references first
        db.prepare('UPDATE users SET college_id = ? WHERE college_id = ?').run(r.id, oldId);
        db.prepare('UPDATE verification_tokens SET college_id = ? WHERE college_id = ?').run(r.id, oldId);
        db.prepare('UPDATE disclosure_policies SET college_id = ? WHERE college_id = ?').run(r.id, oldId);
        try { db.prepare('UPDATE college_connector_configs SET college_id = ? WHERE college_id = ?').run(r.id, oldId); } catch {}

        // Update primary key + fields
        db.prepare(`UPDATE colleges SET
                      id = ?,
                      name = ?,
                      public_key_hex = ?,
                      connector_url = ?,
                      shared_secret = ?,
                      active = 1
                    WHERE id = ?`)
          .run(r.id, r.name, r.public_key_hex, r.connector_url, r.shared_secret, oldId);
      } else {
        // Same ID: keep fields in sync
        db.prepare(`UPDATE colleges SET
                      name = ?,
                      public_key_hex = ?,
                      connector_url = ?,
                      shared_secret = ?,
                      active = 1
                    WHERE id = ?`)
          .run(r.name, r.public_key_hex, r.connector_url, r.shared_secret, r.id);
      }
    }
  } catch {
    // Non-fatal; keep server running even if registry sync fails.
  } finally {
    try { db.exec('PRAGMA foreign_keys=ON'); } catch {}
  }
}

/** Run a SELECT and return all rows */
function query(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/** Run a SELECT and return first row or null */
function queryOne(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params) || null;
}

/** Run INSERT/UPDATE/DELETE */
function run(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

/** Run multiple statements inside a transaction */
function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { getDb, query, queryOne, run, transaction };
