'use strict';
/**
 * AuthenX Structured JSON Logger — Enhanced
 *
 * Features:
 *   - Correlation ID propagation (request → connector → response)
 *   - Structured JSON output (one object per line)
 *   - Daily rotating log files (logs/authenx-YYYY-MM-DD.jsonl)
 *   - Log levels: DEBUG, INFO, WARN, ERROR, FATAL
 *   - Security event logging
 *   - Request lifecycle tracking with latency
 *
 * Zero external dependencies.
 */

const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const MIN_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];
const LOG_DIR    = path.join(process.cwd(), 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (err) {
    console.error('[logger] Failed to create log directory:', err.message);
  }
}

// ─── Daily log file writer ────────────────────────────────────────────────────
let currentDate = '';
let logStream   = null;

function getLogStream() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== currentDate || !logStream) {
    if (logStream) {
      try { logStream.end(); } catch (err) {
        console.error('[logger] Failed to close previous log stream:', err.message);
      }
    }
    currentDate = today;
    const logFile = path.join(LOG_DIR, `authenx-${today}.jsonl`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return logStream;
}

// ─── Core log function ────────────────────────────────────────────────────────
function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  const line = JSON.stringify(entry) + '\n';

  // Write to stdout (for container/systemd capture)
  process.stdout.write(line);

  // Write to daily log file
  try {
    const stream = getLogStream();
    stream.write(line);
  } catch (err) {
    console.error('[logger] Failed to write to log file:', err.message);
  }
}

// ─── Generate unique IDs ──────────────────────────────────────────────────────
function generateRequestId() {
  return crypto.randomUUID();
}

function generateCorrelationId() {
  return `corr-${crypto.randomBytes(8).toString('hex')}`;
}

// ─── Request-scoped logger ────────────────────────────────────────────────────
/**
 * Create a logger instance scoped to a single HTTP request.
 * Tracks correlation ID, start time, IP, and provides lifecycle methods.
 */
function createRequestLogger(req) {
  const requestId     = generateRequestId();
  const correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
  const startTime     = Date.now();
  const ip            = req.socket.remoteAddress || 'unknown';
  const userAgent     = req.headers['user-agent'] || 'unknown';

  const baseFields = {
    request_id:     requestId,
    correlation_id: correlationId,
    ip,
  };

  return {
    requestId,
    correlationId,
    startTime,

    debug: (msg, meta = {}) => log('debug', msg, { ...baseFields, ...meta }),
    info:  (msg, meta = {}) => log('info',  msg, { ...baseFields, ...meta }),
    warn:  (msg, meta = {}) => log('warn',  msg, { ...baseFields, ...meta }),
    error: (msg, meta = {}) => log('error', msg, { ...baseFields, ...meta }),
    fatal: (msg, meta = {}) => log('fatal', msg, { ...baseFields, ...meta }),

    /** Log completed request with full lifecycle data */
    finish: (statusCode, path, method) => {
      const latency_ms = Date.now() - startTime;
      log('info', 'request_completed', {
        ...baseFields,
        method,
        path,
        status: statusCode,
        latency_ms,
        user_agent: userAgent,
      });
    },

    /** Attach extra context (user_id, college_id, etc.) after auth */
    withContext: (ctx) => {
      Object.assign(baseFields, ctx);
    },
  };
}

// ─── Security event logger ────────────────────────────────────────────────────
/**
 * Log a security-relevant event (login, lockout, revocation, etc.)
 * These are also written to the structured log file for SIEM ingestion.
 */
function logSecurity(eventType, details = {}) {
  log('warn', 'security_event', {
    event_type: eventType,
    ...details,
  });
}

// ─── Startup banner ───────────────────────────────────────────────────────────
function logStartup(info = {}) {
  log('info', 'server_started', {
    node_version: process.version,
    pid: process.pid,
    ...info,
  });
}

module.exports = {
  log,
  createRequestLogger,
  logSecurity,
  logStartup,
  generateRequestId,
  generateCorrelationId,
};
