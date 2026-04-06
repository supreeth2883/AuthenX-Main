'use strict';
const crypto = require('node:crypto');
const { queryOne, query, run } = require('../db/client.js');
const { verifyPassword, signJwt, generateRefreshToken, hashRefreshToken, encryptCode, decryptCode } = require('../crypto/index.js');
const { sanitizeObject, isValidEmail } = require('../middleware/validation.js');
const { logSecurity } = require('../middleware/logger.js');
const { generateSecret, verifyTOTP, generateOtpAuthUri, generateBackupCodes } = require('../middleware/totp.js');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
const REFRESH_TOKEN_DAYS = 7;

/** Log a security event to the immutable security_events table */
function logSecurityEvent(eventType, { actorId, actorEmail, targetId, ip, details }) {
  run(`INSERT INTO security_events (id, event_type, actor_id, actor_email, target_id, ip_address, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), eventType, actorId || null, actorEmail || null, targetId || null, ip || null, details || null]);
}

/** Check if account is locked due to too many failed attempts */
function isAccountLocked(email) {
  const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const recentFailures = query(
    `SELECT COUNT(*) as cnt FROM login_attempts 
     WHERE email = ? AND success = 0 AND created_at > ?`, [email, cutoff]
  );
  return (recentFailures[0]?.cnt || 0) >= MAX_LOGIN_ATTEMPTS;
}

/** Get remaining login attempts before lockout */
function getRemainingAttempts(email) {
  const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const recentFailures = query(
    `SELECT COUNT(*) as cnt FROM login_attempts 
     WHERE email = ? AND success = 0 AND created_at > ?`, [email, cutoff]
  );
  return Math.max(0, MAX_LOGIN_ATTEMPTS - (recentFailures[0]?.cnt || 0));
}

/** Record a login attempt */
function recordLoginAttempt(email, ip, success) {
  run(`INSERT INTO login_attempts (id, email, ip_address, success) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), email, ip, success ? 1 : 0]);
}

/**
 * POST /v1/auth/login
 * Body: { email, password }
 * Returns: { token, refresh_token, user }
 */
async function login(req, res, body) {
  body = sanitizeObject(body);
  const { email, password } = body;
  const ip = req.socket.remoteAddress || 'unknown';

  if (!email || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'email and password are required' }));
  }

  if (!isValidEmail(email)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid email format' }));
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check if account is locked
  if (isAccountLocked(normalizedEmail)) {
    logSecurity('account_locked_attempt', { email: normalizedEmail, ip });
    logSecurityEvent('login_locked', { actorEmail: normalizedEmail, ip, details: `Account locked after ${MAX_LOGIN_ATTEMPTS} failed attempts` });
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: `Account is temporarily locked due to too many failed login attempts. Please try again after ${LOCKOUT_MINUTES} minutes.`,
      locked_until: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString(),
    }));
  }

  const user = queryOne('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    recordLoginAttempt(normalizedEmail, ip, false);
    logSecurityEvent('login_failed', { actorEmail: normalizedEmail, ip, details: 'User not found' });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Invalid credentials',
      remaining_attempts: getRemainingAttempts(normalizedEmail),
    }));
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    recordLoginAttempt(normalizedEmail, ip, false);
    const remaining = getRemainingAttempts(normalizedEmail);
    logSecurity('login_failed', { email: normalizedEmail, ip, remaining });
    logSecurityEvent('login_failed', { actorId: user.id, actorEmail: normalizedEmail, ip, details: `Invalid password. ${remaining} attempts remaining.` });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Invalid credentials',
      remaining_attempts: remaining,
    }));
  }

  // Success — clear lockout window by recording success
  recordLoginAttempt(normalizedEmail, ip, true);

  // Check if MFA is enabled
  const mfa = queryOne('SELECT * FROM mfa_secrets WHERE user_id = ? AND enabled = 1', [user.id]);
  if (mfa) {
    // Issue a temporary MFA pending token (5 min expiry)
    const mfaToken = signJwt({ user_id: user.id, email: user.email, mfa_pending: true }, 300);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mfa_required: true, mfa_token: mfaToken }));
  }

  // Generate short-lived access token (15 min)
  const token = signJwt({
    user_id:    user.id,
    email:      user.email,
    role:       user.role,
    college_id: user.college_id,
  });

  // Generate refresh token (7 days)
  const rawRefreshToken = generateRefreshToken();
  const refreshHash = hashRefreshToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  run(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), user.id, refreshHash, expiresAt]);

  logSecurityEvent('login_success', { actorId: user.id, actorEmail: normalizedEmail, ip });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    token,
    refresh_token: rawRefreshToken,
    expires_in: 900, // 15 minutes
    user: { id: user.id, email: user.email, role: user.role, college_id: user.college_id }
  }));
}

/**
 * POST /v1/auth/refresh
 * Body: { refresh_token }
 * Returns: { token, expires_in }
 */
function refreshAuth(req, res, body) {
  const { refresh_token } = body;
  if (!refresh_token) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'refresh_token is required' }));
  }

  const tokenHash = hashRefreshToken(refresh_token);
  const record = queryOne(
    `SELECT rt.*, u.email, u.role, u.college_id FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = ? AND rt.revoked = 0`, [tokenHash]
  );

  if (!record) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid or expired refresh token' }));
  }

  if (new Date(record.expires_at) < new Date()) {
    run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [record.id]);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Refresh token has expired. Please login again.' }));
  }

  // Issue new short-lived access token
  const token = signJwt({
    user_id:    record.user_id,
    email:      record.email,
    role:       record.role,
    college_id: record.college_id,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token, expires_in: 900 }));
}

