/**
 * AuthenX Connector — Ed25519 Key Pair Generator
 *
 * Run: npm run keygen
 *
 * Generates a new Ed25519 key pair for a college connector.
 * Output:
 *   - Private key (hex) → set as COLLEGE_PRIVATE_KEY in .env (KEEP SECRET)
 *   - Public key (hex)  → register with AuthenX during college onboarding
 */

import nacl from 'tweetnacl';

function generateKeyPair() {
  const keyPair = nacl.sign.keyPair();

  const privateKeyHex = Buffer.from(keyPair.secretKey).toString('hex');
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString('hex');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  AuthenX Connector — Ed25519 Key Pair Generated');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('🔒 PRIVATE KEY (64 bytes, 128 hex chars)');
  console.log('   → Set this as COLLEGE_PRIVATE_KEY in connector .env');
  console.log('   → NEVER share this. NEVER commit this to git.\n');
  console.log(`   ${privateKeyHex}\n`);

  console.log('🔑 PUBLIC KEY (32 bytes, 64 hex chars)');
  console.log('   → Register this with AuthenX during college onboarding\n');
  console.log(`   ${publicKeyHex}\n`);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Store the private key securely. If lost, you must');
  console.log('  generate a new key pair and re-onboard with AuthenX.');
  console.log('═══════════════════════════════════════════════════════════\n');
}

generateKeyPair();
