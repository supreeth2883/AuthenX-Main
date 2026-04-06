'use strict';
/**
 * AuthenX Connector — REST API Adapter
 * Zero npm dependencies — uses Node built-in http/https.
 *
 * For colleges that expose their ERP via a REST API.
 * Supports: GET and POST endpoints, JSON responses, Bearer/API key auth.
 *
 * Config example:
 *   "db_type": "api",
 *   "api": {
 *     "base_url": "https://erp.college.edu/api",
 *     "endpoint": "/students/{ref}",         ← {ref} replaced with student_ref_token
 *     "method": "GET",
 *     "auth_type": "bearer",                 ← bearer | api_key | basic | none
 *     "auth_token": "your-secret-token",
 *     "api_key_header": "X-API-Key",
 *     "timeout_ms": 8000
 *   }
 */

const http  = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const mod      = parsed.protocol === 'https:' ? https : http;
    const timeout  = options.timeout_ms || 8_000;
    const method   = (options.method || 'GET').toUpperCase();
    const body     = options.body ? JSON.stringify(options.body) : null;

    const headers = {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode >= 400) return reject(new Error(`API responded ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('API returned non-JSON response')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`API request timed out after ${timeout}ms`));
    });

    if (body) req.write(body);
    req.end();
  });
}

function buildAuthHeaders(apiConfig) {
  const headers = {};
  switch (apiConfig.auth_type) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${apiConfig.auth_token}`;
      break;
    case 'api_key':
      headers[apiConfig.api_key_header || 'X-API-Key'] = apiConfig.auth_token;
      break;
    case 'basic': {
      const creds = Buffer.from(`${apiConfig.user}:${apiConfig.password}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
      break;
    }
    default:
      break; // no auth
  }
  return headers;
}

async function connect(dbConfig) {
  // No persistent connection for HTTP — validate config only
  if (!dbConfig.api?.base_url) throw new Error('api.base_url is required for api adapter');
  if (!dbConfig.api?.endpoint) throw new Error('api.endpoint is required for api adapter');
  console.log(`[api-adapter] Configured → ${dbConfig.api.base_url}${dbConfig.api.endpoint}`);
}

async function fetchStudent({ api: apiConfig, field_mapping }, { student_ref_token }) {
  const endpoint = apiConfig.endpoint.replace('{ref}', encodeURIComponent(student_ref_token));
  const url = apiConfig.base_url.replace(/\/$/, '') + endpoint;
  const headers = buildAuthHeaders(apiConfig);

  let data;
  if ((apiConfig.method || 'GET').toUpperCase() === 'POST') {
    data = await makeRequest(url, {
      method: 'POST',
      body: { student_ref: student_ref_token, ...(apiConfig.request_body || {}) },
      headers,
      timeout_ms: apiConfig.timeout_ms,
    });
  } else {
    data = await makeRequest(url, { method: 'GET', headers, timeout_ms: apiConfig.timeout_ms });
  }

  return data; // raw API response — field_mapping will extract needed fields
}

async function testConnection(dbConfig) {
  try {
    await connect(dbConfig);
    // Try a health check endpoint if configured, otherwise just validate config
    if (dbConfig.api.health_endpoint) {
      const url = dbConfig.api.base_url.replace(/\/$/, '') + dbConfig.api.health_endpoint;
      await makeRequest(url, { headers: buildAuthHeaders(dbConfig.api), timeout_ms: 5000 });
    }
    return { ok: true, message: 'API connector configured successfully' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// API adapter doesn't support listing tables/columns (schema introspection not applicable)
async function listTables() { return []; }
async function listColumns() { return []; }

module.exports = { connect, fetchStudent, testConnection, listTables, listColumns, makeRequest, buildAuthHeaders };
