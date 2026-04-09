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
