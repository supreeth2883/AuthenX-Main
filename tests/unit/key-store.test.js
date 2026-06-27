'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Set HSM_MASTER_KEY before requiring key-store to avoid file-system side effects
process.env.HSM_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const keyStore = require('../../authenx-hsm/key-store.js');

const TEST_COLLEGE = 'test-college-' + Date.now();
const KEYS_DIR = path.join(__dirname, '../../authenx-hsm/keys');

describe('key-store — importKey and getKey', () => {
  const keypair = (() => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
    return {
      privateKeyHex: privRaw.slice(-32).toString('hex'),
      publicKeyHex: pubRaw.slice(-32).toString('hex'),
    };
  })();

  after(() => {
    // Cleanup test key file
    const keyFile = path.join(KEYS_DIR, `${TEST_COLLEGE}.json`);
    try { fs.unlinkSync(keyFile); } catch {}
  });

  it('imports a key pair and retrieves it', () => {
    keyStore.importKey(TEST_COLLEGE, keypair.privateKeyHex, keypair.publicKeyHex);
    const key = keyStore.getKey(TEST_COLLEGE);
    assert.ok(key);
    assert.equal(key.college_id, TEST_COLLEGE);
    assert.equal(key.public_key_hex, keypair.publicKeyHex);
    assert.equal(key.private_key_hex, keypair.privateKeyHex);
    assert.equal(key.version, 1);
  });

  it('encrypts private key at rest', () => {
    const keyFile = path.join(KEYS_DIR, `${TEST_COLLEGE}.json`);
    const fileData = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    // Private key should NOT be stored as plaintext
    assert.equal(fileData.private_key_hex, undefined);
    assert.ok(fileData.encrypted_private_key);
    assert.equal(fileData.migrated_to_encrypted, true);
  });

  it('returns null for non-existent college', () => {
    const key = keyStore.getKey('non-existent-college-xyz');
    assert.equal(key, null);
  });
});

describe('key-store — sign', () => {
  const signCollege = 'sign-test-' + Date.now();

  before(() => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
    keyStore.importKey(
      signCollege,
      privRaw.slice(-32).toString('hex'),
      pubRaw.slice(-32).toString('hex')
    );
  });

  after(() => {
    try { fs.unlinkSync(path.join(KEYS_DIR, `${signCollege}.json`)); } catch {}
  });

  it('signs a payload and returns hex signature', () => {
    const sig = keyStore.sign(signCollege, 'test payload data');
    assert.ok(typeof sig === 'string');
    assert.match(sig, /^[0-9a-f]+$/);
    assert.ok(sig.length > 0);
  });

  it('produces consistent signatures for same payload', () => {
    const sig1 = keyStore.sign(signCollege, 'consistent');
    const sig2 = keyStore.sign(signCollege, 'consistent');
    assert.equal(sig1, sig2);
  });

  it('produces different signatures for different payloads', () => {
    const sig1 = keyStore.sign(signCollege, 'payload-a');
    const sig2 = keyStore.sign(signCollege, 'payload-b');
    assert.notEqual(sig1, sig2);
  });

  it('throws for non-existent college', () => {
    assert.throws(
      () => keyStore.sign('ghost-college', 'data'),
      /No key found/
    );
  });

  it('signature is verifiable with public key', () => {
    const payload = 'credential data for verification';
    const sigHex = keyStore.sign(signCollege, payload);
    const keyData = keyStore.getKey(signCollege);

    // Verify using node:crypto directly
    const pubBytes = Buffer.from(keyData.public_key_hex, 'hex');
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiHeader, pubBytes]);
    const publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const valid = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(sigHex, 'hex'));
    assert.equal(valid, true);
  });
});

describe('key-store — rotateKey', () => {
  const rotateCollege = 'rotate-test-' + Date.now();

  before(() => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
    keyStore.importKey(
      rotateCollege,
      privRaw.slice(-32).toString('hex'),
      pubRaw.slice(-32).toString('hex')
    );
  });

  after(() => {
    try { fs.unlinkSync(path.join(KEYS_DIR, `${rotateCollege}.json`)); } catch {}
  });

  it('generates new key pair with incremented version', () => {
    const original = keyStore.getKey(rotateCollege);
    const result = keyStore.rotateKey(rotateCollege);
    assert.ok(result.public_key_hex);
    assert.notEqual(result.public_key_hex, original.public_key_hex);
    assert.equal(result.version, 2);
  });

  it('new key can be used for signing', () => {
    const sig = keyStore.sign(rotateCollege, 'post-rotation-data');
    assert.ok(sig.length > 0);
  });

  it('creates new key for non-existent college with version 1', () => {
    const newCollege = 'fresh-rotate-' + Date.now();
    const result = keyStore.rotateKey(newCollege);
    assert.equal(result.version, 1);
    assert.ok(result.public_key_hex);
    // Cleanup
    try { fs.unlinkSync(path.join(KEYS_DIR, `${newCollege}.json`)); } catch {}
  });
});

describe('key-store — listKeys', () => {
  it('returns array of key metadata without private keys', () => {
    const list = keyStore.listKeys();
    assert.ok(Array.isArray(list));
    for (const entry of list) {
      assert.ok(entry.college_id || entry.college_id === undefined);
      assert.equal(entry.private_key_hex, undefined);
      assert.equal(entry.encrypted_private_key, undefined);
      if (entry.public_key_hex) {
        assert.match(entry.public_key_hex, /^[0-9a-f]{64}$/);
      }
    }
  });
});
