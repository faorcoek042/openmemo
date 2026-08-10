/**
 * `checkForUpdates()` / `checkBundledIntegrity()` — D-20 §17 三条前提的端到端覆盖。
 *
 * 三个 describe 块分别对应 D-20 §11.3 的三条前提，逐条钉住"这条腿真的存在"，
 * 不是只钉"函数存在" —— 例如"验不过要回退"不是断言函数返回了某个 enum 值，
 * 是断言 `newOrChanged` 真的是空数组、且没有抛出。
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  checkBundledIntegrity,
  checkForUpdates,
  type CatalogUpdateEntry,
  type CatalogUpdateFile,
} from './catalogUpdate.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** 单文件条目的简写 —— 真实 `ModelEntry` 是多文件的，这里只需要一个就够测比对逻辑。 */
function oneFile(sha: string, name = 'weights.bin'): readonly CatalogUpdateFile[] {
  return [{ name, sha256: sha }];
}

interface Entry extends CatalogUpdateEntry {
  readonly id: string;
  readonly files: readonly CatalogUpdateFile[];
}

function fakeFetchOk(bodies: Record<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = bodies[url];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe('checkBundledIntegrity — D-20 §11.3 precondition 3（不许改已内置项的文件内容/sha256）', () => {
  it('丢弃 sha256 与本地不一致的钉死条目，不采纳、不覆盖', () => {
    const local = new Map([['bundled/a', { files: oneFile(sha256('a-original')) }]]);
    const remote: Entry[] = [{ id: 'bundled/a', files: oneFile(sha256('a-TAMPERED')) }];
    const { accepted, rejected } = checkBundledIntegrity(remote, local, new Set(['bundled/a']));
    assert.equal(accepted.length, 0, '被篡改的钉死条目绝不能出现在 accepted 里');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.id, 'bundled/a');
  });

  it('sha256 一致的钉死条目正常通过', () => {
    const local = new Map([['bundled/a', { files: oneFile(sha256('a-original')) }]]);
    const remote: Entry[] = [{ id: 'bundled/a', files: oneFile(sha256('a-original')) }];
    const { accepted, rejected } = checkBundledIntegrity(remote, local, new Set(['bundled/a']));
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  it('只增：不在钉死集合里的新 id 不受限制', () => {
    const local = new Map<string, { files: readonly CatalogUpdateFile[] }>();
    const remote: Entry[] = [{ id: 'new/model', files: oneFile(sha256('anything')) }];
    const { accepted, rejected } = checkBundledIntegrity(remote, local, new Set(['bundled/a']));
    assert.equal(accepted.length, 1, '新 id（不在钉死集合里）必须被允许通过');
    assert.equal(rejected.length, 0);
  });
});

describe('checkForUpdates — D-20 §11.3 precondition 2（验不过/拿不到 → 回退，不是"没有目录"）', () => {
  const localEntries: Entry[] = [
    { id: 'asr/whisper-tiny-q5_1', files: oneFile(sha256('local-bytes')) },
  ];

  it('未配置远端地址：source=not-configured，newOrChanged 为空，不抛错', async () => {
    const result = await checkForUpdates<Entry>({
      catalogUrl: undefined,
      signatureUrl: undefined,
      localEntries,
      bundledIds: new Set(['asr/whisper-tiny-q5_1']),
      parseCatalog: () => [],
    });
    assert.equal(result.source, 'not-configured');
    assert.deepEqual(result.newOrChanged, []);
  });

  it('host 不在白名单：source=host-not-allowed，不发起任何请求', async () => {
    let fetchCalled = false;
    const result = await checkForUpdates<Entry>({
      catalogUrl: 'https://evil.example.com/catalog.json',
      signatureUrl: 'https://evil.example.com/catalog.json.sig',
      localEntries,
      bundledIds: new Set(),
      allowedHosts: ['huggingface.co'],
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('x', { status: 200 });
      }) as typeof fetch,
      parseCatalog: () => [],
    });
    assert.equal(result.source, 'host-not-allowed');
    assert.equal(fetchCalled, false, '不在白名单里的 host 不该发起网络请求');
  });

  it('拉取失败（网络错误）：source=fetch-failed，不抛出到调用方', async () => {
    const result = await checkForUpdates<Entry>({
      catalogUrl: 'https://huggingface.co/catalog.json',
      signatureUrl: 'https://huggingface.co/catalog.json.sig',
      localEntries,
      bundledIds: new Set(),
      allowedHosts: ['huggingface.co'],
      fetchImpl: (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch,
      parseCatalog: () => [],
    });
    assert.equal(result.source, 'fetch-failed');
    assert.deepEqual(result.newOrChanged, []);
  });

  it('没有配发公钥：source=no-key-configured，即便远端数据是合法的也不采纳', async () => {
    const catalogBytes = new TextEncoder().encode('{"models":[]}');
    const { privateKey } = generateKeyPairSync('ed25519');
    const sig = cryptoSign(null, catalogBytes, privateKey);
    const result = await checkForUpdates<Entry>({
      catalogUrl: 'https://huggingface.co/catalog.json',
      signatureUrl: 'https://huggingface.co/catalog.json.sig',
      localEntries,
      bundledIds: new Set(),
      allowedHosts: ['huggingface.co'],
      publicKey: null, // 显式模拟"没有配发密钥"，不依赖进程环境
      fetchImpl: fakeFetchOk({
        'https://huggingface.co/catalog.json': catalogBytes,
        'https://huggingface.co/catalog.json.sig': new Uint8Array(sig),
      }),
      parseCatalog: (): Entry[] => [],
    });
    assert.equal(result.source, 'no-key-configured');
  });

  it('签名验不过（篡改载荷）：source=verify-failed，回退语义（空更新列表），不是"没有目录"的错误形状', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const realBytes = new TextEncoder().encode('{"models":[]}');
    const sig = cryptoSign(null, realBytes, privateKey);
    const tamperedBytes = new TextEncoder().encode('{"models":[{"evil":true}]}');

    const result = await checkForUpdates<Entry>({
      catalogUrl: 'https://huggingface.co/catalog.json',
      signatureUrl: 'https://huggingface.co/catalog.json.sig',
      localEntries,
      bundledIds: new Set(),
      allowedHosts: ['huggingface.co'],
      publicKey: rawPublicKey.toString('hex'),
      fetchImpl: fakeFetchOk({
        'https://huggingface.co/catalog.json': tamperedBytes, // 内容对不上签名
        'https://huggingface.co/catalog.json.sig': new Uint8Array(sig),
      }),
      parseCatalog: (): Entry[] => [{ id: 'evil/injected', files: oneFile(sha256('evil')) }],
    });
    assert.equal(result.source, 'verify-failed');
    assert.deepEqual(result.newOrChanged, [], '验签失败时绝不能把里面的条目当"新增/更新"报出去');
  });

  it('全部通过：真实验签 + 新增项识别 + 钉死项篡改被拦截，一次性走完整条腿', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    const remoteModels: Entry[] = [
      // 与本地一致的钉死项：应当出现在 accepted，但不算"新增/更新"
      { id: 'asr/whisper-tiny-q5_1', files: oneFile(sha256('local-bytes')) },
      // 试图篡改的钉死项：必须被 checkBundledIntegrity 拦下
      { id: 'vad/silero-vad-ggml', files: oneFile(sha256('TAMPERED')) },
      // 真正的新增项
      { id: 'asr/new-model-v2', files: oneFile(sha256('brand-new')) },
    ];
    const catalogBytes = new TextEncoder().encode(JSON.stringify({ models: remoteModels }));
    const sig = cryptoSign(null, catalogBytes, privateKey);

    const result = await checkForUpdates<Entry>({
      catalogUrl: 'https://huggingface.co/catalog.json',
      signatureUrl: 'https://huggingface.co/catalog.json.sig',
      localEntries: [
        { id: 'asr/whisper-tiny-q5_1', files: oneFile(sha256('local-bytes')) },
        { id: 'vad/silero-vad-ggml', files: oneFile(sha256('local-vad-bytes')) },
      ],
      bundledIds: new Set(['asr/whisper-tiny-q5_1', 'vad/silero-vad-ggml']),
      allowedHosts: ['huggingface.co'],
      publicKey: rawPublicKey.toString('hex'),
      fetchImpl: fakeFetchOk({
        'https://huggingface.co/catalog.json': catalogBytes,
        'https://huggingface.co/catalog.json.sig': new Uint8Array(sig),
      }),
      parseCatalog: (raw) => (raw as { models: Entry[] }).models,
    });

    assert.equal(result.source, 'verified');
    assert.equal(result.rejectedBundledTampering.length, 1);
    assert.equal(result.rejectedBundledTampering[0]?.id, 'vad/silero-vad-ggml');
    assert.deepEqual(
      result.newOrChanged.map((c) => c.id),
      ['asr/new-model-v2'],
      '只有真正新增的 id 才应当出现在 newOrChanged 里；未变的钉死项与被拦截的篡改项都不该出现',
    );
  });
});
