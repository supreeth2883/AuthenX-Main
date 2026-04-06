'use strict';
/**
 * AuthenX — Circuit Breaker for College Connectors
 *
 * Prevents cascading failures when a college connector is unreachable.
 * Per-college circuit breaker — one slow college doesn't affect others.
 *
 * States:
 *   CLOSED   → Normal operation. Requests pass through.
 *   OPEN     → Too many failures. All requests fail fast (no network call).
 *   HALF_OPEN → Testing recovery. One request allowed through.
 *
 * Thresholds (default):
 *   - 5 consecutive failures  → Opens the circuit
 *   - 30 seconds open         → Moves to HALF_OPEN
 *   - 1 success in HALF_OPEN  → Closes circuit
 */

const FAILURE_THRESHOLD  = 5;
const RECOVERY_TIMEOUT   = 30_000; // 30 seconds
const SUCCESS_THRESHOLD  = 1;      // successful responses to close

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

const breakers = new Map(); // college_id → breaker state

function getBreaker(college_id) {
  if (!breakers.has(college_id)) {
    breakers.set(college_id, {
      state:        STATE.CLOSED,
      failures:     0,
      successes:    0,
      last_failure: null,
      opened_at:    null,
    });
  }
  return breakers.get(college_id);
}

/**
 * Wrap a connector call with circuit breaker logic.
 * @param {string} college_id - The college whose connector to call
 * @param {Function} fn - Async function that calls the connector
 * @returns Promise<result>
 * @throws Error if circuit is OPEN
 */
async function callWithBreaker(college_id, fn) {
  const breaker = getBreaker(college_id);
  const now = Date.now();

  if (breaker.state === STATE.OPEN) {
    // Check if recovery timeout has passed
    if (now - breaker.opened_at >= RECOVERY_TIMEOUT) {
      breaker.state    = STATE.HALF_OPEN;
      breaker.successes = 0;
      console.log(`[circuit-breaker] ${college_id} → HALF_OPEN (testing recovery)`);
    } else {
      const wait = Math.ceil((breaker.opened_at + RECOVERY_TIMEOUT - now) / 1000);
      throw new Error(`College connector is temporarily unavailable. Retry in ${wait}s.`);
    }
  }

  try {
    const result = await fn();

    // Success path
    if (breaker.state === STATE.HALF_OPEN) {
      breaker.successes++;
      if (breaker.successes >= SUCCESS_THRESHOLD) {
        breaker.state    = STATE.CLOSED;
        breaker.failures = 0;
        console.log(`[circuit-breaker] ${college_id} → CLOSED (recovered)`);
      }
    } else {
      breaker.failures = 0; // reset on success
    }

    return result;
  } catch (err) {
    // Failure path
    breaker.failures++;
    breaker.last_failure = new Date().toISOString();

    if (breaker.state === STATE.HALF_OPEN || breaker.failures >= FAILURE_THRESHOLD) {
      breaker.state     = STATE.OPEN;
      breaker.opened_at = Date.now();
      console.warn(`[circuit-breaker] ${college_id} → OPEN after ${breaker.failures} failures`);
    }

    throw err;
  }
}

/** Get circuit state for a college (for admin monitoring) */
function getBreakerState(college_id) {
  const b = breakers.get(college_id);
  if (!b) return { state: STATE.CLOSED, failures: 0 };
  return {
    state:         b.state,
    failures:      b.failures,
    last_failure:  b.last_failure,
    opened_at:     b.opened_at ? new Date(b.opened_at).toISOString() : null,
    recovering_in: b.state === STATE.OPEN
      ? Math.max(0, Math.ceil((b.opened_at + RECOVERY_TIMEOUT - Date.now()) / 1000))
      : null,
  };
}

/** Get all circuit states (for admin dashboard) */
function getAllBreakerStates() {
  const result = {};
  for (const [id] of breakers) result[id] = getBreakerState(id);
  return result;
}

/** Manually reset a breaker (admin action) */
function resetBreaker(college_id) {
  breakers.delete(college_id);
}

module.exports = { callWithBreaker, getBreakerState, getAllBreakerStates, resetBreaker, STATE };
