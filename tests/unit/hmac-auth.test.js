'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signRequest, verifyRequest } = require('../../authenx-node/src/middleware/hmac-auth.js');

const SHARED_SECRET = crypto.randomBytes(32).toString('hex');

describe('hmac-auth — signRequest', () => {
  it('returns required authentication headers', () => {
    const headers = signRequest('POST', '/verify', '{"token_id":"x"}', SHARED_SECRET, 'college-1');
    assert.ok(headers['X-AuthenX-Timestamp']);
    assert.ok(headers['X-AuthenX-Signature']);
    assert.equal(headers['X-AuthenX-College-ID'], 'college-1');
  });

  it('signature is a 64-char hex string (SHA-256)', () => {
    const headers = signRequest('POST', '/verify', '{}', SHARED_SECRET, 'c1');
    assert.match(headers['X-AuthenX-Signature'], /^[0-9a-f]{64}$/);
  });

  it('timestamp is a recent Unix timestamp', () => {
    const headers = signRequest('POST', '/verify', '{}', SHARED_SECRET, 'c1');
    const ts = parseInt(headers['X-AuthenX-Timestamp'], 10);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(now - ts) <= 2);
  });
});

describe('hmac-auth — verifyRequest', () => {
  it('verifies a freshly signed request', () => {
    const body = JSON.stringify({ token_id: 'tok-1', nonce: 'abc' });
    const headers = signRequest('POST', '/verify', body, SHARED_SECRET, 'col-1');

    const req = {
      method: 'POST',
      url: '/verify',
      headers: {
        'x-authenx-timestamp': headers['X-AuthenX-Timestamp'],
        'x-authenx-signature': headers['X-AuthenX-Signature'],
        'x-authenx-college-id': headers['X-AuthenX-College-ID'],
      },
    };

    const result = verifyRequest(req, body, SHARED_SECRET);
    assert.equal(result.valid, true);
  });

  it('rejects request with missing headers', () => {
    const req = { method: 'POST', url: '/verify', headers: {} };
    const result = verifyRequest(req, '{}', SHARED_SECRET);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Missing'));
  });

  it('rejects request with wrong secret', () => {
    const body = '{"test":1}';
    const headers = signRequest('POST', '/verify', body, SHARED_SECRET, 'col-1');
    const wrongSecret = crypto.randomBytes(32).toString('hex');

    const req = {
      method: 'POST',
      url: '/verify',
      headers: {
        'x-authenx-timestamp': headers['X-AuthenX-Timestamp'],
        'x-authenx-signature': headers['X-AuthenX-Signature'],
      },
    };

    const result = verifyRequest(req, body, wrongSecret);
    assert.equal(result.valid, false);
  });

  it('rejects request with stale timestamp', () => {
    const body = '{}';
    const staleTs = String(Math.floor(Date.now() / 1000) - 120); // 2 min old
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const message = `POST:/verify:${staleTs}:${bodyHash}`;
    const sig = crypto.createHmac('sha256', Buffer.from(SHARED_SECRET, 'hex'))
      .update(message).digest('hex');

    const req = {
      method: 'POST',
      url: '/verify',
      headers: {
        'x-authenx-timestamp': staleTs,
        'x-authenx-signature': sig,
      },
    };

    const result = verifyRequest(req, body, SHARED_SECRET);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('drift'));
  });

  it('rejects request with tampered body', () => {
    const body = '{"original":true}';
    const headers = signRequest('POST', '/verify', body, SHARED_SECRET, 'col-1');

    const req = {
      method: 'POST',
      url: '/verify',
      headers: {
        'x-authenx-timestamp': headers['X-AuthenX-Timestamp'],
        'x-authenx-signature': headers['X-AuthenX-Signature'],
      },
    };

    const result = verifyRequest(req, '{"tampered":true}', SHARED_SECRET);
    assert.equal(result.valid, false);
  });
});
