'use strict';
const { verifyJwt } = require('../crypto/index.js');

/** Extract and verify JWT from Authorization: Bearer <token> header */
function requireAuth(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    return null;
  }
  try {
    const token = authHeader.slice(7);
    return verifyJwt(token);
  } catch (err) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return null;
  }
}

/** Require a specific role (or one of many roles) */
function requireRole(claims, roles, res) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(claims.role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Role '${claims.role}' is not permitted. Required: ${allowed.join(', ')}` }));
    return false;
  }
  return true;
}

module.exports = { requireAuth, requireRole };
