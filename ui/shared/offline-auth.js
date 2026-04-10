/*
 * Offline auth helper for frontend-only demo mode.
 * Supports a single super credential across portal roles.
 */
(function () {
  const SUPER_EMAIL = 'superadmin@authenx.in';
  const SUPER_PASSWORD = '1234';

  function base64UrlEncode(obj) {
    const json = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function buildToken(payload) {
    const header = { alg: 'none', typ: 'JWT' };
    return base64UrlEncode(header) + '.' + base64UrlEncode(payload) + '.';
  }

  function isSuperCredential(email, password) {
    return (email || '').trim().toLowerCase() === SUPER_EMAIL && password === SUPER_PASSWORD;
  }

  function createSession(role, opts) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: 'offline-super-user',
      email: SUPER_EMAIL,
      role: role,
      college_id: opts.collegeId || null,
      iat: now,
      exp: now + (60 * 60 * 24 * 30)
    };

    return {
      token: buildToken(payload),
      user: {
        email: SUPER_EMAIL,
        role: role,
        college_id: opts.collegeId || null
      }
    };
  }

  function loginWithSuperCredential(email, password, opts) {
    if (!isSuperCredential(email, password)) return null;
    return createSession(opts.role, opts || {});
  }

  function seedAdminSession() {
    const session = createSession('super_admin', {});
    localStorage.setItem('authenx_token', session.token);
    localStorage.setItem('authenx_user', JSON.stringify(session.user));
    return session;
  }

  window.AuthenXOfflineAuth = {
    SUPER_EMAIL,
    SUPER_PASSWORD,
    isSuperCredential,
    loginWithSuperCredential,
    seedAdminSession
  };
})();