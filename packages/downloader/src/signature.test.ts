/**
 * Ed25519 catalog-signature verification — CI-reachable coverage (D-20 §17).
 *
 * ══ 为什么这份文件存在 ══════════════════════════════════════════════════════════════
 *
 * 这些用例是 `packages/downloader/scripts/verify-unpack.mjs` 第 8/9 节那 13 条断言的
 * 等价版本，搬进这里是因为 `verify-unpack.mjs` **没有任何自动调用方**（不在任何
 * package.json scripts、不在任何 workflow）——那 13 条断言结构上不可能让 CI 变红。
 * 这个文件不同：`packages/downloader/package.json` 的 `test` 脚本是
 * `node --test "dist/**` + `/*.test.js"`，而 `pnpm -r test` 在 `.github/workflows/
 * ci-crossplatform.yml` 里对三个平台都跑（`pnpm build:safe` 之后）——**编译到
 * `dist/signature.test.js` 的那一刻起，这些断言就真的能让 CI 变红。**
 *
 * `verify-unpack.mjs` 本身不删：它是 53 条解包安全断言的宿主（ADR-010 §附-A 记录过
 * 删它的爆炸半径），这里只是给签名那一半**另开一条 CI 真的会走的路**，两者并存。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  OPENMEMO_CATALOG_PUBLIC_KEY,
  parseEd25519PublicKey,
  resolveConfiguredCatalogPublicKey,
  verifyEd25519,
} from './signature.js';

describe('verifyEd25519', () => {
  it('verifies a genuine signature (KeyObject)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const signature = cryptoSign(null, data, privateKey);
    assert.equal(verifyEd25519(data, signature, publicKey), true);
  });

  it('verifies a genuine signature (raw 32-byte public key)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const data = Buffer.from('raw-key round trip');
    const signature = cryptoSign(null, data, privateKey);
    assert.equal(verifyEd25519(data, signature, rawPublicKey), true);
  });

  it('parseEd25519PublicKey accepts a raw 32-byte key', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    assert.equal(parseEd25519PublicKey(rawPublicKey).asymmetricKeyType, 'ed25519');
  });

  it('parseEd25519PublicKey accepts PEM', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(parseEd25519PublicKey(pem).asymmetricKeyType, 'ed25519');
  });

  it('parseEd25519PublicKey accepts 64-char hex', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const hex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    assert.equal(parseEd25519PublicKey(hex).asymmetricKeyType, 'ed25519');
  });

  it('rejects a tampered payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const signature = cryptoSign(null, data, privateKey);
    const tamperedData = Buffer.from(data);
    tamperedData[0] ^= 0xff;
    assert.equal(verifyEd25519(tamperedData, signature, publicKey), false);
  });

  it('rejects a tampered signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const signature = cryptoSign(null, data, privateKey);
    const tamperedSig = Buffer.from(signature);
    tamperedSig[0] ^= 0xff;
    assert.equal(verifyEd25519(data, tamperedSig, publicKey), false);
  });

  it('a mismatched (different) keypair fails to verify', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const signature = cryptoSign(null, data, privateKey);
    assert.equal(verifyEd25519(data, signature, generateKeyPairSync('ed25519').publicKey), false);
  });

  it('garbage bytes as a "public key" return false, not throw', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const signature = cryptoSign(null, data, privateKey);
    assert.doesNotThrow(() => {
      assert.equal(verifyEd25519(data, signature, Buffer.from([1, 2, 3])), false);
    });
  });
});

describe('resolveConfiguredCatalogPublicKey — D-20 §17 precondition 1 (env override)', () => {
  it('compiled-in default is honestly null (no key has been provisioned yet)', () => {
    assert.equal(OPENMEMO_CATALOG_PUBLIC_KEY, null);
  });

  it('falls back to the compiled default (null) when the env var is unset', () => {
    assert.equal(resolveConfiguredCatalogPublicKey({}), null);
  });

  it('falls back to the compiled default when the env var is set to an empty/whitespace string', () => {
    assert.equal(resolveConfiguredCatalogPublicKey({ OPENMEMO_CATALOG_PUBLIC_KEY_HEX: '' }), null);
    assert.equal(
      resolveConfiguredCatalogPublicKey({ OPENMEMO_CATALOG_PUBLIC_KEY_HEX: '   ' }),
      null,
    );
  });

  it('honors a real key provisioned via OPENMEMO_CATALOG_PUBLIC_KEY_HEX', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const hex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const resolved = resolveConfiguredCatalogPublicKey({ OPENMEMO_CATALOG_PUBLIC_KEY_HEX: hex });
    assert.equal(resolved, hex);
    // 而且拿它真的能验签 —— 不只是字符串透传对了
    assert.equal(
      parseEd25519PublicKey(resolved ?? '').asymmetricKeyType,
      'ed25519',
      'the resolved key must actually parse as a usable Ed25519 public key',
    );
  });
});
