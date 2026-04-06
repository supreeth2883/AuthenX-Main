'use strict';
/**
 * AuthenX Connector — Microsoft SQL Server Adapter
 * Requires: npm install mssql
 *
 * Supports: SQL Server 2012+, Azure SQL Database
 * Common in: SAP ERP, Microsoft Dynamics, campus management systems on Windows.
 * Connects read-only — never writes to the college database.
 *
 * Installation:
 *   cd authenx-connector && npm install mssql
 */

let mssql = null;
let pool = null;

function loadMssql() {
  if (mssql) return mssql;
  try {
    mssql = require('mssql');
    return mssql;
  } catch (err) {
    throw new Error(
      'mssql package not found. Install it with: npm install mssql\n' +
      'Then restart the connector.'
    );
  }
}

async function connect(dbConfig) {
  if (pool) return;
  const sql = loadMssql();

  const config = {
    server:   dbConfig.host     || 'localhost',
    port:     dbConfig.port     || 1433,
    user:     dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    options: {
      encrypt:                dbConfig.ssl !== false,
      trustServerCertificate: dbConfig.trust_cert !== false,
      enableArithAbort:       true,
      requestTimeout:         10_000,
      connectionTimeout:      15_000,
    },
    pool: {
      max:  dbConfig.pool_size || 5,
      min:  0,
      idleTimeoutMillis: 30_000,
    },
  };

  pool = await sql.connect(config);
  console.log(`[mssql-adapter] Connected to ${dbConfig.host}\\${dbConfig.database}`);
}

async function fetchStudent({ table, ref_column, student_ref_token, schema = 'dbo' }) {
  if (!pool) throw new Error('MSSQL adapter not connected. Call connect() first.');
  const sql = loadMssql();
  const result = await pool
    .request()
    .input('ref', sql.NVarChar(255), student_ref_token)
    .query(`SELECT TOP 1 * FROM [${schema}].[${table}] WHERE [${ref_column}] = @ref`);
  return result.recordset[0] || null;
}

async function testConnection(dbConfig) {
  try {
    await connect(dbConfig);
    const sql = loadMssql();
    const result = await pool.request().query('SELECT 1 AS ok');
    if (result.recordset[0]?.ok === 1) return { ok: true, message: 'SQL Server connection successful' };
    return { ok: false, message: 'Unexpected response from SQL Server' };
  } catch (err) {
    pool = null;
    return { ok: false, message: err.message };
  }
}

async function listTables(dbConfig) {
  await connect(dbConfig);
  const schema = dbConfig.schema || 'dbo';
  const result = await pool.request().query(
    `SELECT TABLE_NAME as name FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = '${schema}'
     ORDER BY TABLE_NAME`
  );
  return result.recordset.map(r => r.name);
}

async function listColumns(dbConfig, tableName) {
  await connect(dbConfig);
  const schema = dbConfig.schema || 'dbo';
  const result = await pool.request().query(
    `SELECT COLUMN_NAME as name, DATA_TYPE as type
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${tableName}'
     ORDER BY ORDINAL_POSITION`
  );
  return result.recordset;
}

module.exports = { connect, fetchStudent, testConnection, listTables, listColumns };
