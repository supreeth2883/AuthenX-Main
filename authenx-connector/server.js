'use strict';

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = Number(process.env.CONNECTOR_PORT || 9000);

const pool = new Pool({
  host: process.env.AUTHENX_PG_HOST || 'localhost',
  port: Number(process.env.AUTHENX_PG_PORT || 5432),
  user: process.env.AUTHENX_PG_USER || 'postgres',
  password: process.env.AUTHENX_PG_PASSWORD || 'Postgres@123',
  database: process.env.AUTHENX_PG_DATABASE || 'postgres',
});

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/verify', async (req, res) => {
  const { student_ref_token, college_id } = req.body || {};

  console.log(
    `[connector] /verify called student_ref_token=${student_ref_token || '<missing>'} college_id=${college_id || '<missing>'}`
  );

  if (!student_ref_token || !college_id) {
    return res.status(400).json({ error: 'student_ref_token and college_id are required' });
  }

  try {
    const result = await pool.query(
      `SELECT college_id, student_id, full_name, dept_name, degree, issue_date, credential_type, cgpa, grad_year, student_status
       FROM erp.students
       WHERE student_id = $1 AND college_id = $2
       LIMIT 1`,
      [String(student_ref_token), String(college_id)]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Student not found' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[connector] /verify failed:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[connector] running on http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
