'use strict';
const { queryOne } = require('../db/client.js');
const { verifyPassword, signJwt } = require('../crypto/index.js');

/**
 * POST /v1/auth/login
 * Body: { email, password }
 * Returns: { token, user }
 */
async function login(req, res, body) {
  const { email, password } = body;
  if (!email || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'email and password are required' }));
  }

  const user = queryOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid credentials' }));
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid credentials' }));
  }

  const token = signJwt({
    user_id:    user.id,
    email:      user.email,
    role:       user.role,
    college_id: user.college_id,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    token,
    user: { id: user.id, email: user.email, role: user.role, college_id: user.college_id }
  }));
}

module.exports = { login };
