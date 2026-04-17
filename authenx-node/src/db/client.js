'use strict';
/**
 * AuthenX Database Client
 * Async PostgreSQL pool wrapper using pg
 */

const { Pool } = require('pg');

if (process.env.NODE_ENV === 'production' && !process.env.AUTHENX_PG_PASSWORD) {
  throw new Error('AUTHENX_PG_PASSWORD is required in production');
}

const pool = new Pool({
  host:     process.env.AUTHENX_PG_HOST     || 'localhost',
  port:     Number(process.env.AUTHENX_PG_PORT)  || 5432,
  user:     process.env.AUTHENX_PG_USER     || 'postgres',
  password: process.env.AUTHENX_PG_PASSWORD || '',
  database: process.env.AUTHENX_PG_DATABASE || 'authenx',
  max:      10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

/** Run a SELECT and return all rows */
async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

/** Run a SELECT and return first row or null */
async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

/** Run INSERT/UPDATE/DELETE */
async function run(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

/**
 * Run multiple statements inside a transaction.
 * fn receives a dbClient object with { run, query, queryOne } bound to the
 * transaction connection — callers must use dbClient.run() not module-level run().
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dbClient = {
      run:      (sql, params = []) => client.query(sql, params),
      query:    async (sql, params = []) => { const r = await client.query(sql, params); return r.rows; },
      queryOne: async (sql, params = []) => { const r = await client.query(sql, params); return r.rows[0] || null; },
    };
    const result = await fn(dbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Initialize DB: apply schema (CREATE TABLE IF NOT EXISTS is idempotent) */
async function initDb() {
  const { SQL_SCHEMA } = require('./schema.js');
  const client = await pool.connect();
  try {
    await client.query(SQL_SCHEMA);
  } finally {
    client.release();
  }
}

module.exports = { query, queryOne, run, transaction, initDb, pool };
