/**
 * T-148 根因护栏：**只按 `role` 挑模型，会把 sherpa 的 ONNX 交给 whisper.cpp。**
 *
 * ## 事故经过（`[CI 实测]` cold-start-audit run 31039460495）
 *
 * 干净机器上按 `required-core` 装模型，目录顺序是 onnx 在前、ggml 在后：
 *
 * ```
 * vad/silero-vad-onnx    succeeded (1.0s)     engines:["sherpa-onnx"]
 * vad/silero-vad-ggml    succeeded (2.0s)     engines:["whisper.cpp"]
 * ```
 *
 * `models.ts` 的激活规则是「先装的那个赢」（`activateOnSuccess || !state.active[role]`），
 * 于是 `active.json.vad = "vad/silero-vad-onnx"` —— 这份 `active.json` 我在
 * `/tmp/ci-runner/localsmoke3` 那次真实冷启动的数据目录里逐字看过。
 * `resolveActiveModel(dir,'vad')` 照单交出 ONNX，daemon 把它当成 whisper 的 VAD 权重，
 * `whisper-vad-speech-segments` 报 `bad magic` → exit 2 → **整单转写死**，
 * 而 selfcheck 的 `model.vad` 是 **ok**（它当时只查文件在不在）。
 *
 * 两条清单条目自己都写着这件事：
 *   onnx: “whisper.cpp CANNOT load this file — it needs the ggml build.”
 *   ggml: “The sherpa-onnx engine CANNOT load this file.”
 * **信息一直都在记录里（`engines` 字段也在），只是解析器从来没看过。**
 *
 * ## 这些用例钉的是什么
 *
 * 不是「函数返回了某个字符串」，而是「交出去的那份权重 whisper.cpp 真的加载得了」。
 * 夹具用 4 字节魔数造，判定与产品同一个函数 —— 换句话说，
 * 判据是**后果**，不是文件名、不是目录、不是 `engines` 字段拼写。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GGML_FILE_MAGIC, isGgmlModelFile } from '@openmemo/downloader';

import { resolveActiveModel } from './modelStore.js';
import { resolveWhisperVadModel } from './setup.js';

const MAGIC_LE = ((): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return b;
})();

interface Fixture {
  /** 装 ggml 那一份（whisper.cpp 用的）。 */
  ggml?: boolean;
  /** 装 onnx 那一份（sherpa 用的）。 */
  onnx?: boolean;
  /** `active.json` 里 vad 指向谁。 */
  active?: string | null;
}

/**
 * 造一个与真实冷启动**同构**的模型目录。
 *
 * 布局照抄 `/tmp/ci-runner/localsmoke3/data/models`（真实产品写出来的那一份）：
 * 两个 VAD 都落在 `by-name/asr/`，安装记录带 `role` 与 `engines`，
 * `active.json` 是七个槽位的完整对象。
 *
 * ⚠️ **订正于 T-149**：这里原本写着「`roleToStoreKind('vad') === 'asr'`，**是有意的**」——
 * 那句话是错的。`store.ts:37-42` 早就声明"一个 role 一个桶"是既定修复，
 * 只是 daemon 的写盘路径一直没接上（`bucketForRole` 当时 0 个调用方）。
 * T-149 已把它接上，**新装的 VAD 会落在 `by-name/vad/`**。
 *
 * 这个夹具**故意保留旧布局**：它现在的身份是「老机器上真实存在的历史状态」，
 * 而解析器必须对新旧两种布局一视同仁（判据是记录里的 `role` + 文件内容的魔数，
 * 从来不是目录名）。换句话说，这份夹具留着是在钉**向后兼容**，不是在钉那句错话。
 */