/**
 * POST /v1/auth/logout
 * Invalidates the refresh token (session invalidation).
 * Body: { refresh_token }
 */
function logout(req, res, body) {
  const { refresh_token } = body;
  if (!refresh_token) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'refresh_token is required' }));
  }

  const tokenHash = hashRefreshToken(refresh_token);
  run('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [tokenHash]);

  const ip = req.socket.remoteAddress || 'unknown';
  logSecurityEvent('logout', { ip, details: 'Refresh token revoked' });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Logged out successfully' }));
}

/**
 * POST /v1/auth/mfa/verify
 * Exchange MFA token + TOTP code for full auth tokens
 */
function verifyMfaLogin(req, res, body) {
  const { code, mfa_token } = body;
  if (!code || !mfa_token) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'code and mfa_token are required' }));
  }

  let claims;
  try {
    const { verifyJwt } = require('../crypto/index.js');
    claims = verifyJwt(mfa_token);
    if (!claims.mfa_pending || !claims.user_id) throw new Error('Invalid MFA token');
  } catch (err) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'MFA token invalid or expired' }));
  }

  const user = queryOne('SELECT * FROM users WHERE id = ?', [claims.user_id]);
  const mfa = queryOne('SELECT * FROM mfa_secrets WHERE user_id = ? AND enabled = 1', [claims.user_id]);
  
  if (!user || !mfa) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'MFA not configured' }));
  }

  let valid = false;
  const ip = req.socket?.remoteAddress || 'unknown';

  if (code.length === 6) {
    const payload = decryptCode(mfa.secret_enc);
    const secret = Buffer.from(payload.key, 'base64');
    valid = verifyTOTP(code, secret);
  } else if (code.length === 8) {
    // Backup code fallback
    const codeHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
    const backup = queryOne('SELECT id FROM mfa_backup_codes WHERE user_id = ? AND code_hash = ? AND used = 0', [user.id, codeHash]);
    if (backup) {
      run('UPDATE mfa_backup_codes SET used = 1, used_at = datetime(\'now\') WHERE id = ?', [backup.id]);
      valid = true;
    }
  }

  if (!valid) {
    logSecurityEvent('mfa_failed', { actorId: user.id, actorEmail: user.email, ip, details: 'Invalid MFA code' });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid MFA code' }));
  }

  // Issue real tokens
  const token = signJwt({
    user_id:    user.id,
    email:      user.email,
    role:       user.role,
    college_id: user.college_id,
  });

  const rawRefreshToken = generateRefreshToken();
  const refreshHash = hashRefreshToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  run(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), user.id, refreshHash, expiresAt]);

  logSecurityEvent('login_success_mfa', { actorId: user.id, actorEmail: user.email, ip });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    token,
    refresh_token: rawRefreshToken,
    expires_in: 900,
    user: { id: user.id, email: user.email, role: user.role, college_id: user.college_id }
  }));
}

/**
 * POST /v1/auth/mfa/enroll
 */
function enrollMfa(req, res) {
  const { requireAuth } = require('../middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const mfa = queryOne('SELECT * FROM mfa_secrets WHERE user_id = ? AND enabled = 1', [claims.user_id]);
  if (mfa) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'MFA already enabled' }));
  }

  const { secret, base32 } = generateSecret();
  const secretEnc = encryptCode({ key: secret.toString('base64') });
  
  run('DELETE FROM mfa_secrets WHERE user_id = ?', [claims.user_id]);
  run(`INSERT INTO mfa_secrets (id, user_id, secret_enc, enabled) VALUES (?, ?, ?, 0)`,
    [crypto.randomUUID(), claims.user_id, secretEnc]);

  const uri = generateOtpAuthUri(claims.email, base32, 'AuthenX');
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ uri, base32_secret: base32 }));
}

/**
 * POST /v1/auth/mfa/confirm
 */
function confirmMfaSetup(req, res, body) {
  const { requireAuth } = require('../middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { code } = body;
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'code is required' }));
  }

  const mfa = queryOne('SELECT * FROM mfa_secrets WHERE user_id = ? AND enabled = 0', [claims.user_id]);
  if (!mfa) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No pending MFA enrollment found' }));
  }

  const payload = decryptCode(mfa.secret_enc);
  const secret = Buffer.from(payload.key, 'base64');
  
  if (!verifyTOTP(code, secret)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid TOTP code' }));
  }

  run('UPDATE mfa_secrets SET enabled = 1, verified_at = datetime(\'now\') WHERE id = ?', [mfa.id]);
  
  const backupCodes = generateBackupCodes();
  run('DELETE FROM mfa_backup_codes WHERE user_id = ?', [claims.user_id]);
  for (const c of backupCodes) {
    run('INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)',
      [crypto.randomUUID(), claims.user_id, crypto.createHash('sha256').update(c.toUpperCase()).digest('hex')]);
  }

  logSecurityEvent('mfa_enrolled', { actorId: claims.user_id, actorEmail: claims.email });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'MFA enabled', backup_codes: backupCodes }));
}

module.exports = { login, refreshAuth, logout, logSecurityEvent, verifyMfaLogin, enrollMfa, confirmMfaSetup };
