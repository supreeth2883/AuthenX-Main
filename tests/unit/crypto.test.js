'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Set env vars before requiring module (prevents file system side-effects)
process.env.AES_KEY_HEX = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';

const crypto = require('../../authenx-node/src/crypto/index.js');

describe('crypto/index — buildCanonicalJson', () => {
  it('produces deterministic fixed-order JSON', () => {
    const fields = {
      schema_version: '1.0',
      issuer_id: 'college-1',
      student_ref_token: 'ref-123',
      name: 'Alice Smith',
      degree: 'B.Tech',
      branch: 'Computer Science',
      credential_type: 'degree',
      cgpa: '8.5',
      graduation_year: '2024',
      issue_date: '2024-01-15',
    };
    const json = crypto.buildCanonicalJson(fields);
    const parsed = JSON.parse(json);

    assert.equal(parsed.name, 'ALICE SMITH');
    assert.equal(parsed.degree, 'B.TECH');
    assert.equal(parsed.branch, 'COMPUTER SCIENCE');
    assert.equal(parsed.credential_type, 'DEGREE');
    assert.equal(parsed.cgpa, '8.5');

    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [
      'schema_version', 'issuer_id', 'student_ref_token',
      'name', 'degree', 'branch', 'credential_type',
      'cgpa', 'graduation_year', 'issue_date',
    ]);
  });

  it('defaults missing fields to empty string', () => {
    const json = crypto.buildCanonicalJson({});
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema_version, '1.0');
    assert.equal(parsed.issuer_id, '');
    assert.equal(parsed.name, '');
  });

  it('trims whitespace from all fields', () => {
    const json = crypto.buildCanonicalJson({ name: '  Alice  ', cgpa: ' 9.0 ' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.name, 'ALICE');
    assert.equal(parsed.cgpa, '9.0');
  });

  it('converts numeric values to strings', () => {
    const json = crypto.buildCanonicalJson({ cgpa: 8.5, graduation_year: 2024 });
    const parsed = JSON.parse(json);
    assert.equal(parsed.cgpa, '8.5');
    assert.equal(parsed.graduation_year, '2024');
  });
});

