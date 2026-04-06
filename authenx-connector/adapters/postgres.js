'use strict';
/**
 * AuthenX Connector — PostgreSQL Adapter
 * Requires: npm install pg
 *
 * Supports: PostgreSQL 12+
 * Uses pg Pool for connection reuse.
 * Connects read-only — never writes to the college database.
 *
 * Installation:
 *   cd authenx-connector && npm install pg
 */

let pg = null;
let pool = null;

function loadPg() {
  if (pg) return pg;
  try {
    pg = require('pg');
    return pg;
  } catch (err) {
    throw new Error(
      'pg package not found. Install it with: npm install pg\n' +
      'Then restart the connector.'
    );
  }
}

async function connect(dbConfig) {
  const { Pool } = loadPg();
  if (pool) return;

  pool = new Pool({
    host:                   dbConfig.host     || '127.0.0.1',
    port:                   dbConfig.port     || 5432,
    user:                   dbConfig.user,
    password:               dbConfig.password,
    database:               dbConfig.database,
    max:                    dbConfig.pool_size || 5,
    idleTimeoutMillis:      30_000,
    connectionTimeoutMillis: 10_000,
    ssl:                    dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
  });

  // Verify connection on startup
  const client = await pool.connect();
  client.release();
  console.log(`[postgres-adapter] Connected to ${dbConfig.host}:${dbConfig.port || 5432}/${dbConfig.database}`);
}

async function fetchStudent({ table, ref_column, student_ref_token, schema = 'public' }) {
  if (!pool) throw new Error('PostgreSQL adapter not connected. Call connect() first.');
  const sql = `SELECT * FROM "${schema}"."${table}" WHERE "${ref_column}" = $1 LIMIT 1`;
  const result = await pool.query(sql, [student_ref_token]);
  return result.rows[0] || null;
}

async function testConnection(dbConfig) {
  try {
    await connect(dbConfig);
    const result = await pool.query('SELECT 1 AS ok');
    if (result.rows[0]?.ok === 1) return { ok: true, message: 'PostgreSQL connection successful' };
    return { ok: false, message: 'Unexpected response from PostgreSQL' };
  } catch (err) {
    pool = null;
    return { ok: false, message: err.message };
  }
}

async function listTables(dbConfig) {
  await connect(dbConfig);
  const schema = dbConfig.schema || 'public';
  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [schema]
  );
  return result.rows.map(r => r.table_name);
}

async function listColumns(dbConfig, tableName) {
  await connect(dbConfig);
  const schema = dbConfig.schema || 'public';
  const result = await pool.query(
    `SELECT column_name as name, data_type as type
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, tableName]
  );
  return result.rows;
}

module.exports = { connect, fetchStudent, testConnection, listTables, listColumns };
