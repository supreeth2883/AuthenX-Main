'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const { queryOne } = require('../db/client.js');
const { requireAuth } = require('../middleware/auth.js');
const { signRequest } = require('../middleware/hmac-auth.js');

function getCollegeConnector(claims) {
  if (!claims?.college_id) return null;
  return queryOne(
    'SELECT id, name, connector_url, shared_secret FROM colleges WHERE id = ? AND active = 1',
    [claims.college_id]
  );
}

function requestJson(method, urlString, bodyString, extraHeaders = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const headers = {
      'Accept': 'application/json',
      ...extraHeaders,
    };
    if (bodyString != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    const req = mod.request({
      method,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        resolve({ status: res.statusCode || 0, json: parsed, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (bodyString != null) req.write(bodyString);
    req.end();
  });
}

/**
 * GET /v1/connector/health
 * Server-side proxy to college connector /health.
 */
async function connectorHealth(req, res) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = getCollegeConnector(claims);
  if (!college) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No college in session' }));
  }

  const connectorUrl = college.connector_url;
  if (!connectorUrl || connectorUrl === 'mock' || connectorUrl.startsWith('internal://')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'mock',
      college: college.name,
      college_id: college.id,
      connector_url: connectorUrl || null,
    }));
  }

  try {
    const start = Date.now();
    const r = await requestJson('GET', new URL('/health', connectorUrl).toString(), null, {}, 3000);
    const latency_ms = Date.now() - start;
    if (r.status >= 200 && r.status < 300) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...r.json, connector_url: connectorUrl, latency_ms }));
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector returned non-200', status: r.status, connector_url: connectorUrl }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector unreachable', detail: err.message, connector_url: connectorUrl }));
  }
}

/**
 * POST /v1/connector/verify
 * Body: { student_ref_token, nonce }
 * Server-side proxy to connector /verify with HMAC headers.
 */
async function connectorVerify(req, res, body) {
  const claims = requireAuth(req, res);
  if (!claims) return;

  const college = getCollegeConnector(claims);
  if (!college) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No college in session' }));
  }

  const { student_ref_token, nonce } = body || {};
  if (!student_ref_token || !nonce) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'student_ref_token and nonce are required' }));
  }

  const connectorUrl = college.connector_url;
  if (!connectorUrl || connectorUrl === 'mock' || connectorUrl.startsWith('internal://')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector is in mock mode', connector_url: connectorUrl || null }));
  }

  if (!college.shared_secret) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'College shared_secret missing in DB' }));
  }

  const payload = { student_ref_token: String(student_ref_token), nonce: String(nonce) };
  const rawBody = JSON.stringify(payload);
  const headers = signRequest('POST', '/verify', rawBody, college.shared_secret, college.id);

  try {
    const start = Date.now();
    const r = await requestJson('POST', new URL('/verify', connectorUrl).toString(), rawBody, headers, 5000);
    const latency_ms = Date.now() - start;
    if (r.status >= 200 && r.status < 300) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...r.json, connector_latency_ms: latency_ms }));
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Connector verify failed',
      status: r.status,
      connector_url: connectorUrl,
      detail: r.json?.error || r.raw || null,
    }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Connector verify unreachable', detail: err.message, connector_url: connectorUrl }));
  }
}

module.exports = { connectorHealth, connectorVerify };

