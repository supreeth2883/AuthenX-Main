'use strict';
/**
 * AuthenX Connector — SQLite Adapter
 * Uses Node 22 built-in DatabaseSync. Zero npm dependencies.
 * Ideal for: demos, pilots, small colleges with existing SQLite databases.
 */

const { DatabaseSync } = require('node:sqlite');
const { resolve } = require('node:path');

let _db = null;
let _dbPath = null;

function connect(dbConfig) {
  const dbPath = dbConfig.path
    ? resolve(process.cwd(), dbConfig.path)
    : resolve(__dirname, '../connector.db');

  if (_db && _dbPath === dbPath) return; // already connected

  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;

  // Tuning for concurrent reads
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA busy_timeout=5000');
  _db.exec('PRAGMA synchronous=NORMAL');

  console.log(`[sqlite-adapter] Connected to ${dbPath}`);
}

function query(sql, params = []) {
  if (!_db) throw new Error('SQLite adapter not connected. Call connect() first.');
  const stmt = _db.prepare(sql);
  return stmt.get(...params);
}

function queryAll(sql, params = []) {
  if (!_db) throw new Error('SQLite adapter not connected. Call connect() first.');
  const stmt = _db.prepare(sql);
  return stmt.all(...params);
}

async function fetchStudent({ table, ref_column, student_ref_token }) {
  const row = query(
    `SELECT * FROM "${table}" WHERE "${ref_column}" = ? LIMIT 1`,
    [student_ref_token]
  );
  return row || null;
}

async function testConnection(dbConfig) {
  try {
    connect(dbConfig);
    query('SELECT 1');
    return { ok: true, message: 'SQLite connection successful' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function listTables(dbConfig) {
  connect(dbConfig);
  const rows = queryAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return rows.map(r => r.name);
}

async function listColumns(dbConfig, tableName) {
  connect(dbConfig);
  const rows = queryAll(`PRAGMA table_info("${tableName}")`);
  return rows.map(r => ({ name: r.name, type: r.type }));
}

module.exports = { connect, fetchStudent, testConnection, listTables, listColumns };
