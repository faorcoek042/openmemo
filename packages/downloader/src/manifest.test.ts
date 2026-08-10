/**
 * `verifyCatalogSignature` / `verifyCatalogSignatureSafe` — CI-reachable coverage
 * (D-20 §17), sibling to `signature.test.ts`. See that file's header for why this exists
 * as a `.test.ts` file rather than relying solely on `scripts/verify-unpack.mjs` §9
 * (which has zero automatic invokers and therefore cannot fail CI).
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, it } from 'node:test';

import { verifyCatalogSignature, verifyCatalogSignatureSafe } from './manifest.js';

describe('verifyCatalogSignature — fail-closed (ADR-012 决策 6 / ADR-010 §附-A)', () => {
  it('throws using the default (unconfigured) key', async () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    await assert.rejects(() => verifyCatalogSignature(catalogBytes, signature));
  });

  it('throws when explicitly passed a null key', async () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    await assert.rejects(() => verifyCatalogSignature(catalogBytes, signature, null));
  });

  it('verifies correctly once a key IS supplied', async () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    assert.equal(await verifyCatalogSignature(catalogBytes, signature, rawPublicKey), true);
  });

  it('a tampered catalog fails verification (does not throw, returns false)', async () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const tampered = Buffer.from(catalogBytes);
    tampered[0] ^= 0xff;
    assert.equal(await verifyCatalogSignature(tampered, signature, rawPublicKey), false);
  });
});

describe('verifyCatalogSignatureSafe — never throws (D-20 §17 precondition 2 helper)', () => {
  it('returns false (not throw) when no key is configured — same fail-closed direction, different shape', () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    assert.doesNotThrow(() => {
      assert.equal(verifyCatalogSignatureSafe(catalogBytes, signature, null), false);
    });
  });

  it('verifies correctly once a key IS supplied', () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    assert.equal(verifyCatalogSignatureSafe(catalogBytes, signature, rawPublicKey), true);
  });

  it('a wrong key returns false', () => {
    const catalogBytes = Buffer.from('{"models":[]}');
    const { privateKey } = generateKeyPairSync('ed25519');
    const signature = cryptoSign(null, catalogBytes, privateKey);
    const wrongKey = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .subarray(-32);
    assert.equal(verifyCatalogSignatureSafe(catalogBytes, signature, wrongKey), false);
  });
});
