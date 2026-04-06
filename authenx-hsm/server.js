'use strict';
/**
 * AuthenX HSM — Hardware Security Module (Simulation)
 * Multi-college key management & signing service.
 *
 * Endpoints:
 *   POST /sign           { college_id, payload } → { signature }
 *   POST /rotate-key     { college_id }          → { public_key_hex, version }
 *   GET  /keys                                   → list of managed colleges
 *   GET  /health                                 → service status
 *
 * Security:
 *   - Only accepts connections from localhost (127.0.0.1 / ::1)
 *   - Private keys NEVER leave this service
 *   - All operations are audit logged
 */

const { createServer } = require('node:http');
const keyStore = require('./key-store.js');

const PORT = process.env.HSM_PORT || 9099;

// ─── Localhost-only access control ────────────────────────────────────────────
function isLocalhost(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ─── Body reader ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024) { req.destroy(); return reject(new Error('Payload too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Request handler ──────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Restrict to localhost
  if (!isLocalhost(req)) {
    res.writeHead(403);
    return res.end(JSON.stringify({ error: 'HSM access restricted to localhost' }));
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'authenx-hsm',
      keys_loaded: keyStore.listKeys().length,
      uptime_s: Math.floor(process.uptime()),
    }));
  }

  // ── List keys (public info only) ────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/keys') {
    res.writeHead(200);
    return res.end(JSON.stringify({ keys: keyStore.listKeys() }));
  }

  // ── Sign ────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/sign') {
    try {
      const body = await readBody(req);
      const { college_id, payload } = body;

      if (!payload) throw new Error('Missing payload');

      // Backward compat: if no college_id, try to sign with ANY loaded key
      let signature;
      if (college_id) {
        signature = keyStore.sign(college_id, payload);
      } else {
        // Legacy single-key mode: use the first available key
        const keys = keyStore.listKeys();
        if (keys.length === 0) throw new Error('No keys loaded');
        signature = keyStore.sign(keys[0].college_id, payload);
      }

      res.writeHead(200);
      return res.end(JSON.stringify({ signature }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Rotate key ──────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/rotate-key') {
    try {
      const { college_id } = await readBody(req);
      if (!college_id) throw new Error('college_id is required');
      const result = keyStore.rotateKey(college_id);
      res.writeHead(200);
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const loaded = keyStore.preloadAll();
console.log(`\n🔐 AuthenX HSM — Multi-College Key Vault`);
console.log(`   Port: ${PORT} | Keys loaded: ${loaded}`);
console.log(`   Access: localhost only\n`);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`   ✅ HSM online → http://127.0.0.1:${PORT}`);
});