async function makeStore(f: Fixture): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), 'vadfix-store-')), 'models');
  await mkdir(join(root, 'manifests', 'asr'), { recursive: true });
  await mkdir(join(root, 'by-name', 'asr'), { recursive: true });

  const record = async (
    id: string,
    engines: string[],
    name: string,
    bytes: Buffer,
  ): Promise<void> => {
    await writeFile(join(root, 'by-name', 'asr', name), bytes);
    await writeFile(
      join(root, 'manifests', 'asr', `${id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id,
        groupId: 'vad/silero-vad',
        role: 'vad',
        engines,
        integrity: 'ok',
        files: [{ role: 'weights', name, root: 'models', relPath: join('by-name', 'asr', name) }],
      }),
    );
  };

  if (f.onnx === true) {
    // ONNX 是 protobuf：头一个字节是字段 tag 0x08，绝不可能撞上 ggml 魔数
    await record(
      'vad/silero-vad-onnx',
      ['sherpa-onnx'],
      'silero_vad.onnx',
      Buffer.from([0x08, 0x07, 0x12, 0x0c, 0x0a, 0x00, 0x00, 0x00]),
    );
  }
  if (f.ggml === true) {
    await record(
      'vad/silero-vad-ggml',
      ['whisper.cpp'],
      'ggml-silero-v6.2.0.bin',
      Buffer.concat([MAGIC_LE, Buffer.alloc(64)]),
    );
  }
  await writeFile(
    join(root, 'active.json'),
    JSON.stringify({
      asr: null,
      llm: null,
      vad: f.active ?? null,
      punctuation: null,
      diarization: null,
      embedding: null,
      tts: null,
    }),
  );
  return root;
}

describe('resolveWhisperVadModel —— 交出去的权重必须是 whisper.cpp 加载得了的', () => {
  it('★ 两个都装了、active.json 指着 ONNX：仍然必须交出 ggml 那一份', async () => {
    /*
     * 这就是 CI 上那台机器的状态，一比一。
     * 先用旧判据跑一遍**证明它确实会挑错** —— 没有这一行，下面那条绿了也说明不了什么。
     */
    const root = await makeStore({ ggml: true, onnx: true, active: 'vad/silero-vad-onnx' });

    const byRoleOnly = await resolveActiveModel(root, 'vad');
    assert.equal(
      await isGgmlModelFile(byRoleOnly?.path ?? null),
      false,
      '前提失效：只按 role 挑本应挑中 ONNX；这条不成立时下面那条就不再是在防什么了',
    );

    const resolved = await resolveWhisperVadModel(root, {});
    assert.equal(
      await isGgmlModelFile(resolved.path),
      true,
      '交给 whisper-vad-speech-segments 的那份权重必须真的能被它加载',
    );
    assert.equal(resolved.path?.endsWith('ggml-silero-v6.2.0.bin'), true);
  });

  it('★ 只装了 sherpa 的 ONNX：宁可说"没有"，也不许把它交出去', async () => {
    const root = await makeStore({ onnx: true, active: 'vad/silero-vad-onnx' });
    const resolved = await resolveWhisperVadModel(root, {});

    assert.equal(resolved.path, null, '交出去 = whisper 报 bad magic = 整单转写死');
    // 「一个都没装」和「装了但用不了」在用户那里是两件事，降级提示必须分得出来
    assert.equal(resolved.rejected.length, 1);
    assert.equal(resolved.rejected[0]?.endsWith('silero_vad.onnx'), true);
    assert.equal(resolved.reasonZh.includes('silero_vad.onnx'), true, '要说得出是哪一个文件');
  });

  it('什么都没装：path=null 且**没有**被否掉的候选（这是正常状态，不是故障）', async () => {
    const root = await makeStore({});
    const resolved = await resolveWhisperVadModel(root, {});
    assert.equal(resolved.path, null);
    assert.deepEqual([...resolved.rejected], []);
  });

  it('只装了 ggml：直接命中', async () => {
    const root = await makeStore({ ggml: true, active: 'vad/silero-vad-ggml' });
    const resolved = await resolveWhisperVadModel(root, {});
    assert.equal(await isGgmlModelFile(resolved.path), true);
    assert.deepEqual([...resolved.rejected], []);
  });

  it('★ 没有 active.json 指定时也不能靠运气：ggml 在记录里排后面照样要被选中', async () => {
    /*
     * `findInstalledByRole` 的顺序来自 `readdir` —— 文件系统说了算。
     * 「谁排前面」在不同机器上可能不同，而**依赖巧合的正确等于还没修**。
     */
    const root = await makeStore({ ggml: true, onnx: true, active: null });
    const resolved = await resolveWhisperVadModel(root, {});
    assert.equal(await isGgmlModelFile(resolved.path), true);
  });

  it('★ 环境变量覆盖同样要过这一关（`OPENMEMO_VAD_MODEL` 指到 ONNX 上）', async () => {
    const root = await makeStore({ ggml: true, onnx: true, active: 'vad/silero-vad-ggml' });
    const onnx = join(root, 'by-name', 'asr', 'silero_vad.onnx');
    const resolved = await resolveWhisperVadModel(root, { OPENMEMO_VAD_MODEL: onnx });
    assert.equal(
      await isGgmlModelFile(resolved.path),
      true,
      '开发用的逃生口不该有"绕过正确性"的权力',
    );
    assert.equal(resolved.path?.endsWith('ggml-silero-v6.2.0.bin'), true);
  });

  it('by-name 兜底扫描（没有安装记录，用户手工拷进来的）也按内容判', async () => {
    const root = await makeStore({});
    // 手工拷进来：文件在，记录没有。名字带 silero + .bin，会被 scanByName 捞到
    await writeFile(
      join(root, 'by-name', 'asr', 'ggml-silero-v9.9.9.bin'),
      Buffer.concat([MAGIC_LE, Buffer.alloc(8)]),
    );
    await writeFile(
      join(root, 'by-name', 'asr', 'silero-vad-broken.bin'),
      Buffer.from('not a ggml file at all'),
    );
    const resolved = await resolveWhisperVadModel(root, {});
    assert.equal(resolved.path?.endsWith('ggml-silero-v9.9.9.bin'), true, '版本号变了也要找得到');
  });
});
