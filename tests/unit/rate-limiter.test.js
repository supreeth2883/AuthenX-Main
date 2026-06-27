'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { verifyLimiter, issueLimiter, getStats } = require('../../authenx-node/src/middleware/rate-limiter.js');

// Mock response object
function createMockRes() {
  const headers = {};
  let statusCode = null;
  let body = null;
  return {
    headers,
    statusCode,
    body,
    writeHead(code, h) { statusCode = code; Object.assign(headers, h); this.statusCode = code; },
    setHeader(k, v) { headers[k] = v; },
    end(data) { body = data; this.body = data; },
  };
}

// Mock request object
function createMockReq(ip = '127.0.0.1') {
  return { socket: { remoteAddress: ip } };
}

describe('rate-limiter — verifyLimiter', () => {
  it('allows normal traffic', () => {
    const req = createMockReq('10.0.0.' + Date.now() % 256);
    const res = createMockRes();
    const claims = { sub: 'user-unique-' + Date.now() };
    const allowed = verifyLimiter(req, res, claims);
    assert.equal(allowed, true);
    assert.ok(res.headers['X-RateLimit-Remaining'] !== undefined);
  });

  it('blocks after exceeding verify limit (30/min)', () => {
    const uniqueIp = '20.0.0.' + (Date.now() % 200);
    const uniqueUser = 'burst-user-' + Date.now();
    let blocked = false;

    for (let i = 0; i < 35; i++) {
      const req = createMockReq(uniqueIp);
      const res = createMockRes();
      const result = verifyLimiter(req, res, { sub: uniqueUser });
      if (!result) { blocked = true; break; }
    }
    assert.equal(blocked, true);
  });

  it('sets Retry-After header when rate limited', () => {
    const ip = '30.0.0.' + (Date.now() % 200);
    const user = 'retry-test-' + Date.now();
    let lastRes;

    for (let i = 0; i < 35; i++) {
      const req = createMockReq(ip);
      lastRes = createMockRes();
      const result = verifyLimiter(req, lastRes, { sub: user });
      if (!result) break;
    }
    assert.equal(lastRes.statusCode, 429);
    assert.ok(lastRes.headers['Retry-After']);
    assert.ok(lastRes.body.includes('Rate limit'));
  });

  it('uses IP as fallback when no claims', () => {
    const ip = '40.0.0.' + (Date.now() % 200);
    const req = createMockReq(ip);
    const res = createMockRes();
    const allowed = verifyLimiter(req, res, null);
    assert.equal(allowed, true);
  });
});

describe('rate-limiter — issueLimiter', () => {
  it('allows requests within limit', () => {
    const req = createMockReq('50.0.0.' + (Date.now() % 200));
    const res = createMockRes();
    const allowed = issueLimiter(req, res, { sub: 'issuer-' + Date.now() });
    assert.equal(allowed, true);
  });

  it('blocks after exceeding issue limit (20/min)', () => {
    const ip = '60.0.0.' + (Date.now() % 200);
    const user = 'issue-burst-' + Date.now();
    let blocked = false;

    for (let i = 0; i < 25; i++) {
      const req = createMockReq(ip);
      const res = createMockRes();
      const result = issueLimiter(req, res, { sub: user });
      if (!result) { blocked = true; break; }
    }
    assert.equal(blocked, true);
  });
});

describe('rate-limiter — getStats', () => {
  it('returns monitoring stats object', () => {
    const stats = getStats();
    assert.ok('verify_active_keys' in stats);
    assert.ok('issue_active_keys' in stats);
    assert.ok('global_active_ips' in stats);
    assert.equal(stats.window_ms, 60000);
    assert.deepEqual(stats.limits, { verify: 30, issue: 20, global: 200 });
  });
});

describe('rate-limiter — global IP limit', () => {
  it('blocks at 200 requests/min from same IP regardless of user', () => {
    const ip = '70.0.0.' + (Date.now() % 200);
    let blocked = false;

    for (let i = 0; i < 210; i++) {
      const req = createMockReq(ip);
      const res = createMockRes();
      // Different user each time to avoid per-user limit
      const result = verifyLimiter(req, res, { sub: `user-${ip}-${i}` });
      if (!result) { blocked = true; break; }
    }
    assert.equal(blocked, true);
  });
});
