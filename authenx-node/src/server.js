'use strict';
/**
 * AuthenX Node.js Server
 * Production-grade academic credential verification infrastructure
 * Zero external dependencies — uses only Node 22 built-in modules
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { getDb, run, queryOne, query } = require('./db/client.js');
const { hashPassword, generateEd25519KeyPair, signEd25519, verifyEd25519, sha256, buildCanonicalJson, encryptCode } = require('./crypto/index.js');

const { login, refreshAuth, logout, logSecurityEvent, verifyMfaLogin, enrollMfa, confirmMfaSetup, changePassword } = require('./routes/auth.js');
const { listColleges, getCollege, createCollege, onboardCollege } = require('./routes/colleges.js');
const { issueToken, revokeToken, getToken, listTokens } = require('./routes/tokens.js');
const { decodeCode, liveVerify } = require('./routes/verify.js');
const { getAuditLog, getStats, exportAuditLog } = require('./routes/audit.js');
const { getTokenDetails, correctToken } = require('./routes/tokens-extra.js');
const { getDisclosurePolicy, saveDisclosurePolicy } = require('./routes/disclosure.js');
const { getSecurityStats } = require('./routes/security.js');
const { getConnectorConfig, saveConnectorConfig } = require('./routes/connector-config.js');
const { connectorHealth, connectorVerify, rotateKey } = require('./routes/connector-proxy.js');
const { sanitizeObject } = require('./middleware/validation.js');
const { createRequestLogger, log, logStartup } = require('./middleware/logger.js');
const metrics = require('./middleware/metrics.js');
const fraud = require('./middleware/fraud-detector.js');
const { privacyNotice, getConsent, grantConsent, deleteConsent, dataAccessRequest, erasureRequest, enforceRetention } = require('./routes/privacy.js');

const PORT = process.env.PORT || 3000;

// ─── Request body parser ──────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB DoS protection

    req.on('data', (c) => {
      totalLength += c.length;
      if (totalLength > MAX_PAYLOAD_SIZE) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      chunks.push(c);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ─── CORS + Security headers ─────────────────────────────────────────────────
// Allowed origins - configure via environment variable or use defaults
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

function isLocalDevOrigin(origin) {
  if (!origin) return false;
  if (origin === 'null') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin;

  // Check if origin is in allowed list
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    // Same-origin requests (no Origin header) - allow for API calls from server
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || 'http://localhost:3000');
  } else if (isLocalDevOrigin(origin)) {
    // Local file:// pages and localhost dev servers send Origin: null or a localhost origin.
    // Allow these so the UI can be opened directly from disk during development.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // If origin not allowed, don't set Access-Control-Allow-Origin (browser will block)

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
}

// ─── Rate Limiter Protection ──────────────────────────────────────────────────
const rateLimitMap = new Map();

function enforceRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + 60000 };
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + 60000;
  } else {
    record.count++;
  }
  rateLimitMap.set(ip, record);
  return record.count <= 50; // Max 50 requests per minute per IP
}

// GC cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) rateLimitMap.delete(ip);
  }
}, 300000).unref();

// ─── Router ───────────────────────────────────────────────────────────────────
async function router(req, res) {
  // Generate request correlation ID for distributed tracing
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const path = urlObj.pathname;
  const method = req.method;
  const requestStart = Date.now();

  // Log incoming request
  const logger = createRequestLogger(req, res);
  logger.info(`${method} ${path}`);

  // Track response for metrics and logging
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const latency = Date.now() - requestStart;
    metrics.recordRequest(method, path, res.statusCode || 200, latency);
    logger.info(`${method} ${path} ${res.statusCode || 200} ${latency}ms [${requestId}]`);
    return origEnd(...args);
  };

  const ip = req.socket.remoteAddress || 'unknown';
  if (!enforceRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many requests from this IP, please try again later.' }));
  }

  // Static: serve HTML frontend (admin dashboard)
  if (path === '/' || path === '/app') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_APP);
  }

  // Static: serve the ui/ directory so browser and API share the same origin
  // (avoids all CORS null-origin issues when opening HTML files from disk)
  // Access the employer portal at: http://localhost:3000/ui/employer/index.html
  if (path.startsWith('/ui/')) {
    const _fs   = require('node:fs');
    const _path = require('node:path');
    // Resolve the file path relative to the project root (two levels up from authenx-node/src/)
    const projectRoot = _path.resolve(__dirname, '../../');
    const filePath    = _path.join(projectRoot, path);
    // Security: block path traversal
    const uiRoot   = _path.resolve(projectRoot, 'ui');
    const resolved = _path.resolve(filePath);
    if (!resolved.startsWith(uiRoot + _path.sep) && resolved !== uiRoot) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }
    if (!_fs.existsSync(resolved)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'File not found', path }));
    }
    const ext = _path.extname(resolved).toLowerCase();
    const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
                   '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
                   '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    return res.end(_fs.readFileSync(resolved));
  }

  // Health check
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: '1.0.0', node: process.version }));
  }

  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    try { body = await readBody(req); body = sanitizeObject(body); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Auth routes
  if (path === '/v1/auth/login' && method === 'POST') return login(req, res, body);
  if (path === '/v1/auth/refresh' && method === 'POST') return refreshAuth(req, res, body);
  if (path === '/v1/auth/logout' && method === 'POST') return logout(req, res, body);
  if (path === '/v1/auth/change-password' && method === 'POST') return changePassword(req, res, body);
  if (path === '/v1/auth/mfa/verify' && method === 'POST') return verifyMfaLogin(req, res, body);
  if (path === '/v1/auth/mfa/enroll' && method === 'POST') return enrollMfa(req, res);
  if (path === '/v1/auth/mfa/confirm' && method === 'POST') return confirmMfaSetup(req, res, body);

  // College routes
  if (path === '/v1/colleges' && method === 'GET') return listColleges(req, res);
  if (path === '/v1/colleges' && method === 'POST') return createCollege(req, res, body);
  if (path === '/v1/colleges/onboard' && method === 'POST') return onboardCollege(req, res, body);
  const collegeMatch = path.match(/^\/v1\/colleges\/([^/]+)$/);
  if (collegeMatch && method === 'GET') return getCollege(req, res, collegeMatch[1]);

  // Token routes
  if (path === '/v1/tokens' && method === 'GET') return listTokens(req, res);
  if (path === '/v1/tokens/issue' && method === 'POST') return issueToken(req, res, body);
  if (path === '/v1/tokens/revoke' && method === 'POST') return revokeToken(req, res, body);
  if (path === '/v1/tokens/correct' && method === 'POST') return correctToken(req, res, body);
  if (path === '/v1/tokens/analytics' && method === 'GET') return tokenAnalytics(req, res);
  const tokenDetailsMatch = path.match(/^\/v1\/tokens\/([^/]+)\/details$/);
  if (tokenDetailsMatch && method === 'GET') return getTokenDetails(req, res, tokenDetailsMatch[1]);
  const tokenMatch = path.match(/^\/v1\/tokens\/([^/]+)$/);
  if (tokenMatch && method === 'GET') return getToken(req, res, tokenMatch[1]);

  // Verify routes
  if (path === '/v1/verify/code' && method === 'POST') return decodeCode(req, res, body);
  if (path === '/v1/verify/live' && method === 'POST') return liveVerify(req, res, body);
  if (path === '/v1/verify/bulk' && method === 'POST') return bulkVerify(req, res, body);

  // Audit routes
  if (path === '/v1/audit' && method === 'GET') return getAuditLog(req, res, urlObj);
  if (path === '/v1/audit/stats' && method === 'GET') return getStats(req, res);
  if (path === '/v1/audit/export' && method === 'GET') return exportAuditLog(req, res, urlObj);
  if (path === '/v1/audit/security' && method === 'GET') return getSecurityEvents(req, res, urlObj);

  // Disclosure policy routes
  if (path === '/v1/disclosure-policy' && method === 'GET') return getDisclosurePolicy(req, res);
  if (path === '/v1/disclosure-policy' && method === 'PUT') return saveDisclosurePolicy(req, res, body);

  // Connector onboarding config
  if (path === '/v1/connector-config' && method === 'GET') return getConnectorConfig(req, res);
  if (path === '/v1/connector-config' && method === 'PUT') return saveConnectorConfig(req, res, body);

  // Connector proxy (server-side HMAC)
  if (path === '/v1/connector/health' && method === 'GET') return connectorHealth(req, res);
  if (path === '/v1/connector/verify' && method === 'POST') return connectorVerify(req, res, body);
  if (path === '/v1/connector/rotate-key' && method === 'POST') return rotateKey(req, res);

  // Security stats
  if (path === '/v1/security/stats' && method === 'GET') return getSecurityStats(req, res);

  // Connector health
  if (path === '/v1/connectors/health' && method === 'GET') return connectorHealthCheck(req, res);

  // Detailed health
  if (path === '/v1/health/detailed' && method === 'GET') return detailedHealth(req, res);

  // Metrics (admin only)
  if (path === '/v1/metrics' && method === 'GET') return serveMetrics(req, res, urlObj);

  // Fraud alerts (admin only)
  if (path === '/v1/fraud-alerts' && method === 'GET') return serveFraudAlerts(req, res, urlObj);

  // Privacy & DPDP compliance routes
  if (path === '/v1/privacy/notice' && method === 'GET') return privacyNotice(req, res);
  if (path === '/v1/privacy/consent' && method === 'GET') return getConsent(req, res);
  if (path === '/v1/privacy/consent' && method === 'POST') return grantConsent(req, res, body);
  if (path === '/v1/privacy/consent' && method === 'DELETE') return deleteConsent(req, res, body);
  if (path === '/v1/privacy/data-access' && method === 'GET') return dataAccessRequest(req, res);
  if (path === '/v1/privacy/erasure' && method === 'POST') return erasureRequest(req, res, body);
  if (path === '/v1/privacy/retention/enforce' && method === 'POST') return enforceRetention(req, res);

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Route not found', path, method }));
}

// ─── Bulk Verification ────────────────────────────────────────────────────────
async function bulkVerify(req, res, body) {
  const { requireAuth } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const { codes } = body;
  if (!Array.isArray(codes) || codes.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'codes array is required' }));
  }
  if (codes.length > 50) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Maximum 50 codes per bulk request' }));
  }

  const { decryptCode } = require('./crypto/index.js');
  const results = [];
  for (const code of codes) {
    try {
      const payload = decryptCode(code);
      const token = queryOne(`
        SELECT t.id, t.status, t.credential_type, t.student_ref_token,
               c.name as college_name
        FROM verification_tokens t JOIN colleges c ON c.id = t.college_id
        WHERE t.id = ?`, [payload.token_id]);
      results.push({
        code: code.slice(0, 20) + '...',
        status: token ? token.status : 'not_found',
        college: token?.college_name || null,
        credential_type: token?.credential_type || null,
      });
    } catch {
      results.push({ code: code.slice(0, 20) + '...', status: 'invalid_code', college: null });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ results, count: results.length }));
}

// ─── Token Analytics ──────────────────────────────────────────────────────────
function tokenAnalytics(req, res) {
  const { requireAuth, requireRole } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin', 'college_admin'], res)) return;

  // Use parameterized queries to prevent SQL injection
  const isCollegeAdmin = claims.role === 'college_admin';
  const collegeId = claims.college_id;

  // Validate college_id format if present (UUID format)
  if (isCollegeAdmin && collegeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collegeId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid college_id format' }));
  }

  const monthly = isCollegeAdmin
    ? query(`
        SELECT strftime('%Y-%m', t.issued_at) as month,
               COUNT(*) as issued,
               SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) as active,
               SUM(CASE WHEN t.status = 'revoked' THEN 1 ELSE 0 END) as revoked
        FROM verification_tokens t WHERE t.college_id = ?
        GROUP BY month ORDER BY month DESC LIMIT 12
      `, [collegeId])
    : query(`
        SELECT strftime('%Y-%m', t.issued_at) as month,
               COUNT(*) as issued,
               SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) as active,
               SUM(CASE WHEN t.status = 'revoked' THEN 1 ELSE 0 END) as revoked
        FROM verification_tokens t
        GROUP BY month ORDER BY month DESC LIMIT 12
      `);

  const verificationTrends = query(`
    SELECT date(r.created_at) as day,
           COUNT(*) as total,
           SUM(CASE WHEN r.result = 'verified' THEN 1 ELSE 0 END) as success,
           SUM(CASE WHEN r.result = 'error' THEN 1 ELSE 0 END) as failures,
           AVG(r.latency_ms) as avg_latency_ms
    FROM verification_requests r
    WHERE r.request_type = 'live_verify'
    GROUP BY day ORDER BY day DESC LIMIT 30
  `);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ monthly_issuance: monthly, daily_verifications: verificationTrends }));
}

// ─── Security Events Audit ────────────────────────────────────────────────────
function getSecurityEvents(req, res, urlObj) {
  const { requireAuth, requireRole } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, ['super_admin'], res)) return;

  const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
  const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);

  const events = query(`
    SELECT * FROM security_events ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
  const total = query('SELECT COUNT(*) as cnt FROM security_events')[0]?.cnt || 0;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events, count: events.length, total, limit, offset }));
}

// ─── Connector Health Check ───────────────────────────────────────────────────
async function connectorHealthCheck(req, res) {
  const { requireAuth } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const colleges = query('SELECT id, name, connector_url FROM colleges WHERE active = 1');
  const results = [];

  for (const college of colleges) {
    if (!college.connector_url || college.connector_url === 'mock' || college.connector_url.startsWith('internal://')) {
      results.push({ college: college.name, status: 'mock', latency_ms: 0 });
      continue;
    }
    const start = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const urlObj = new URL('/health', college.connector_url);
        const mod = urlObj.protocol === 'https:' ? require('node:https') : require('node:http');
        const request = mod.request({
          hostname: urlObj.hostname, port: urlObj.port, path: '/health', method: 'GET',
        }, (response) => {
          let d = ''; response.on('data', c => d += c);
          response.on('end', () => resolve(d));
        });
        request.on('error', reject);
        request.setTimeout(3000, () => { request.destroy(); reject(new Error('timeout')); });
        request.end();
      });
      results.push({ college: college.name, status: 'online', latency_ms: Date.now() - start });
    } catch {
      results.push({ college: college.name, status: 'offline', latency_ms: Date.now() - start });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ connectors: results, checked_at: new Date().toISOString() }));
}

// ─── Detailed Health ──────────────────────────────────────────────────────────
function detailedHealth(req, res) {
  const stats = {
    status: 'ok',
    version: '2.0.0',
    node: process.version,
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    db: {
      colleges: query('SELECT COUNT(*) as cnt FROM colleges WHERE active=1')[0]?.cnt || 0,
      tokens: query('SELECT COUNT(*) as cnt FROM verification_tokens')[0]?.cnt || 0,
      verifications: query('SELECT COUNT(*) as cnt FROM verification_requests')[0]?.cnt || 0,
    },
    security: {
      failed_logins_today: query(`SELECT COUNT(*) as cnt FROM login_attempts WHERE success=0 AND date(created_at) = date('now')`)[0]?.cnt || 0,
      security_events_today: query(`SELECT COUNT(*) as cnt FROM security_events WHERE date(created_at) = date('now')`)[0]?.cnt || 0,
    },
    checked_at: new Date().toISOString(),
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stats));
}

// ─── Metrics endpoint (admin only) ────────────────────────────────────────────
function serveMetrics(req, res, urlObj) {
  const { requireAuth, requireRole } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, 'super_admin', res)) return;

  const format = urlObj.searchParams.get('format');
  if (format === 'prometheus') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(metrics.getPrometheusText());
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(metrics.getMetrics()));
}

// ─── Fraud alerts endpoint (admin only) ───────────────────────────────────────
function serveFraudAlerts(req, res, urlObj) {
  const { requireAuth, requireRole } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;
  if (!requireRole(claims, 'super_admin', res)) return;

  const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
  const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);

  const alerts = query('SELECT * FROM fraud_alerts ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
  const total = query('SELECT COUNT(*) as cnt FROM fraud_alerts')[0]?.cnt || 0;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ alerts, count: alerts.length, total, limit, offset }));
}

// ─── Fraud alert flusher (periodically saves buffered alerts to DB) ───────────
function flushFraudAlerts() {
  const alerts = fraud.flushAlerts();
  for (const a of alerts) {
    try {
      run(`INSERT INTO fraud_alerts (id, alert_type, severity, actor_id, actor_email, ip_address, details)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [a.id, a.alert_type, a.severity, a.actor_id, a.actor_email, a.ip_address, a.details]);
      metrics.recordFraudAlert();
      log('warn', `🚨 FRAUD ALERT: ${a.alert_type} [${a.severity}]`, { alert_id: a.id, actor: a.actor_email || a.ip_address });
    } catch { /* non-fatal */ }
  }
}
// Flush every 5 seconds
setInterval(flushFraudAlerts, 5000).unref();

