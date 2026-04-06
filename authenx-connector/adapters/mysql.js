'use strict';
/**
 * AuthenX Connector — MySQL / MariaDB Adapter
 * Requires: npm install mysql2
 *
 * Supports: MySQL 5.7+, MySQL 8.x, MariaDB 10.x+
 * Uses connection pooling for concurrent verification requests.
 * Connects read-only — never writes to the college database.
 *
 * Installation:
 *   cd authenx-connector && npm install mysql2
 */

let mysql2 = null;
let pool = null;

function loadMysql2() {
  if (mysql2) return mysql2;
  try {
    mysql2 = require('mysql2/promise');
    return mysql2;
  } catch (err) {
    throw new Error(
      'mysql2 package not found. Install it with: npm install mysql2\n' +
      'Then restart the connector.'
    );
  }
}

async function connect(dbConfig) {
  const m = loadMysql2();
  if (pool) return;

  pool = m.createPool({
    host:               dbConfig.host     || '127.0.0.1',
    port:               dbConfig.port     || 3306,
    user:               dbConfig.user,
    password:           dbConfig.password,
    database:           dbConfig.database,
    charset:            'utf8mb4',
    connectionLimit:    dbConfig.pool_size || 5,
    connectTimeout:     10_000,
    acquireTimeout:     10_000,
    waitForConnections: true,
    queueLimit:         50,
    enableKeepAlive:    true,
    keepAliveInitialDelay: 10_000,
    ssl:                dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
  });

  // Verify connection on startup
  const conn = await pool.getConnection();
  conn.release();
  console.log(`[mysql-adapter] Connected to ${dbConfig.host}:${dbConfig.port || 3306}/${dbConfig.database}`);
}

async function fetchStudent({ table, ref_column, student_ref_token }) {
  if (!pool) throw new Error('MySQL adapter not connected. Call connect() first.');
  const sql = `SELECT * FROM \`${table}\` WHERE \`${ref_column}\` = ? LIMIT 1`;
  const [rows] = await pool.execute(sql, [student_ref_token]);
  return rows[0] || null;
}

async function testConnection(dbConfig) {
  try {
    await connect(dbConfig);
    const [rows] = await pool.execute('SELECT 1 AS ok');
    if (rows[0]?.ok === 1) return { ok: true, message: 'MySQL connection successful' };
    return { ok: false, message: 'Unexpected response from MySQL' };
  } catch (err) {
    pool = null;
    return { ok: false, message: err.message };
  }
}

async function listTables(dbConfig) {
  await connect(dbConfig);
  const [rows] = await pool.execute('SHOW TABLES');
  return rows.map(r => Object.values(r)[0]);
}

async function listColumns(dbConfig, tableName) {
  await connect(dbConfig);
  const [rows] = await pool.execute(`DESCRIBE \`${tableName}\``);
  return rows.map(r => ({ name: r.Field, type: r.Type }));
}

module.exports = { connect, fetchStudent, testConnection, listTables, listColumns };
