/**
 * A-4 ①：**占用 `active[role]` 这个槽位之前，先问一次"本机拿它的那个引擎读得动吗"。**
 *
 * ## 修的是什么
 *
 * 目录里 `role:'vad'` 底下躺着两个**互相加载不了**的条目
 * （`vad/silero-vad-onnx` engines:["sherpa-onnx"] / `vad/silero-vad-ggml` engines:["whisper.cpp"]），
 * 而自动激活的规则是 `activateOnSuccess || !state.active[role]` —— **先装的赢**，
 * 目录里 onnx 排在 ggml 前面。于是同一台机器上两个消费方说相反的话：
 *
 *   · **激活态**（`active.json` / `/api/models/installed` / 存储页的「使用中」）：
 *     `vad/silero-vad-onnx` **正在用**；
 *   · **流水线装配**（`pipeline/setup.ts` 的 `resolveWhisperVadModel()`，判据是文件头四字节）：
 *     whisper.cpp 读不了它 ⇒ 切分退回固定窗口，`[用户真机 2026-08-09, Windows]`
 *     同一条警告**一次启动出现 3 遍**。
 *
 * 裁定收的是**内容判据那一侧**（B）：安装记录里的 `engines` 字段老记录没有，
 * 按字段过滤等于按一个不存在的东西过滤。所以要动的是**写激活态**那一侧。
 *
 * ## 这些用例钉的是什么
 *
 * 不是"某个函数返回了 false"，而是**槽位里最后躺着谁** ——
 * 判据一路走到 `RestState.create()` 真跑一遍内置模型导入，读的是落盘的 `active.json`。
 *
 * ⚠️ **正反成对**：只钉"加载不了的那个没进槽位"是不够的 ——
 *    一个永远拒绝激活的实现同样能让那条断言全绿，而它把功能修没了。
 *    所以每一条都配一条反向的："读得动的那个**必须**照常进槽位"。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-vadact-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GGML_FILE_MAGIC } from '@openmemo/downloader';

import { loadableByRoleConsumer, soleConsumerEngine } from '../../pipeline/modelStore.js';
import { SseHub } from '../sse.js';
import { RestState } from './state.js';

const MANIFEST_DIR = fileURLToPath(new URL('../../../../../vendor/manifests', import.meta.url));

/** 真 ggml 的头四字节 —— 与 `isGgmlModelFile()`（产品判据）读的是同一个位置。 */
const GGML_HEAD = ((): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return b;
})();

/** 一份**不是 ggml** 的字节（ONNX 是 protobuf，头四字节不可能是那个魔数）。 */
const NOT_GGML = Buffer.from('onnx-ish-payload', 'utf8');

/**
 * 从**真清单**里取 `vad/silero-vad-ggml`，只把它那一个文件的 `sha256`/`sizeBytes`
 * 换成我们要造的那份字节。
 *
 * ⚠️ 手搓条目试过一版，连撞 schema 校验（`arch`/`format`/`quantTier`/`requirements`/
 *    `source`/`benchmark`…），而那些字段与本用例要验的事**一点关系都没有**。
 *    用真条目还有一个更重要的好处：**role / engines / 文件名都是字面为真的**。
 */
function bundledGgmlVadEntry(body: Buffer): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(MANIFEST_DIR, 'models-asr-support.json'), 'utf8')) as {
    models: Record<string, unknown>[];
  };
  const entry = raw.models.find((m) => m['id'] === 'vad/silero-vad-ggml');
  assert.ok(entry, '真清单里没有 vad/silero-vad-ggml —— 这个用例的前提没了，先查清单');
  const files = entry['files'] as Record<string, unknown>[];
  assert.equal(files.length, 1, '这个条目不再是"一个权重文件"，夹具要跟着改');
  return {
    ...entry,
    // 校验器要求 `totalSizeBytes` 等于非可选文件大小之和 —— 跟着改，别绕过校验
    totalSizeBytes: body.length,
    files: [
      {
        ...files[0],
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    ],
  };
}

/**
 * 造一台**刚开机的机器**：包内带着一份 VAD，目录认得它，模型根还是空的。
 * `body` 决定包内那份的**真实字节** —— 也就是"whisper.cpp 到底读不读得动"。
 */
async function bootWith(body: Buffer): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');

  const entry = bundledGgmlVadEntry(body);
  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(
    join(manifestDir, 'models-test.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.08.10',
      generatedAt: '2026-08-10T00:00:00.000Z',
      models: [entry],
    }),
    'utf8',
  );

  const bundledDir = mkdtempSync(join(TEST_ROOT, 'bundled-'));
  const dir = join(bundledDir, 'vad/silero-vad-ggml');
  await mkdir(dir, { recursive: true });
  const name = ((entry['files'] as Record<string, unknown>[])[0]?.['name'] ?? '') as string;
  await writeFile(join(dir, name), body);
  process.env['OPENMEMO_BUNDLED_MODELS_DIR'] = bundledDir;

  try {
    return await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  } finally {
    delete process.env['OPENMEMO_BUNDLED_MODELS_DIR'];
  }
}

