'use strict';
/**
 * AuthenX — HTTP Client Utility
 *
 * Single implementation of outgoing JSON HTTP requests, replacing 5+
 * inline copies across verify.js, connector-proxy.js, and server.js.
 *
 * Zero external dependencies — Node built-in http/https only.
 */

const http  = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

/**
 * Make an outgoing HTTP/HTTPS JSON request.
 *
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} url - Full URL including protocol
 * @param {string|null} [body=null] - Pre-stringified JSON body (null for GET)
 * @param {object} [headers={}] - Extra headers to merge
 * @param {number} [timeoutMs=8000] - Request timeout in milliseconds
 * @returns {Promise<{status: number, json: object|null, raw: string}>}
 */
function makeJsonRequest(method, url, body = null, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;

    const reqHeaders = { 'Accept': 'application/json', ...headers };
    if (body != null) {
      reqHeaders['Content-Type']   = reqHeaders['Content-Type'] || 'application/json';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }

    const request = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   method.toUpperCase(),
      headers:  reqHeaders,
    }, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : {}; } catch { /* non-JSON response */ }
        resolve({ status: response.statusCode || 0, json, raw: data });
      });
    });

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    if (body != null) request.write(body);
    request.end();
  });
}

module.exports = { makeJsonRequest };