describe('crypto/index — sha256', () => {
  it('returns correct hex digest', () => {
    const hash = crypto.sha256('hello');
    assert.equal(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is consistent for same input', () => {
    assert.equal(crypto.sha256('test'), crypto.sha256('test'));
  });

  it('differs for different input', () => {
    assert.notEqual(crypto.sha256('a'), crypto.sha256('b'));
  });
});

describe('crypto/index — hashCredential', () => {
  it('returns canonical JSON and its SHA-256 hash', () => {
    const fields = { name: 'Test', degree: 'B.Tech', cgpa: '8.0' };
    const { canonical, hash } = crypto.hashCredential(fields);
    assert.equal(hash, crypto.sha256(canonical));
    assert.ok(canonical.includes('"TEST"'));
  });
});

describe('crypto/index — Ed25519', () => {
  let keys;

  before(() => {
    keys = crypto.generateEd25519KeyPair();
  });

  it('generates valid key pair with 32-byte hex strings', () => {
    assert.equal(keys.privateKeyHex.length, 64);
    assert.equal(keys.publicKeyHex.length, 64);
    assert.match(keys.privateKeyHex, /^[0-9a-f]{64}$/);
    assert.match(keys.publicKeyHex, /^[0-9a-f]{64}$/);
  });

  it('signs and verifies a message', () => {
    const message = 'credential data to sign';
    const signature = crypto.signEd25519(message, keys.privateKeyHex);
    assert.ok(typeof signature === 'string');
    assert.ok(signature.length > 0);

    const valid = crypto.verifyEd25519(message, signature, keys.publicKeyHex);
    assert.equal(valid, true);
  });

  it('rejects tampered message', () => {
    const signature = crypto.signEd25519('original', keys.privateKeyHex);
    const valid = crypto.verifyEd25519('tampered', signature, keys.publicKeyHex);
    assert.equal(valid, false);
  });

  it('rejects wrong public key', () => {
    const otherKeys = crypto.generateEd25519KeyPair();
    const signature = crypto.signEd25519('data', keys.privateKeyHex);
    const valid = crypto.verifyEd25519('data', signature, otherKeys.publicKeyHex);
    assert.equal(valid, false);
  });

  it('returns false for malformed signature', () => {
    const valid = crypto.verifyEd25519('msg', 'not-valid-base64!!', keys.publicKeyHex);
    assert.equal(valid, false);
  });
});

describe('crypto/index — AES-256-GCM (AuthenX Code)', () => {
  it('encrypts and decrypts round-trip', () => {
    const payload = { token_id: 'tok-1', college_id: 'col-1', student_ref_token: 'ref-1' };
    const code = crypto.encryptCode(payload);
    assert.ok(code.startsWith('AX1.'));

    const decrypted = crypto.decryptCode(code);
    assert.deepEqual(decrypted, payload);
  });

  it('produces different ciphertexts for same payload (random nonce)', () => {
    const payload = { token_id: 'tok-1' };
    const code1 = crypto.encryptCode(payload);
    const code2 = crypto.encryptCode(payload);
    assert.notEqual(code1, code2);
  });

  it('throws for invalid prefix', () => {
    assert.throws(() => crypto.decryptCode('BAD.xxxxxx'), /Invalid AuthenX Code prefix/);
  });

  it('throws for corrupted ciphertext', () => {
    const code = crypto.encryptCode({ test: true });
    const corrupted = code.slice(0, -5) + 'XXXXX';
    assert.throws(() => crypto.decryptCode(corrupted));
  });
});

describe('crypto/index — JWT', () => {
  it('signs and verifies a JWT', () => {
    const token = crypto.signJwt({ sub: 'user-1', role: 'admin' }, 60);
    const payload = crypto.verifyJwt(token);
    assert.equal(payload.sub, 'user-1');
    assert.equal(payload.role, 'admin');
    assert.ok(payload.iat);
    assert.ok(payload.exp);
    assert.ok(payload.jti);
  });

  it('rejects expired JWT', () => {
    const token = crypto.signJwt({ sub: 'user-1' }, -1);
    assert.throws(() => crypto.verifyJwt(token), /JWT expired/);
  });

  it('rejects tampered JWT', () => {
    const token = crypto.signJwt({ sub: 'user-1' });
    const parts = token.split('.');
    parts[1] = parts[1].slice(0, -2) + 'XX';
    assert.throws(() => crypto.verifyJwt(parts.join('.')), /Invalid JWT signature/);
  });

  it('rejects malformed JWT', () => {
    assert.throws(() => crypto.verifyJwt('not.a.valid.jwt.token'), /Malformed JWT/);
    assert.throws(() => crypto.verifyJwt('onlytwoparts.here'), /Malformed JWT/);
  });

  it('rejects revoked JWT', () => {
    const token = crypto.signJwt({ sub: 'user-1' }, 300);
    const payload = crypto.verifyJwt(token);
    crypto.revokeJwtId(payload.jti);
    assert.throws(() => crypto.verifyJwt(token), /JWT has been revoked/);
  });
});

describe('crypto/index — password hashing', () => {
  it('hashes and verifies password', async () => {
    const hashed = await crypto.hashPassword('MySecret@123');
    assert.ok(hashed.includes(':'));
    const valid = await crypto.verifyPassword('MySecret@123', hashed);
    assert.equal(valid, true);
  });

  it('rejects wrong password', async () => {
    const hashed = await crypto.hashPassword('Correct@123');
    const valid = await crypto.verifyPassword('Wrong@123', hashed);
    assert.equal(valid, false);
  });

  it('produces different hashes for same password (random salt)', async () => {
    const h1 = await crypto.hashPassword('Same@123');
    const h2 = await crypto.hashPassword('Same@123');
    assert.notEqual(h1, h2);
  });
});

describe('crypto/index — generateNonce', () => {
  it('returns 32-character hex string', () => {
    const nonce = crypto.generateNonce();
    assert.equal(nonce.length, 32);
    assert.match(nonce, /^[0-9a-f]{32}$/);
  });

  it('generates unique nonces', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => crypto.generateNonce()));
    assert.equal(nonces.size, 100);
  });
});

describe('crypto/index — refresh token', () => {
  it('generates 128-char hex token', () => {
    const token = crypto.generateRefreshToken();
    assert.equal(token.length, 128);
    assert.match(token, /^[0-9a-f]{128}$/);
  });

  it('hashes refresh token deterministically', () => {
    const token = crypto.generateRefreshToken();
    const h1 = crypto.hashRefreshToken(token);
    const h2 = crypto.hashRefreshToken(token);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });
});

describe('crypto/index — JWT revocation', () => {
  it('tracks revoked JTI', () => {
    assert.equal(crypto.isJwtRevoked('non-existent-id'), false);
    crypto.revokeJwtId('test-jti-123');
    assert.equal(crypto.isJwtRevoked('test-jti-123'), true);
  });
});