describe('A-4 ① 自动激活不许把一个"本机读不动"的权重记成使用中', () => {
  it('★★ 包内那份 whisper.cpp 读不动 ⇒ `active.vad` 不许被它占住', async () => {
    const state = await bootWith(NOT_GGML);
    /*
     * 前提先立住：**东西确实装进来了**。
     * 少了这一句，一个"根本没导入"的实现也能让下面那条断言变绿 ——
     * 那时槽位是空的，但原因完全不同，而用例分不出来。
     */
    const installed = await state.listInstalled();
    assert.deepEqual(
      installed.map((m) => m.id),
      ['vad/silero-vad-ggml'],
      '内置模型没有被导入 —— 这条用例的前提没成立，先查 reconcileBundledModels',
    );
    assert.equal(
      state.active.vad,
      null,
      '槽位被一个 whisper.cpp 加载不了的权重占住了 —— 界面会说「使用中」，' +
        '而流水线装配同一时刻说「加载不了，切分降级为固定窗口」',
    );
  });

  it('★★ 反向：包内那份读得动 ⇒ 必须照常进槽位（别把功能修没了）', async () => {
    const state = await bootWith(Buffer.concat([GGML_HEAD, Buffer.from('real-ggml-body')]));
    assert.equal(
      state.active.vad,
      'vad/silero-vad-ggml',
      '读得动的那一份也没能自动激活 —— 那不是修好，是把自动激活整个关掉了',
    );
  });

  it('★ 落盘那一份也不许指着它（下次启动读的是盘，不是内存）', async () => {
    const state = await bootWith(NOT_GGML);
    /*
     * ⚠️ **文件不存在是合法结果**：`persistActive()` 只在真的激活了什么之后才写。
     *    所以判据不能是"文件里 vad 为 null"，那会把"根本没写过"误判成失败；
     *    要问的是**下一次启动会读到什么** —— 两种情况的答案都必须是"没人占这个槽位"。
     */
    const p = join(state.modelsRoot, 'active.json');
    const onDisk = existsSync(p)
      ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, string | null>)
      : {};
    assert.equal(onDisk['vad'] ?? null, null);
    assert.equal(state.active.vad, null);
  });
});

describe('A-4 ① 判据本身：三态，`null` 是"说不出"而不是"不能"', () => {
  const withFile = (p: string): { role: string; files: { role: string; path: string }[] } => ({
    role: 'vad',
    files: [{ role: 'weights', path: p }],
  });

  it('★★ `asr` 没有唯一消费方 ⇒ `null`，**不许**折成 false', async () => {
    /*
     * 这一条挡的是一个很容易犯的"顺手改进"：把 `soleConsumerEngine()` 写成
     * `role === 'vad' ? 'whisper.cpp' : 'whisper.cpp'`（或给 asr 也填一个默认值）。
     * 那样 `asr` 槽位会被按 whisper.cpp 的格式判一遍，
     * 于是**装了 sherpa 流式模型的用户从此再也无法自动激活 ASR** ——
     * 拿一个真 bug 换一个更大的 bug。`asr` 跑哪个引擎由 `selectEngine()` 按语言现挑，
     * 这个问题在这台机器上**本来就没有唯一答案**。
     */
    assert.equal(soleConsumerEngine('asr'), null);
    const p = join(TEST_ROOT, 'some-asr.bin');
    await writeFile(p, NOT_GGML);
    assert.equal(
      await loadableByRoleConsumer(TEST_ROOT, { role: 'asr', files: [{ path: p }] }),
      null,
    );
  });

  it('★ 记录里指不到一个真实存在的文件 ⇒ `null`（说不出），不是 false', async () => {
    const gone = join(TEST_ROOT, 'no-such-file.bin');
    assert.equal(await loadableByRoleConsumer(TEST_ROOT, withFile(gone)), null);
  });

  it('★★ 同一份判据，正反两面都要对', async () => {
    const bad = join(TEST_ROOT, 'vad-onnx.onnx');
    const good = join(TEST_ROOT, 'vad-ggml.bin');
    await writeFile(bad, NOT_GGML);
    await writeFile(good, Buffer.concat([GGML_HEAD, Buffer.from('body')]));
    assert.equal(await loadableByRoleConsumer(TEST_ROOT, withFile(bad)), false);
    assert.equal(await loadableByRoleConsumer(TEST_ROOT, withFile(good)), true);
  });
});
