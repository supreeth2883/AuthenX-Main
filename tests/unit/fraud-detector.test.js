'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeVerification,
  analyzeCodeAttempt,
  flushAlerts,
  pendingCount,
} = require('../../authenx-node/src/middleware/fraud-detector.js');

describe('fraud-detector — analyzeVerification', () => {
  beforeEach(() => {
    flushAlerts(); // clear alert buffer
  });

  it('returns empty array for normal single request', () => {
    const alerts = analyzeVerification({
      employer_id: 'emp-normal-' + Date.now(),
      employer_email: 'hr@company.com',
      ip: '192.168.1.1',
      student_ref: 'STU001',
    });
    // Might trigger OFF_HOURS depending on time; filter for specific types
    const nonTimeAlerts = alerts.filter(a => a.alert_type !== 'OFF_HOURS');
    assert.deepEqual(nonTimeAlerts, []);
  });

  it('returns empty array when employer_id is missing', () => {
    const alerts = analyzeVerification({ ip: '1.1.1.1', student_ref: 'x' });
    assert.deepEqual(alerts, []);
  });

  it('triggers RAPID_FIRE after >10 requests in 60s', () => {
    const empId = 'rapid-' + Date.now();
    let triggered = [];
    for (let i = 0; i < 12; i++) {
      triggered = analyzeVerification({
        employer_id: empId,
        employer_email: 'attacker@evil.com',
        ip: '10.0.0.1',
        student_ref: `STU${i}`,
      });
    }
    const rapidFire = triggered.filter(a => a.alert_type === 'RAPID_FIRE');
    assert.ok(rapidFire.length > 0, 'Should detect RAPID_FIRE');
    assert.equal(rapidFire[0].severity, 'high');
  });

  it('triggers SEQUENTIAL_SCAN for consecutive student refs', () => {
    const empId = 'scanner-' + Date.now();
    let triggered = [];
    // Send refs with sequential numbers: STU001, STU002, STU003
    for (let i = 1; i <= 4; i++) {
      triggered = analyzeVerification({
        employer_id: empId,
        employer_email: 'scan@evil.com',
        ip: '10.0.0.2',
        student_ref: `STU${i}`,
      });
    }
    const seqScan = triggered.filter(a => a.alert_type === 'SEQUENTIAL_SCAN');
    assert.ok(seqScan.length > 0, 'Should detect SEQUENTIAL_SCAN');
    assert.equal(seqScan[0].severity, 'critical');
  });

  it('triggers GEO_ANOMALY for multiple IPs in 5 minutes', () => {
    const empId = 'geo-' + Date.now();
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];
    let triggered = [];
    for (const ip of ips) {
      triggered = analyzeVerification({
        employer_id: empId,
        employer_email: 'geo@evil.com',
        ip,
        student_ref: 'STU100',
      });
    }
    const geoAnomaly = triggered.filter(a => a.alert_type === 'GEO_ANOMALY');
    assert.ok(geoAnomaly.length > 0, 'Should detect GEO_ANOMALY');
    assert.equal(geoAnomaly[0].severity, 'medium');
  });
});

describe('fraud-detector — analyzeCodeAttempt', () => {
  beforeEach(() => {
    flushAlerts();
  });

  it('returns empty array for valid code attempt', () => {
    const alerts = analyzeCodeAttempt({ ip: '10.10.10.' + Date.now(), valid: true });
    assert.deepEqual(alerts, []);
  });

  it('triggers BRUTE_FORCE after 5+ invalid code attempts', () => {
    const ip = '99.99.99.' + (Date.now() % 256);
    let triggered = [];
    for (let i = 0; i < 6; i++) {
      triggered = analyzeCodeAttempt({ ip, valid: false });
    }
    const brute = triggered.filter(a => a.alert_type === 'BRUTE_FORCE');
    assert.ok(brute.length > 0, 'Should detect BRUTE_FORCE');
    assert.equal(brute[0].severity, 'high');
  });

  it('does not trigger if IP is missing', () => {
    const alerts = analyzeCodeAttempt({ valid: false });
    assert.deepEqual(alerts, []);
  });
});

describe('fraud-detector — flushAlerts', () => {
  it('returns and clears the alert buffer', () => {
    // Generate some alerts
    const empId = 'flush-' + Date.now();
    for (let i = 0; i < 12; i++) {
      analyzeVerification({
        employer_id: empId,
        employer_email: 'x@y.com',
        ip: '1.2.3.4',
        student_ref: `REF${i}`,
      });
    }
    assert.ok(pendingCount() > 0);
    const flushed = flushAlerts();
    assert.ok(flushed.length > 0);
    assert.equal(pendingCount(), 0);
  });

  it('returns empty array when no alerts pending', () => {
    flushAlerts(); // clear first
    const flushed = flushAlerts();
    assert.deepEqual(flushed, []);
  });
});

describe('fraud-detector — alert structure', () => {
  it('has required fields', () => {
    flushAlerts();
    const empId = 'struct-' + Date.now();
    for (let i = 0; i < 12; i++) {
      analyzeVerification({
        employer_id: empId,
        employer_email: 'test@co.com',
        ip: '5.5.5.5',
        student_ref: `S${i}`,
      });
    }
    const alerts = flushAlerts();
    const alert = alerts[0];
    assert.ok(alert.id);
    assert.ok(alert.alert_type);
    assert.ok(alert.severity);
    assert.ok(alert.created_at);
    assert.ok(typeof alert.details === 'string');
  });
});