// ─── Seed data ────────────────────────────────────────────────────────────────
async function seedDatabase() {
  const existingAdmin = queryOne("SELECT id FROM users WHERE email='admin@authenx.in'");
  if (existingAdmin) { console.log('  ✓ Database already seeded'); return; }

  console.log('  → Seeding database (multi-college)...');

  const _fs = require('node:fs');
  const _path = require('node:path');

  // ── Load college registry (generated by colleges/setup.js) ──────────────
  const registryPath = _path.join(process.cwd(), '..', 'colleges', 'registry.json');
  let registry = [];
  if (_fs.existsSync(registryPath)) {
    registry = JSON.parse(_fs.readFileSync(registryPath, 'utf8'));
    console.log(`  → Found registry with ${registry.length} colleges`);
  } else {
    console.log('  ⚠  No registry found — using fallback 3-college seed');
  }

  // ── Fallback: generate a single mock key if no registry ─────────────────
  const { privateKeyHex: fallbackPriv, publicKeyHex: fallbackPub } = generateEd25519KeyPair();
  process.env.MOCK_CONNECTOR_PRIV_KEY = fallbackPriv;

  // ── Register colleges ───────────────────────────────────────────────────
  const colleges = [];
  if (registry.length > 0) {
    for (const r of registry) {
      run(`INSERT OR IGNORE INTO colleges (id,name,short_code,public_key_hex,connector_url,shared_secret)
           VALUES (?,?,?,?,?,?)`,
        [r.id, r.name, r.short_code, r.public_key_hex, r.connector_url, r.shared_secret]);
      colleges.push(r);
    }
  } else {
    // Legacy fallback
    const fallbackColleges = [
      { id: crypto.randomUUID(), name: 'IIT Bombay', short_code: 'IITB', connector_url: 'mock', shared_secret: crypto.randomBytes(32).toString('hex'), public_key_hex: fallbackPub },
      { id: crypto.randomUUID(), name: 'NIT Calicut', short_code: 'NITC', connector_url: 'mock', shared_secret: crypto.randomBytes(32).toString('hex'), public_key_hex: fallbackPub },
      { id: crypto.randomUUID(), name: 'BITS Pilani', short_code: 'BITS', connector_url: 'mock', shared_secret: crypto.randomBytes(32).toString('hex'), public_key_hex: fallbackPub },
    ];
    for (const c of fallbackColleges) {
      run('INSERT INTO colleges (id,name,short_code,public_key_hex,connector_url,shared_secret) VALUES (?,?,?,?,?,?)',
        [c.id, c.name, c.short_code, c.public_key_hex, c.connector_url, c.shared_secret]);
      colleges.push(c);
    }
  }

  // ── Create users ────────────────────────────────────────────────────────
  const adminHash = await hashPassword('Admin@123');
  const collegeHash = await hashPassword('College@123');
  const employerHash = await hashPassword('Employer@123');

  // Super admin - must change default password on first login
  run('INSERT INTO users (id,email,password_hash,role,must_change_password) VALUES (?,?,?,?,1)',
    [crypto.randomUUID(), 'admin@authenx.in', adminHash, 'super_admin']);

  // College admins — one per college, must change default password
  for (const c of colleges) {
    const email = `${c.short_code.toLowerCase()}@authenx.in`;
    run('INSERT OR IGNORE INTO users (id,email,password_hash,role,college_id,must_change_password) VALUES (?,?,?,?,?,1)',
      [crypto.randomUUID(), email, collegeHash, 'college_admin', c.id]);
  }

  // Employer accounts - must change default password
  const employers = [
    'recruiter@infosys.com',
    'hr@tcs.com',
    'hiring@wipro.com',
    'talent@google.com',
    'campus@microsoft.com',
  ];
  for (const email of employers) {
    run('INSERT OR IGNORE INTO users (id,email,password_hash,role,must_change_password) VALUES (?,?,?,?,1)',
      [crypto.randomUUID(), email, employerHash, 'employer']);
  }

  // ── Pre-issue demo tokens ───────────────────────────────────────────────
  // Use each college's key from HSM key-store (or fallback)
  const generatedCodes = [];

  // Pick first 3 colleges for demo tokens
  const demoColleges = colleges.slice(0, 3);
  const demoStudents = [
    { student_ref_token: 'stu_ref_001', name: 'SUPREETH K', degree: 'BTECH', branch: 'COMPUTER SCIENCE', cgpa: '8.9', graduation_year: '2024', issue_date: '2024-06-15' },
    { student_ref_token: 'stu_ref_002', name: 'PRIYA SHARMA', degree: 'MTECH', branch: 'ELECTRONICS', cgpa: '9.1', graduation_year: '2024', issue_date: '2024-06-15' },
    { student_ref_token: 'stu_ref_003', name: 'RAHUL NAIR', degree: 'BTECH', branch: 'MECHANICAL ENGINEERING', cgpa: '7.8', graduation_year: '2023', issue_date: '2023-06-15' },
  ];

  for (let i = 0; i < demoStudents.length; i++) {
    const s = demoStudents[i];
    const college = demoColleges[i % demoColleges.length];

    // Try to load private key from HSM key-store file
    let privKey = fallbackPriv;
    const hsmKeyPath = _path.join(process.cwd(), '..', '..', 'authenx-hsm', 'keys', `${college.id}.json`);
    if (_fs.existsSync(hsmKeyPath)) {
      try {
        const keyData = JSON.parse(_fs.readFileSync(hsmKeyPath, 'utf8'));
        privKey = keyData.private_key_hex;
      } catch { /* use fallback */ }
    }

    const fields = {
      schema_version: '1.0', issuer_id: college.id,
      student_ref_token: s.student_ref_token, name: s.name,
      degree: s.degree, branch: s.branch, credential_type: 'DEGREE_CERTIFICATE',
      cgpa: s.cgpa, graduation_year: s.graduation_year, issue_date: s.issue_date,
    };
    const canonical = buildCanonicalJson(fields);
    const canonical_hash = sha256(canonical);
    const issuance_signature = signEd25519(canonical_hash, privKey);
    const token_id = crypto.randomUUID();

    run(`INSERT OR IGNORE INTO verification_tokens
         (id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type, status)
         VALUES (?,?,?,?,?,?,?,?)`,
      [token_id, college.id, s.student_ref_token, canonical_hash, issuance_signature, '1.0', 'DEGREE_CERTIFICATE', 'active']);

    const code = encryptCode({ v: 1, token_id, college_id: college.id, student_ref_token: s.student_ref_token, credential_type: 'DEGREE_CERTIFICATE' });
    generatedCodes.push({ name: s.name, student_ref_token: s.student_ref_token, college: college.name, token_id, authenx_code: code });
  }

  // Revoke stu_ref_003 for testing
  run("UPDATE verification_tokens SET status='revoked', revocation_reason='Re-enrolled for additional year', revoked_at=datetime('now') WHERE student_ref_token='stu_ref_003'");

  // Save generated codes
  _fs.writeFileSync(
    _path.join(process.cwd(), 'seed_codes.json'),
    JSON.stringify(generatedCodes, null, 2)
  );

  console.log(`  ✓ Seeded: ${colleges.length} colleges, ${colleges.length + 1 + employers.length} users, ${demoStudents.length} tokens`);
  console.log('  ✓ Seed codes saved to seed_codes.json');
  console.log(`  ✓ College admin password: College@123`);
  console.log(`  ✓ Employer password: Employer@123`);
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────
const HTML_APP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AuthenX — Credential Verification</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;color:#1f2937}
.sidebar{position:fixed;top:0;left:0;width:200px;height:100vh;background:#1B4F8A;padding:24px 0;z-index:100}
.logo{padding:0 20px 24px;border-bottom:1px solid #2563EB}
.logo h1{color:#fff;font-size:22px;font-weight:700}
.logo p{color:#93C5FD;font-size:11px;margin-top:2px}
.nav-item{display:block;padding:10px 20px;color:#93C5FD;cursor:pointer;font-size:13px;border-left:3px solid transparent;transition:.15s}
.nav-item:hover,.nav-item.active{color:#fff;background:#2563EB22;border-left-color:#60A5FA}
.main{margin-left:200px;padding:32px;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
.topbar h2{font-size:20px;font-weight:700;color:#1f2937}
.topbar span{font-size:12px;color:#9ca3af}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px}
.card-title{font-size:14px;font-weight:600;color:#374151;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #f3f4f6}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.stat{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;position:relative;overflow:hidden}
.stat-label{font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px}
.stat-val{font-size:32px;font-weight:700;color:#1f2937;margin:6px 0}
.stat-sub{font-size:11px;color:#9ca3af}
.stat-bar{position:absolute;bottom:0;left:0;right:0;height:3px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:.15s}
.btn-primary{background:#2563EB;color:#fff}.btn-primary:hover{background:#1d4ed8}
.btn-secondary{background:#f3f4f6;color:#374151}.btn-secondary:hover{background:#e5e7eb}
.btn-danger{background:#ef4444;color:#fff}.btn-danger:hover{background:#dc2626}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:500}
.badge-green{background:#f0fdf4;color:#166534}
.badge-red{background:#fef2f2;color:#991b1b}
.badge-blue{background:#eff6ff;color:#1e40af}
.badge-gray{background:#f3f4f6;color:#4b5563}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;background:#f9fafb;border-bottom:1px solid #e5e7eb}
td{padding:12px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f9fafb}
.form-group{margin-bottom:16px}
.form-label{display:block;font-size:12px;color:#6b7280;margin-bottom:6px;font-weight:500}
.form-input{width:100%;padding:9px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;color:#1f2937;outline:none;transition:.15s}
.form-input:focus{border-color:#2563EB;box-shadow:0 0 0 3px #2563eb18}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.result-box{padding:20px;border-radius:8px;margin-top:16px}
.result-verified{background:#f0fdf4;border:1px solid #bbf7d0}
.result-revoked{background:#fef2f2;border:1px solid #fecaca}
.result-error{background:#fefce8;border:1px solid #fde68a}
.result-title{font-size:18px;font-weight:700;margin-bottom:12px}
.result-field{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0000000f;font-size:13px}
.result-field:last-child{border-bottom:none}
.result-key{color:#6b7280}
.result-val{font-weight:500;color:#1f2937}
.code-box{background:#1e293b;border-radius:8px;padding:16px;font-family:monospace;font-size:12px;color:#86efac;word-break:break-all;margin:12px 0;line-height:1.6}
.hidden{display:none}
.screen{display:none}.screen.active{display:block}
.alert{padding:12px 16px;border-radius:6px;font-size:13px;margin-bottom:16px}
.alert-info{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe}
.alert-success{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.alert-error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
#loginScreen{max-width:400px;margin:60px auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 4px 24px #0002}
.login-logo{text-align:center;margin-bottom:24px}
.login-logo h1{font-size:28px;color:#1B4F8A;font-weight:700}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #fff4;border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.mono{font-family:monospace;font-size:11px;color:#6b7280;word-break:break-all}
</style>
</head>
<body>

<!-- LOGIN SCREEN -->
<div id="loginScreen">
  <div class="login-logo">
    <h1>AuthenX</h1>
    <p style="color:#9ca3af;font-size:12px;margin-top:4px">Academic Credential Infrastructure</p>
  </div>
  <div id="loginError" class="alert alert-error hidden"></div>
  <div class="form-group">
    <label class="form-label">Email address</label>
    <input class="form-input" id="loginEmail" type="email" value="admin@authenx.in" placeholder="email">
  </div>
  <div class="form-group">
    <label class="form-label">Password</label>
    <input class="form-input" id="loginPass" type="password" value="Admin@123" placeholder="password">
  </div>
  <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">
    Sign in
  </button>
  <p style="text-align:center;margin-top:20px;font-size:11px;color:#9ca3af">🔒  Ed25519 + AES-256-GCM · Privacy-first</p>
</div>

<!-- APP SHELL -->
<div id="appShell" class="hidden">
  <div class="sidebar">
    <div class="logo"><h1>AuthenX</h1><p id="sidebarRole"></p></div>
    <div style="padding:16px 0">
      <div class="nav-item active" onclick="showScreen('dashboard')">📊  Dashboard</div>
      <div class="nav-item" onclick="showScreen('colleges')">🏛️  Colleges</div>
      <div class="nav-item" onclick="showScreen('credentials')">🎓  Credentials</div>
      <div class="nav-item" onclick="showScreen('verify')">🔍  Verify</div>
      <div class="nav-item" onclick="showScreen('audit')">📋  Audit Log</div>
    </div>
    <div style="position:absolute;bottom:16px;left:0;right:0;padding:0 16px">
      <button class="btn btn-secondary" style="width:100%;justify-content:center;font-size:12px" onclick="doLogout()">Sign out</button>
    </div>
  </div>
  <div class="main">

    <!-- DASHBOARD -->
    <div id="screen-dashboard" class="screen active">
      <div class="topbar"><h2>Dashboard</h2><span id="dashDate"></span></div>
      <div class="stats" id="statsGrid">
        <div class="stat"><div class="stat-label">Colleges</div><div class="stat-val" id="s-colleges">—</div><div class="stat-sub">Active connectors</div><div class="stat-bar" style="background:#2563EB"></div></div>
        <div class="stat"><div class="stat-label">Tokens Issued</div><div class="stat-val" id="s-tokens">—</div><div class="stat-sub">Active credentials</div><div class="stat-bar" style="background:#22c55e"></div></div>
        <div class="stat"><div class="stat-label">Verifications</div><div class="stat-val" id="s-verifs">—</div><div class="stat-sub">Live checks</div><div class="stat-bar" style="background:#f59e0b"></div></div>
        <div class="stat"><div class="stat-label">Revoked</div><div class="stat-val" id="s-revoked">—</div><div class="stat-sub">Cancelled tokens</div><div class="stat-bar" style="background:#ef4444"></div></div>
      </div>
      <div class="card">
        <div class="card-title">Recent Verifications</div>
        <table><thead><tr><th>Employer</th><th>College</th><th>Type</th><th>Result</th><th>Latency</th><th>Time</th></tr></thead>
        <tbody id="recentTable"><tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px">Loading...</td></tr></tbody></table>
      </div>
    </div>

    <!-- COLLEGES -->
    <div id="screen-colleges" class="screen">
      <div class="topbar"><h2>Colleges</h2></div>
      <div id="collegeList"></div>
    </div>

    <!-- CREDENTIALS -->
    <div id="screen-credentials" class="screen">
      <div class="topbar"><h2>Credentials</h2></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <div class="card-title">Issue Credential</div>
          <div class="form-group"><label class="form-label">College</label>
            <select class="form-input" id="issueCollege"></select></div>
          <div class="form-group"><label class="form-label">Student Ref Token</label>
            <input class="form-input" id="issueRef" value="stu_ref_001"></div>
          <div class="form-grid">
            <div class="form-group"><label class="form-label">Full Name</label>
              <input class="form-input" id="issueName" value="SUPREETH K"></div>
            <div class="form-group"><label class="form-label">Degree</label>
              <input class="form-input" id="issueDegree" value="BTECH"></div>
            <div class="form-group"><label class="form-label">Branch</label>
              <input class="form-input" id="issueBranch" value="COMPUTER SCIENCE"></div>
            <div class="form-group"><label class="form-label">CGPA</label>
              <input class="form-input" id="issueCgpa" value="8.9"></div>
            <div class="form-group"><label class="form-label">Graduation Year</label>
              <input class="form-input" id="issueYear" value="2024"></div>
            <div class="form-group"><label class="form-label">Credential Type</label>
              <input class="form-input" id="issueType" value="DEGREE_CERTIFICATE"></div>
          </div>
          <button class="btn btn-primary" onclick="doIssue()">Issue Credential</button>
          <div id="issueResult" class="hidden" style="margin-top:16px"></div>
        </div>
        <div class="card">
          <div class="card-title">Issued Tokens</div>
          <table><thead><tr><th>Ref</th><th>College</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="tokenTable"><tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">Loading...</td></tr></tbody></table>
        </div>
      </div>
    </div>

    <!-- VERIFY -->
    <div id="screen-verify" class="screen">
      <div class="topbar"><h2>Verify Credential</h2></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <div class="card-title">Step 1 — Paste AuthenX Code</div>
          <div class="form-group">
            <label class="form-label">AuthenX Code</label>
            <textarea class="form-input" id="verifyCode" rows="5" placeholder="AX1.eyJ..."></textarea>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" onclick="doDecodeCode()">Decode Code</button>
            <button class="btn btn-primary" onclick="doLiveVerify()">Live Verify (ERP)</button>
          </div>
          <div class="alert alert-info" style="margin-top:16px;font-size:12px">
            💡 <strong>Decode Code</strong> checks the AuthenX registry only.<br>
            <strong>Live Verify</strong> calls the college ERP in real-time.
          </div>
        </div>
        <div class="card">
          <div class="card-title">Result</div>
          <div id="verifyResult"><p style="color:#9ca3af;font-size:13px">Paste an AuthenX Code and click verify.</p></div>
        </div>
      </div>
    </div>

    <!-- AUDIT -->
    <div id="screen-audit" class="screen">
      <div class="topbar"><h2>Audit Log</h2></div>
      <div class="card">
        <div class="card-title">All Verification Events</div>
        <table><thead><tr><th>Time</th><th>Type</th><th>Employer</th><th>College</th><th>Result</th><th>Hash</th><th>Latency</th></tr></thead>
        <tbody id="auditTable"><tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:24px">Loading...</td></tr></tbody></table>
      </div>
    </div>

  </div><!-- /main -->
</div><!-- /appShell -->

<script>
const API = '';
let TOKEN = null, USER = null;

const api = async (method, path, body) => {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body)  opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};

async function doLogin() {
  const email = document.getElementById('loginEmail').value;
  const pass  = document.getElementById('loginPass').value;
  try {
    const d = await api('POST', '/v1/auth/login', { email, password: pass });
    TOKEN = d.token; USER = d.user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    document.getElementById('sidebarRole').textContent = USER.role.replace('_',' ');
    document.getElementById('dashDate').textContent = new Date().toLocaleString();
    loadDashboard(); loadColleges(); loadTokens(); loadAudit();
  } catch(e) {
    const el = document.getElementById('loginError');
    el.textContent = e.message; el.classList.remove('hidden');
  }
}

function doLogout() {
  TOKEN = null; USER = null;
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'dashboard') loadDashboard();
  if (name === 'audit') loadAudit();
  if (name === 'credentials') { loadCollegesDropdown(); loadTokens(); }
}

async function loadDashboard() {
  try {
    const s = await api('GET', '/v1/audit/stats');
    document.getElementById('s-colleges').textContent = s.stats.colleges;
    document.getElementById('s-tokens').textContent   = s.stats.tokens_active;
    document.getElementById('s-verifs').textContent   = s.stats.verifications;
    document.getElementById('s-revoked').textContent  = s.stats.tokens_revoked;
    const a = await api('GET', '/v1/audit?limit=8');
    const tb = document.getElementById('recentTable');
    if (!a.events.length) { tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px">No events yet</td></tr>'; return; }
    tb.innerHTML = a.events.map(e => {
      const res = e.result === 'verified' ? '<span class="badge badge-green">✓ verified</span>'
                : e.result === 'revoked'  ? '<span class="badge badge-red">✗ revoked</span>'
                : '<span class="badge badge-gray">'+e.result+'</span>';
      return \`<tr><td>\${e.employer_name||'—'}</td><td>\${e.college_name}</td><td>\${e.request_type}</td><td>\${res}</td><td>\${e.latency_ms!=null?e.latency_ms+'ms':'—'}</td><td style="color:#9ca3af">\${relTime(e.created_at)}</td></tr>\`;
    }).join('');
  } catch(e) { console.error(e); }
}

async function loadColleges() {
  try {
    const d = await api('GET', '/v1/colleges');
    const el = document.getElementById('collegeList');
    el.innerHTML = d.colleges.map(c => \`
      <div class="card" style="display:flex;align-items:center;gap:20px">
        <div style="width:48px;height:48px;background:#eff6ff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#1B4F8A">\${c.short_code.slice(0,2)}</div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:15px">\${c.name}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">Connector: \${c.connector_url} &nbsp;·&nbsp; <span class="badge badge-green">● Active</span></div>
          <div class="mono" style="margin-top:6px">pub: \${c.public_key_hex.slice(0,24)}...</div>
        </div>
      </div>\`).join('');
  } catch(e) {}
}

async function loadCollegesDropdown() {
  try {
    const d = await api('GET', '/v1/colleges');
    const sel = document.getElementById('issueCollege');
    sel.innerHTML = d.colleges.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
  } catch(e) {}
}

async function doIssue() {
  try {
    const body = {
      college_id:        document.getElementById('issueCollege').value,
      student_ref_token: document.getElementById('issueRef').value,
      name:              document.getElementById('issueName').value,
      degree:            document.getElementById('issueDegree').value,
      branch:            document.getElementById('issueBranch').value,
      cgpa:              document.getElementById('issueCgpa').value,
      graduation_year:   document.getElementById('issueYear').value,
      credential_type:   document.getElementById('issueType').value,
      // We need an issuance_signature — for web UI demo we call /v1/tokens/sign-demo
      issuance_signature: '__DEMO__',
    };
    // For the web UI: use demo sign endpoint
    const d = await api('POST', '/v1/tokens/issue-demo', body);
    const el = document.getElementById('issueResult');
    el.classList.remove('hidden');
    el.innerHTML = \`<div class="alert alert-success">✓ Token issued</div>
      <div class="code-box">\${d.authenx_code}</div>
      <button class="btn btn-secondary" style="font-size:12px" onclick="document.getElementById('verifyCode').value='\${d.authenx_code}';showScreenDirect('verify')">→ Verify this code</button>\`;
    loadTokens();
  } catch(e) {
    const el = document.getElementById('issueResult');
    el.classList.remove('hidden');
    el.innerHTML = \`<div class="alert alert-error">\${e.message}</div>\`;
  }
}

function showScreenDirect(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
}

async function loadTokens() {
  try {
    const d = await api('GET', '/v1/tokens');
    const tb = document.getElementById('tokenTable');
    if (!d.tokens.length) { tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">No tokens yet</td></tr>'; return; }
    tb.innerHTML = d.tokens.map(t => {
      const badge = t.status==='active' ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-red">revoked</span>';
      return \`<tr><td class="mono">\${t.student_ref_token}</td><td>\${t.college_name}</td><td style="font-size:11px">\${t.credential_type}</td><td>\${badge}</td><td>\${t.status==='active'?'<button class="btn btn-secondary" style="font-size:11px;padding:4px 8px" onclick="doRevoke(\\''+ t.id +'\\')">Revoke</button>':'—'}</td></tr>\`;
    }).join('');
  } catch(e) {}
}

async function doRevoke(id) {
  const reason = prompt('Reason for revocation:');
  if (!reason) return;
  try {
    await api('POST', '/v1/tokens/revoke', { token_id: id, reason });
    loadTokens(); loadDashboard();
  } catch(e) { alert(e.message); }
}

async function doDecodeCode() {
  const code = document.getElementById('verifyCode').value.trim();
  if (!code) return;
  try {
    const d = await api('POST', '/v1/verify/code', { authenx_code: code });
    showVerifyResult(d, 'decode');
  } catch(e) { showVerifyError(e.message); }
}

async function doLiveVerify() {
  const code = document.getElementById('verifyCode').value.trim();
  if (!code) return;
  try {
    const d = await api('POST', '/v1/verify/live', { authenx_code: code });
    showVerifyResult(d, 'live');
    loadDashboard(); loadAudit();
  } catch(e) { showVerifyError(e.message); }
}

function showVerifyResult(d, type) {
  const el = document.getElementById('verifyResult');
  const isVerified = d.result === 'verified';
  const isRevoked  = d.result === 'revoked';
  const cls = isVerified ? 'result-verified' : isRevoked ? 'result-revoked' : 'result-error';
  const icon = isVerified ? '✓' : '✗';
  const color = isVerified ? '#166534' : '#991b1b';

  let fields = '';
  if (d.live_data) {
    fields = Object.entries(d.live_data).map(([k,v]) =>
      \`<div class="result-field"><span class="result-key">\${k}</span><span class="result-val">\${v||'—'}</span></div>\`).join('');
  }
  if (isRevoked) {
    fields = \`<div class="result-field"><span class="result-key">Reason</span><span class="result-val" style="color:#991b1b">\${d.reason||d.revocation_reason||'—'}</span></div>
               <div class="result-field"><span class="result-key">Revoked at</span><span class="result-val">\${d.revoked_at||'—'}</span></div>\`;
  }
  const sigs = type === 'live' ? \`
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid #0000000f">
      <div class="result-field"><span class="result-key">Hash integrity</span><span class="result-val" style="color:\${d.hash_match?'#166534':'#991b1b'}">\${d.hash_match?'MATCH ✓':'MISMATCH ✗'}</span></div>
      <div class="result-field"><span class="result-key">Issuance signature</span><span class="result-val" style="color:\${d.issuance_sig?'#166534':'#991b1b'}">\${d.issuance_sig?'VALID ✓':'INVALID ✗'}</span></div>
      <div class="result-field"><span class="result-key">Live ERP signature</span><span class="result-val" style="color:\${d.live_sig?'#166534':'#6b7280'}">\${d.live_sig?'VALID ✓':'not signed'}</span></div>
      <div class="result-field"><span class="result-key">Latency</span><span class="result-val">\${d.latency_ms}ms</span></div>
    </div>\` : '';

  el.innerHTML = \`<div class="result-box \${cls}">
    <div class="result-title" style="color:\${color}">\${icon} \${d.result.toUpperCase()}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:12px">Issuer: \${d.college}</div>
    \${fields}\${sigs}
  </div>\`;
}

function showVerifyError(msg) {
  document.getElementById('verifyResult').innerHTML = \`<div class="result-box result-error">
    <div class="result-title" style="color:#92400e">⚠ Error</div>
    <div style="font-size:13px;color:#78350f">\${msg}</div>
  </div>\`;
}

async function loadAudit() {
  try {
    const d = await api('GET', '/v1/audit?limit=20');
    const tb = document.getElementById('auditTable');
    if (!d.events.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:24px">No events yet</td></tr>'; return; }
    tb.innerHTML = d.events.map(e => {
      const res = e.result==='verified'?'<span class="badge badge-green">✓ verified</span>'
                : e.result==='revoked'?'<span class="badge badge-red">✗ revoked</span>'
                : '<span class="badge badge-gray">'+e.result+'</span>';
      const hm = e.hash_match!=null ? (e.hash_match?'<span style="color:#166534">✓</span>':'<span style="color:#991b1b">✗</span>') : '—';
      return \`<tr><td style="color:#9ca3af;font-size:11px">\${relTime(e.created_at)}</td><td><span class="badge badge-blue">\${e.request_type}</span></td><td style="font-size:12px">\${e.employer_name||'—'}</td><td>\${e.college_name}</td><td>\${res}</td><td>\${hm}</td><td style="color:#9ca3af">\${e.latency_ms!=null?e.latency_ms+'ms':'—'}</td></tr>\`;
    }).join('');
  } catch(e) {}
}

function relTime(ts) {
  const d = new Date(ts+'Z'); const s = Math.floor((Date.now()-d)/1000);
  if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago'; return d.toLocaleDateString();
}
</script>
</body>
</html>`;

// ─── Demo issue endpoint (for web UI, handles signing internally) ──────────────
/**
 * Sign a payload via the local HSM service.
 * The HSM returns a hex-encoded signature; we convert to base64 to match
 * the format expected by verifyEd25519.
 */
async function signViaHsm(college_id, payload) {
  const hsmPort = parseInt(process.env.HSM_PORT || '9099', 10);
  return new Promise((resolve, reject) => {
    const reqBody = JSON.stringify({ college_id, payload });
    const req = require('node:http').request({
      hostname: '127.0.0.1',
      port: hsmPort,
      path: '/sign',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reqBody),
      },
    }, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.signature) {
            return reject(new Error(parsed.error || `HSM signing failed (HTTP ${response.statusCode})`));
          }
          // HSM returns hex; convert to base64 for verifyEd25519
          resolve(Buffer.from(parsed.signature, 'hex').toString('base64'));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('HSM timeout')); });
    req.write(reqBody);
    req.end();
  });
}

async function issueDemoRoute(req, res, body) {
  const { requireAuth } = require('./middleware/auth.js');
  const claims = requireAuth(req, res);
  if (!claims) return;

  const {
    college_id, student_ref_token, name, degree, branch,
    cgpa, graduation_year, credential_type, issue_date
  } = body;

  if (!college_id || !student_ref_token || !name || !degree || !branch || !credential_type) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }

  const college = queryOne('SELECT * FROM colleges WHERE id = ? AND active = 1', [college_id]);
  if (!college) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College not found' }));
  }

  const fields = {
    schema_version: '1.0', issuer_id: college_id, student_ref_token,
    name, degree, branch, credential_type,
    cgpa: cgpa || '', graduation_year: graduation_year || '',
    issue_date: issue_date || new Date().toISOString().split('T')[0],
  };
  const canonical = buildCanonicalJson(fields);
  const canonical_hash = sha256(canonical);

  // Sign via HSM — uses the college's registered Ed25519 private key
  let issuance_signature;
  try {
    issuance_signature = await signViaHsm(college_id, canonical_hash);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'HSM signing failed — is the HSM service running?', detail: err.message }));
  }

  // Verify the signature immediately to catch key-mismatch early
  const sigOk = verifyEd25519(canonical_hash, issuance_signature, college.public_key_hex);
  if (!sigOk) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'HSM signature does not match college public key — key mismatch detected',
      hint: 'Run node authenx-hsm/server.js and ensure the college public key in the DB matches the HSM key.',
    }));
  }

  // Proper UPDATE/INSERT — avoids FK cascade issues from INSERT OR REPLACE
  const existing = queryOne(
    'SELECT id, status FROM verification_tokens WHERE college_id = ? AND student_ref_token = ?',
    [college_id, student_ref_token]
  );

  let token_id;
  if (existing && existing.status === 'revoked') {
    token_id = existing.id;
    run(`UPDATE verification_tokens SET
         canonical_hash = ?, issuance_signature = ?, schema_version = '1.0',
         credential_type = ?, status = 'active',
         revocation_reason = NULL, revoked_at = NULL,
         issued_at = datetime('now')
         WHERE id = ?`,
      [canonical_hash, issuance_signature, credential_type, token_id]);
  } else if (!existing) {
    token_id = crypto.randomUUID();
    run(`INSERT INTO verification_tokens
         (id, college_id, student_ref_token, canonical_hash, issuance_signature, schema_version, credential_type, status)
         VALUES (?,?,?,?,?,'1.0',?,'active')`,
      [token_id, college_id, student_ref_token, canonical_hash, issuance_signature, credential_type]);
  } else {
    // Active token already exists — re-issue replaces it
    token_id = existing.id;
    run(`UPDATE verification_tokens SET
         canonical_hash = ?, issuance_signature = ?, schema_version = '1.0',
         credential_type = ?, issued_at = datetime('now')
         WHERE id = ?`,
      [canonical_hash, issuance_signature, credential_type, token_id]);
  }

  const authenx_code = encryptCode({
    v: 2, token_id, college_id, student_ref_token, credential_type,
    issued_at: new Date().toISOString(),
    expires_at: null,
    checksum: sha256(`${token_id}:${college_id}:${student_ref_token}:${credential_type}`),
  });

  // Persist the latest issued AuthenX code for this token.
  run(
    `INSERT INTO issued_authenx_codes (token_id, authenx_code, created_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(token_id) DO UPDATE SET
       authenx_code = excluded.authenx_code,
       updated_at = datetime('now')`,
    [token_id, authenx_code]
  );

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Token issued', token_id, canonical_hash, authenx_code }));
}

// ─── Startup Config Validation ───────────────────────────────────────────────
function validateStartupConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // AES_KEY_HEX: must be exactly 64 hex chars (32 bytes) if provided
  if (process.env.AES_KEY_HEX) {
    if (!/^[0-9a-fA-F]{64}$/.test(process.env.AES_KEY_HEX)) {
      errors.push('AES_KEY_HEX must be exactly 64 hex characters (32 bytes)');
    }
  } else if (isProduction) {
    errors.push('AES_KEY_HEX is required in production');
  } else {
    warnings.push('AES_KEY_HEX not set — using persisted dev key from aes_key.json');
  }

  // JWT_SECRET: must be at least 32 chars
  if (process.env.JWT_SECRET) {
    if (process.env.JWT_SECRET.length < 32) {
      errors.push('JWT_SECRET must be at least 32 characters');
    }
  } else if (isProduction) {
    errors.push('JWT_SECRET is required in production');
  } else {
    warnings.push('JWT_SECRET not set — using persisted dev secret from aes_key.json');
  }

  // HSM_MASTER_KEY: required in production
  if (isProduction && !process.env.HSM_MASTER_KEY) {
    warnings.push('HSM_MASTER_KEY not set — HSM will reject startup in production');
  }

  // CORS config
  if (isProduction && !process.env.CORS_ALLOWED_ORIGINS) {
    warnings.push('CORS_ALLOWED_ORIGINS not set — using default localhost origins');
  }

  for (const w of warnings) console.warn(`  ⚠  CONFIG: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ✖  FATAL CONFIG: ${e}`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔷 AuthenX — Academic Credential Infrastructure (Multi-College)');
  console.log('━'.repeat(55));

  validateStartupConfig();

  console.log('→ Initialising database...');
  getDb(); // runs schema migration
  await seedDatabase();

  // ── Key sync: load per-college keys from HSM key-store ──────────────────
  // This ensures the demo issue route can sign with any college's key.
  try {
    const _path = require('node:path');
    const _fs = require('node:fs');

    // Method 1: Multi-college key sync from HSM keys directory
    const hsmKeysDir = _path.join(process.cwd(), '..', 'authenx-hsm', 'keys');
    if (_fs.existsSync(hsmKeysDir)) {
      const keyFiles = _fs.readdirSync(hsmKeysDir).filter(f => f.endsWith('.json'));
      let synced = 0;
      for (const f of keyFiles) {
        try {
          const keyData = JSON.parse(_fs.readFileSync(_path.join(hsmKeysDir, f), 'utf8'));
          if (keyData.college_id && keyData.public_key_hex) {
            run('UPDATE colleges SET public_key_hex = ? WHERE id = ?', [keyData.public_key_hex, keyData.college_id]);
            // Set first key as fallback mock key
            if (!process.env.MOCK_CONNECTOR_PRIV_KEY && keyData.private_key_hex) {
              process.env.MOCK_CONNECTOR_PRIV_KEY = keyData.private_key_hex;
            }
            synced++;
          }
        } catch { /* skip invalid key file */ }
      }
      if (synced > 0) console.log(`  ✓ Synced ${synced} college keys from HSM key-store`);
    }

    // Method 2: Legacy single-key fallback (connector_key.json)
    const keyFile = _path.join(process.cwd(), 'connector_key.json');
    if (_fs.existsSync(keyFile)) {
      const keyData = JSON.parse(_fs.readFileSync(keyFile, 'utf8'));
      if (keyData.privateKeyHex && keyData.publicKeyHex) {
        process.env.MOCK_CONNECTOR_PRIV_KEY = keyData.privateKeyHex;
        console.log('  ✓ Fallback key loaded from connector_key.json');
      }
    }
  } catch (_syncErr) { /* key sync not available — that's OK */ }

  // Inject demo route into router (after routes are loaded)
  const originalRouter = router;
  const wrappedRouter = async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    if (urlObj.pathname === '/v1/tokens/issue-demo' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch { }
      return issueDemoRoute(req, res, body);
    }
    return originalRouter(req, res);
  };

  const server = http.createServer(wrappedRouter);

  // ─── Graceful Shutdown ────────────────────────────────────────────────────
  let isShuttingDown = false;

  function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n🛑 ${signal} received - starting graceful shutdown...`);

    // Stop accepting new connections
    server.close(() => {
      console.log('✓ All connections closed');

      // Flush any pending audit logs
      try {
        const alertCount = fraud.flushAlerts().length;
        if (alertCount > 0) console.log(`✓ Flushed ${alertCount} fraud alerts`);
      } catch { }

      console.log('✅ Shutdown complete');
      process.exit(0);
    });

    // Force close after 10 seconds if graceful shutdown takes too long
    setTimeout(() => {
      console.error('⚠️  Forced shutdown after 10s timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(PORT, '0.0.0.0', () => {
    const collegeCount = query('SELECT COUNT(*) as cnt FROM colleges WHERE active=1')[0]?.cnt || 0;
    const userCount = query('SELECT COUNT(*) as cnt FROM users')[0]?.cnt || 0;

    logStartup({ port: PORT, colleges: collegeCount, users: userCount });

    console.log(`\n✅ Server running → http://localhost:${PORT}`);
    console.log(`   📊 ${collegeCount} colleges | ${userCount} users registered`);
    console.log('\n📋 Test credentials:');
    console.log('   admin@authenx.in       / Admin@123     (super_admin)');
    console.log('   iitb@authenx.in        / College@123   (college_admin)');
    console.log('   recruiter@infosys.com  / Employer@123  (employer)');
    console.log('\n📄 Seed AuthenX Codes saved to → seed_codes.json');
    console.log('\n🔗 API endpoints:');
    console.log('   POST /v1/auth/login         GET  /v1/colleges');
    console.log('   POST /v1/tokens/issue        GET  /v1/tokens');
    console.log('   POST /v1/tokens/revoke       POST /v1/verify/code');
    console.log('   POST /v1/verify/live          GET  /v1/audit');
    console.log('   GET  /v1/metrics              GET  /v1/fraud-alerts');
    console.log('   GET  /v1/connectors/health   GET  /v1/health/detailed');
    console.log('━'.repeat(55));
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

