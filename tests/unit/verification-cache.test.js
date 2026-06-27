'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../../authenx-node/src/cache/verification-cache.js');

describe('verification-cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('returns null for uncached token', () => {
    assert.equal(cache.get('non-existent-token'), null);
  });

  it('stores and retrieves verified result', () => {
    const result = { result: 'verified', hash_match: true, signature_valid: true };
    cache.set('tok-1', result);
    const cached = cache.get('tok-1');
    assert.equal(cached.result, 'verified');
    assert.equal(cached.cached, true);
    assert.equal(cached.live_data, null); // never caches live data
  });

  it('does not cache error results', () => {
    cache.set('tok-err', { result: 'error', message: 'timeout' });
    assert.equal(cache.get('tok-err'), null);
  });

  it('does not cache fallback_verified results', () => {
    cache.set('tok-fb', { result: 'fallback_verified' });
    assert.equal(cache.get('tok-fb'), null);
  });

  it('invalidates a specific token', () => {
    cache.set('tok-2', { result: 'verified' });
    assert.ok(cache.get('tok-2') !== null);
    cache.invalidate('tok-2');
    assert.equal(cache.get('tok-2'), null);
  });

  it('reports correct size', () => {
    assert.equal(cache.size(), 0);
    cache.set('a', { result: 'verified' });
    cache.set('b', { result: 'revoked' });
    assert.equal(cache.size(), 2);
  });

  it('clear empties the cache', () => {
    cache.set('x', { result: 'verified' });
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.equal(cache.get('x'), null);
  });

  it('evicts oldest entry when max capacity reached', () => {
    // Fill to max (500)
    for (let i = 0; i < 500; i++) {
      cache.set(`cap-${i}`, { result: 'verified' });
    }
    assert.equal(cache.size(), 500);

    // Adding one more should evict the first
    cache.set('cap-new', { result: 'verified' });
    assert.equal(cache.size(), 500);
    assert.equal(cache.get('cap-0'), null); // first was evicted
    assert.ok(cache.get('cap-new') !== null);
  });

  it('strips live_data from cached results', () => {
    cache.set('tok-privacy', {
      result: 'verified',
      live_data: { name: 'Alice', cgpa: '9.0' },
    });
    const cached = cache.get('tok-privacy');
    assert.equal(cached.live_data, null);
  });
});
