'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitize,
  sanitizeObject,
  isValidUUID,
  isValidEmail,
  validatePasswordStrength,
  validateString,
  validateRequired,
} = require('../../authenx-node/src/middleware/validation.js');

describe('validation — sanitize', () => {
  it('escapes HTML angle brackets', () => {
    assert.equal(sanitize('<script>alert("xss")</script>'), '&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('leaves normal strings unchanged', () => {
    assert.equal(sanitize('Hello World'), 'Hello World');
  });

  it('returns non-string values unchanged', () => {
    assert.equal(sanitize(42), 42);
    assert.equal(sanitize(null), null);
    assert.equal(sanitize(undefined), undefined);
  });
});

describe('validation — sanitizeObject', () => {
  it('recursively sanitizes all string values', () => {
    const input = {
      name: '<b>Bold</b>',
      nested: { email: 'a@b.com', xss: '<img src=x>' },
      tags: ['<i>tag</i>', 'clean'],
    };
    const result = sanitizeObject(input);
    assert.equal(result.name, '&lt;b&gt;Bold&lt;/b&gt;');
    assert.equal(result.nested.email, 'a@b.com');
    assert.equal(result.nested.xss, '&lt;img src=x&gt;');
    assert.equal(result.tags[0], '&lt;i&gt;tag&lt;/i&gt;');
    assert.equal(result.tags[1], 'clean');
  });

  it('handles null/non-object input', () => {
    assert.equal(sanitizeObject(null), null);
    assert.equal(sanitizeObject(undefined), undefined);
    assert.equal(sanitizeObject(42), 42);
  });

  it('preserves non-string values in arrays', () => {
    const result = sanitizeObject({ items: [1, 2, 3] });
    assert.deepEqual(result.items, [1, 2, 3]);
  });
});

describe('validation — isValidUUID', () => {
  it('accepts valid UUIDs', () => {
    assert.equal(isValidUUID('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), true);
  });

  it('rejects invalid UUIDs', () => {
    assert.equal(isValidUUID('not-a-uuid'), false);
    assert.equal(isValidUUID('550e8400-e29b-41d4-a716'), false);
    assert.equal(isValidUUID(''), false);
    assert.equal(isValidUUID(null), false);
    assert.equal(isValidUUID(123), false);
  });
});

describe('validation — isValidEmail', () => {
  it('accepts valid emails', () => {
    assert.equal(isValidEmail('user@example.com'), true);
    assert.equal(isValidEmail('admin@authenx.in'), true);
    assert.equal(isValidEmail('test+tag@domain.co.in'), true);
  });

  it('rejects invalid emails', () => {
    assert.equal(isValidEmail(''), false);
    assert.equal(isValidEmail('no-at-sign'), false);
    assert.equal(isValidEmail('@no-local.com'), false);
    assert.equal(isValidEmail('user@'), false);
    assert.equal(isValidEmail(null), false);
    assert.equal(isValidEmail(42), false);
  });

  it('rejects emails exceeding 255 characters', () => {
    const longEmail = 'a'.repeat(250) + '@b.com';
    assert.equal(isValidEmail(longEmail), false);
  });
});

describe('validation — validatePasswordStrength', () => {
  it('passes a strong password', () => {
    const errors = validatePasswordStrength('Admin@123!');
    assert.deepEqual(errors, []);
  });

  it('rejects short password', () => {
    const errors = validatePasswordStrength('Ab1!');
    assert.ok(errors.some(e => e.includes('at least 8')));
  });

  it('rejects missing uppercase', () => {
    const errors = validatePasswordStrength('admin@123!');
    assert.ok(errors.some(e => e.includes('uppercase')));
  });

  it('rejects missing lowercase', () => {
    const errors = validatePasswordStrength('ADMIN@123!');
    assert.ok(errors.some(e => e.includes('lowercase')));
  });

  it('rejects missing digit', () => {
    const errors = validatePasswordStrength('Admin@abc!');
    assert.ok(errors.some(e => e.includes('digit')));
  });

  it('rejects missing special character', () => {
    const errors = validatePasswordStrength('Admin1234a');
    assert.ok(errors.some(e => e.includes('special')));
  });

  it('rejects null/undefined password', () => {
    assert.deepEqual(validatePasswordStrength(null), ['Password is required']);
    assert.deepEqual(validatePasswordStrength(undefined), ['Password is required']);
  });
});

describe('validation — validateString', () => {
  it('passes valid string', () => {
    assert.equal(validateString('hello', 'name'), null);
  });

  it('rejects non-string', () => {
    const err = validateString(123, 'age');
    assert.ok(err.includes('must be a string'));
  });

  it('rejects too short string', () => {
    const err = validateString('', 'name', { minLength: 1 });
    assert.ok(err.includes('at least 1'));
  });

  it('rejects too long string', () => {
    const err = validateString('x'.repeat(600), 'bio', { maxLength: 500 });
    assert.ok(err.includes('at most 500'));
  });
});

describe('validation — validateRequired', () => {
  it('returns empty array when all fields present', () => {
    const errors = validateRequired({ email: 'a@b.com', password: 'p' }, ['email', 'password']);
    assert.deepEqual(errors, []);
  });

  it('reports missing fields', () => {
    const errors = validateRequired({ email: 'a@b.com' }, ['email', 'password', 'name']);
    assert.deepEqual(errors, ['password is required', 'name is required']);
  });

  it('treats empty string as missing', () => {
    const errors = validateRequired({ name: '' }, ['name']);
    assert.deepEqual(errors, ['name is required']);
  });

  it('treats null/undefined as missing', () => {
    const errors = validateRequired({ a: null, b: undefined }, ['a', 'b']);
    assert.deepEqual(errors, ['a is required', 'b is required']);
  });
});
