'use strict';
const crypto = require('node:crypto');
const { queryOne, query, run } = require('../db/client.js');
const { verifyPassword, signJwt, generateRefreshToken, hashRefreshToken, encryptCode, decryptCode, hashPassword } = require('../crypto/index.js');
const { sanitizeObject, isValidEmail, validatePasswordStrength } = require('../middleware/validation.js');
const { logSecurity } = require('../middleware/logger.js');
const { generateSecret, verifyTOTP, generateOtpAuthUri, generateBackupCodes } = require('../middleware/totp.js');
const { sendJson, sendError } = require('../utils/json-response.js');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
const REFRESH_TOKEN_DAYS = 7;

/** Log a security event to the immutable security_events table */
async function logSecurityEvent(eventType, { actorId, actorEmail, targetId, ip, details }) {
  await run(`INSERT INTO security_events (id, event_type, actor_id, actor_email, target_id, ip_address, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [crypto.randomUUID(), eventType, actorId || null, actorEmail || null, targetId || null, ip || null, details || null]);
}

/** Check if account is locked due to too many failed attempts */
async function isAccountLocked(email) {
  const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const recentFailures = await query(
    `SELECT COUNT(*) as cnt FROM login_attempts
     WHERE email = $1 AND success = 0 AND created_at > $2`, [email, cutoff]
  );
  return Number(recentFailures[0]?.cnt || 0) >= MAX_LOGIN_ATTEMPTS;
}

/** Get remaining login attempts before lockout */
async function getRemainingAttempts(email) {
  const cutoff = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const recentFailures = await query(
    `SELECT COUNT(*) as cnt FROM login_attempts
     WHERE email = $1 AND success = 0 AND created_at > $2`, [email, cutoff]
  );
  return Math.max(0, MAX_LOGIN_ATTEMPTS - Number(recentFailures[0]?.cnt || 0));
}

/** Record a login attempt */
async function recordLoginAttempt(email, ip, success) {
  await run(`INSERT INTO login_attempts (id, email, ip_address, success) VALUES ($1, $2, $3, $4)`,
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
    return sendError(res, 400, 'email and password are required');
  }

  if (!isValidEmail(email)) {
    return sendError(res, 400, 'Invalid email format');
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check if account is locked
  if (await isAccountLocked(normalizedEmail)) {
    logSecurity('account_locked_attempt', { email: normalizedEmail, ip });
    await logSecurityEvent('login_locked', { actorEmail: normalizedEmail, ip, details: `Account locked after ${MAX_LOGIN_ATTEMPTS} failed attempts` });
    return sendError(res, 429, `Account is temporarily locked due to too many failed login attempts. Please try again after ${LOCKOUT_MINUTES} minutes.`, {
      locked_until: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString(),
    });
  }

  const user = await queryOne('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
  if (!user) {
    await recordLoginAttempt(normalizedEmail, ip, false);
    await logSecurityEvent('login_failed', { actorEmail: normalizedEmail, ip, details: 'User not found' });
    return sendError(res, 401, 'Invalid credentials', {
      remaining_attempts: await getRemainingAttempts(normalizedEmail),
    });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await recordLoginAttempt(normalizedEmail, ip, false);
    const remaining = await getRemainingAttempts(normalizedEmail);
    logSecurity('login_failed', { email: normalizedEmail, ip, remaining });
    await logSecurityEvent('login_failed', { actorId: user.id, actorEmail: normalizedEmail, ip, details: `Invalid password. ${remaining} attempts remaining.` });
    return sendError(res, 401, 'Invalid credentials', {
      remaining_attempts: remaining,
    });
  }

  // Success — clear lockout window by recording success
  await recordLoginAttempt(normalizedEmail, ip, true);

  // Check if MFA is enabled
  const mfa = await queryOne('SELECT * FROM mfa_secrets WHERE user_id = $1 AND enabled = 1', [user.id]);
  if (mfa) {
    // Issue a temporary MFA pending token (5 min expiry)
    const mfaToken = signJwt({ user_id: user.id, email: user.email, mfa_pending: true }, 300);
    return sendJson(res, 200, { mfa_required: true, mfa_token: mfaToken });
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
  await run(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), user.id, refreshHash, expiresAt]);

  await logSecurityEvent('login_success', { actorId: user.id, actorEmail: normalizedEmail, ip });

  sendJson(res, 200, {
    token,
    refresh_token: rawRefreshToken,
    expires_in: 900, // 15 minutes
    user: { id: user.id, email: user.email, role: user.role, college_id: user.college_id },
    must_change_password: user.must_change_password === 1,
  });
}

/**
 * POST /v1/auth/refresh
 * Body: { refresh_token }
 * Returns: { token, expires_in }
 */
async function refreshAuth(req, res, body) {
  const { refresh_token } = body;
  if (!refresh_token) {
    return sendError(res, 400, 'refresh_token is required');
  }

  const tokenHash = hashRefreshToken(refresh_token);
  const record = await queryOne(
    `SELECT rt.*, u.email, u.role, u.college_id FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked = 0`, [tokenHash]
  );

  if (!record) {
    return sendError(res, 401, 'Invalid or expired refresh token');
  }

  if (new Date(record.expires_at) < new Date()) {
    await run('UPDATE refresh_tokens SET revoked = 1 WHERE id = $1', [record.id]);
    return sendError(res, 401, 'Refresh token has expired. Please login again.');
  }

  // Issue new short-lived access token
  const token = signJwt({
    user_id:    record.user_id,
    email:      record.email,
    role:       record.role,
    college_id: record.college_id,
  });

  sendJson(res, 200, { token, expires_in: 900 });
}

/**
 * POST /v1/auth/logout
 * Invalidates the refresh token (session invalidation).
 * Body: { refresh_token }
 */
async function logout(req, res, body) {
  const { refresh_token } = body;
  if (!refresh_token) {
    return sendError(res, 400, 'refresh_token is required');
  }

  const tokenHash = hashRefreshToken(refresh_token);
  await run('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = $1', [tokenHash]);

  const ip = req.socket.remoteAddress || 'unknown';
  await logSecurityEvent('logout', { ip, details: 'Refresh token revoked' });

  sendJson(res, 200, { message: 'Logged out successfully' });
}

/**
 * POST /v1/auth/change-password
 * Body: { current_password, new_password }
 * Requires authentication. Changes user's password.
 */
async function changePassword(req, res, body) {
  const { requireAuth } = require('../middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  body = sanitizeObject(body);
  const { current_password, new_password } = body;
  const ip = req.socket.remoteAddress || 'unknown';

  if (!current_password || !new_password) {
    return sendError(res, 400, 'current_password and new_password are required');
  }

  // Password strength validation (uses shared validatePasswordStrength)
  const pwErrors = validatePasswordStrength(new_password);
  if (pwErrors.length) {
    return sendError(res, 400, pwErrors.join('. '));
  }

  const user = await queryOne('SELECT * FROM users WHERE id = $1', [claims.user_id]);
  if (!user) {
    return sendError(res, 404, 'User not found');
  }

  // Verify current password
  const isValid = await verifyPassword(current_password, user.password_hash);
  if (!isValid) {
    await logSecurityEvent('password_change_failed', { actorId: user.id, actorEmail: user.email, ip, details: 'Invalid current password' });
    return sendError(res, 401, 'Current password is incorrect');
  }

  // Hash and store new password
  const newHash = await hashPassword(new_password);
  await run('UPDATE users SET password_hash = $1, must_change_password = 0, last_password_change = NOW() WHERE id = $2',
    [newHash, user.id]);

  // Revoke all existing refresh tokens (force re-login on other devices)
  await run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = $1', [user.id]);

  await logSecurityEvent('password_changed', { actorId: user.id, actorEmail: user.email, ip });

  sendJson(res, 200, { message: 'Password changed successfully. Please login again.' });
}

/**
 * POST /v1/auth/mfa/verify
 * Exchange MFA token + TOTP code for full auth tokens
 */
async function verifyMfaLogin(req, res, body) {
  const { code, mfa_token } = body;
  if (!code || !mfa_token) {
    return sendError(res, 400, 'code and mfa_token are required');
  }

  let claims;
  try {
    const { verifyJwt } = require('../crypto/index.js');
    claims = verifyJwt(mfa_token);
    if (!claims.mfa_pending || !claims.user_id) throw new Error('Invalid MFA token');
  } catch (err) {
    return sendError(res, 401, 'MFA token invalid or expired');
  }

  const user = await queryOne('SELECT * FROM users WHERE id = $1', [claims.user_id]);
  const mfa = await queryOne('SELECT * FROM mfa_secrets WHERE user_id = $1 AND enabled = 1', [claims.user_id]);

  if (!user || !mfa) {
    return sendError(res, 400, 'MFA not configured');
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
    const backup = await queryOne('SELECT id FROM mfa_backup_codes WHERE user_id = $1 AND code_hash = $2 AND used = 0', [user.id, codeHash]);
    if (backup) {
      await run('UPDATE mfa_backup_codes SET used = 1, used_at = NOW() WHERE id = $1', [backup.id]);
      valid = true;
    }
  }

  if (!valid) {
    await logSecurityEvent('mfa_failed', { actorId: user.id, actorEmail: user.email, ip, details: 'Invalid MFA code' });
    return sendError(res, 401, 'Invalid MFA code');
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
  await run(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), user.id, refreshHash, expiresAt]);

  await logSecurityEvent('login_success_mfa', { actorId: user.id, actorEmail: user.email, ip });

  sendJson(res, 200, {
    token,
    refresh_token: rawRefreshToken,
    expires_in: 900,
    user: { id: user.id, email: user.email, role: user.role, college_id: user.college_id }
  });
}

/**
 * POST /v1/auth/mfa/enroll
 */
async function enrollMfa(req, res) {
  const { requireAuth } = require('../middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const mfa = await queryOne('SELECT * FROM mfa_secrets WHERE user_id = $1 AND enabled = 1', [claims.user_id]);
  if (mfa) {
    return sendError(res, 400, 'MFA already enabled');
  }

  const { secret, base32 } = generateSecret();
  const secretEnc = encryptCode({ key: secret.toString('base64') });

  await run('DELETE FROM mfa_secrets WHERE user_id = $1', [claims.user_id]);
  await run(`INSERT INTO mfa_secrets (id, user_id, secret_enc, enabled) VALUES ($1, $2, $3, 0)`,
    [crypto.randomUUID(), claims.user_id, secretEnc]);

  const uri = generateOtpAuthUri(claims.email, base32, 'AuthenX');

  sendJson(res, 200, { uri, base32_secret: base32 });
}

/**
 * POST /v1/auth/mfa/confirm
 */
async function confirmMfaSetup(req, res, body) {
  const { requireAuth } = require('../middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { code } = body;
  if (!code) {
    return sendError(res, 400, 'code is required');
  }

  const mfa = await queryOne('SELECT * FROM mfa_secrets WHERE user_id = $1 AND enabled = 0', [claims.user_id]);
  if (!mfa) {
    return sendError(res, 400, 'No pending MFA enrollment found');
  }

  const payload = decryptCode(mfa.secret_enc);
  const secret = Buffer.from(payload.key, 'base64');

  if (!verifyTOTP(code, secret)) {
    return sendError(res, 400, 'Invalid TOTP code');
  }

  await run('UPDATE mfa_secrets SET enabled = 1, verified_at = NOW() WHERE id = $1', [mfa.id]);

  const backupCodes = generateBackupCodes();
  await run('DELETE FROM mfa_backup_codes WHERE user_id = $1', [claims.user_id]);
  for (const c of backupCodes) {
    await run('INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES ($1, $2, $3)',
      [crypto.randomUUID(), claims.user_id, crypto.createHash('sha256').update(c.toUpperCase()).digest('hex')]);
  }

  await logSecurityEvent('mfa_enrolled', { actorId: claims.user_id, actorEmail: claims.email });

  sendJson(res, 200, { message: 'MFA enabled', backup_codes: backupCodes });
}

module.exports = { login, refreshAuth, logout, logSecurityEvent, verifyMfaLogin, enrollMfa, confirmMfaSetup, changePassword };
