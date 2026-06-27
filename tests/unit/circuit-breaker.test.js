'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  callWithBreaker,
  getBreakerState,
  getAllBreakerStates,
  resetBreaker,
  STATE,
} = require('../../authenx-node/src/middleware/circuit-breaker.js');

describe('circuit-breaker — initial state', () => {
  it('returns CLOSED state for unknown college', () => {
    const state = getBreakerState('unknown-college-xyz');
    assert.equal(state.state, STATE.CLOSED);
    assert.equal(state.failures, 0);
  });
});

describe('circuit-breaker — callWithBreaker', () => {
  const testCollege = 'test-college-' + Date.now();

  beforeEach(() => {
    resetBreaker(testCollege);
  });

  it('passes through successful calls', async () => {
    const result = await callWithBreaker(testCollege, async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(getBreakerState(testCollege).state, STATE.CLOSED);
  });

  it('propagates errors without opening for < threshold failures', async () => {
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        () => callWithBreaker(testCollege, async () => { throw new Error('fail'); }),
        { message: 'fail' }
      );
    }
    assert.equal(getBreakerState(testCollege).state, STATE.CLOSED);
    assert.equal(getBreakerState(testCollege).failures, 4);
  });

  it('opens circuit after 5 consecutive failures', async () => {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => callWithBreaker(testCollege, async () => { throw new Error('down'); })
      );
    }
    assert.equal(getBreakerState(testCollege).state, STATE.OPEN);
  });

  it('rejects immediately when circuit is OPEN', async () => {
    // Force open
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => callWithBreaker(testCollege, async () => { throw new Error('down'); })
      );
    }

    await assert.rejects(
      () => callWithBreaker(testCollege, async () => 'should not run'),
      /temporarily unavailable/
    );
  });

  it('resets failure count on success', async () => {
    // Accumulate some failures
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => callWithBreaker(testCollege, async () => { throw new Error('fail'); })
      );
    }
    // One success resets
    await callWithBreaker(testCollege, async () => 'ok');
    assert.equal(getBreakerState(testCollege).failures, 0);
  });
});

describe('circuit-breaker — resetBreaker', () => {
  it('clears breaker state', async () => {
    const col = 'reset-test-' + Date.now();
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => callWithBreaker(col, async () => { throw new Error('fail'); })
      );
    }
    assert.equal(getBreakerState(col).state, STATE.OPEN);
    resetBreaker(col);
    assert.equal(getBreakerState(col).state, STATE.CLOSED);
  });
});

describe('circuit-breaker — getAllBreakerStates', () => {
  it('returns object with all tracked colleges', async () => {
    const col = 'all-states-' + Date.now();
    await callWithBreaker(col, async () => 'ok');
    const all = getAllBreakerStates();
    assert.ok(typeof all === 'object');
    assert.ok(col in all);
  });
});
