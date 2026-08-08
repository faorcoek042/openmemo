/**
 * 引擎 ↔ 模型格式契约（`MODEL_FORMAT_BY_ENGINE` / `canEngineLoad` / `ModelQuery.engine`）。
 *
 * ## 这组用例守的是**根因**，不是又一个症状
 *
 * 同一个根因在本仓已经以四种面目出现过：
 *
 * | 面目 | 当时的补法 |
 * |---|---|
 * | sherpa 的 `silero_vad.onnx` 被当成 whisper 的 VAD 权重（T-148） | 调用点加 `accept: isGgmlModelFile` |
 * | `by-name/asr` 下的 VAD 权重被当成 ASR 模型 | 调用点加 `excludes:'silero'`（按文件名） |
 * | ASR 与 VAD 解析到同一个文件 | 调用点加路径相等判断 |
 * | `asr/sherpa-streaming-zh-14m` 被交给 whisper.cpp | 前三道补丁一个都没接住 |
 *
 * 最后那个的实测后果：**用户录完音，产品自己发起的那次转写必然失败**，
 * `error: failed to initialize whisper context`，三平台一字不差
 * （`[CI 实测]` e2e-record run 31247324575 / 31248849155）。
 *
 * 修法不是加第四道补丁，而是让「把 A 引擎的模型交给 B 引擎」**表达不出来**：
 * `ModelQuery.engine` 必填 + 格式表按 `AsrEngineId` 穷尽。
 * 这个文件钉的就是这两条性质本身。
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { GGML_FILE_MAGIC } from '@openmemo/downloader';
import { ASR_ENGINE_IDS } from '@openmemo/shared';

import {
  canEngineLoad,
  MODEL_FORMAT_BY_ENGINE,
  resolveActiveModel,
  resolveModelById,
} from './modelStore.js';

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

/**
 * whisper.cpp 自己检查的那 4 个字节。
 *
 * **从常量写出来，不手抄字节。** 第一版我手抄成了 `[0x67,0x67,0x6d,0x6c]`
 * （即 `'ggml'` 的 ASCII 顺序），而判据读的是 `readUInt32LE`，
 * 所以盘上应当是它的小端表示 `[0x6c,0x6d,0x67,0x67]` —— 正好反过来。
 * 后果是三条用例一起红，且红得像"修复没生效"。
 * 用 `writeUInt32LE(GGML_FILE_MAGIC)` 就不可能再抄反：夹具与判据引用同一个数。
 */
const GGML_MAGIC = (() => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return b;
})();

async function store(): Promise<{ root: string; ggml: string; onnx: string }> {
  const root = await mkdtemp(join(tmpdir(), 'om-engfmt-'));
  made.push(root);
  await mkdir(join(root, 'by-name', 'asr'), { recursive: true });
  const ggml = join(root, 'by-name', 'asr', 'ggml-tiny-q5_1.bin');
  const onnx = join(root, 'by-name', 'asr', 'encoder.onnx');
  await writeFile(ggml, Buffer.concat([GGML_MAGIC, Buffer.alloc(64)]));
  await writeFile(onnx, Buffer.from('\x08\x07protobuf-ish-not-ggml'));
  return { root, ggml, onnx };
}

/** 写一条安装记录 + active.json，模拟"先装的赢"那个真实状态。 */
async function install(
  root: string,
  p: { id: string; role: string; file: string; active?: boolean },
): Promise<void> {
  await mkdir(join(root, 'manifests', p.role), { recursive: true });
  await writeFile(
    join(root, 'manifests', p.role, `${p.id.replace(/\//g, '_')}.json`),
    JSON.stringify({
      id: p.id,
      role: p.role,
      integrity: 'ok',
      files: [{ role: 'weights', path: p.file }],
    }),
  );
  if (p.active) {
    await writeFile(join(root, 'active.json'), JSON.stringify({ [p.role]: p.id }));
  }
}

describe('引擎 ↔ 模型格式：契约本身', () => {
  it('★ 格式表对每个 AsrEngineId 都有一项 —— 加引擎不声明格式就编译不过', () => {
    /*
     * 编译期已经由 `satisfies Record<AsrEngineId, ModelFormat>` 保证了。
     * 这条用例是它的**运行期回声**：万一将来有人把 satisfies 改成宽松标注，
     * 这里会当场红，而不是让新引擎默默继承"什么都能读"。
     */
    for (const id of ASR_ENGINE_IDS) {
      assert.equal(
        typeof MODEL_FORMAT_BY_ENGINE[id],
        'string',
        `引擎 ${id} 没有声明它能加载的格式`,
      );
    }
    assert.equal(Object.keys(MODEL_FORMAT_BY_ENGINE).length, ASR_ENGINE_IDS.length);
  });

  it('canEngineLoad：whisper.cpp 只认 ggml，sherpa/paraformer 只认 onnx', async () => {
    const { ggml, onnx } = await store();
    assert.equal(await canEngineLoad('whisper.cpp', ggml), true);
    assert.equal(await canEngineLoad('whisper.cpp', onnx), false, 'whisper 不该接受 ONNX');
    assert.equal(await canEngineLoad('sherpa-onnx', onnx), true);
    assert.equal(await canEngineLoad('sherpa-onnx', ggml), false, 'sherpa 不该接受 ggml');
    assert.equal(await canEngineLoad('paraformer', ggml), false);
  });

  it('陌生格式一律判为"加载不了"（错判成不能 ≪ 错判成能）', async () => {
    const { root } = await store();
    const weird = join(root, 'by-name', 'asr', 'model.bin');
    await writeFile(weird, Buffer.from('NOT-A-KNOWN-FORMAT'));
    assert.equal(await canEngineLoad('whisper.cpp', weird), false);
    assert.equal(await canEngineLoad('sherpa-onnx', weird), false);
  });

  it('★★ active.json 指着 sherpa 模型时，whisper.cpp 拿不到它（本轮那个故障）', async () => {
    const { root, ggml, onnx } = await store();
    // 一比一复现 CI 上的状态：流式 sherpa 模型先装 → 它赢了 active 槽
    await install(root, {
      id: 'asr/sherpa-streaming-zh-14m',
      role: 'asr',
      file: onnx,
      active: true,
    });
    await install(root, { id: 'asr/whisper-tiny-q5_1', role: 'asr', file: ggml });

    /*
     * 前提自检：这份仓库状态必须真的"有对抗性" —— sherpa 得真能挑中那个 ONNX。
     * 不然下面那条绿了也只是因为仓库是空的。
     */
    const forSherpa = await resolveActiveModel(root, { role: 'asr', engine: 'sherpa-onnx' });
    assert.equal(
      forSherpa?.id,
      'asr/sherpa-streaming-zh-14m',
      '前提失效：active 槽没被 sherpa 占住',
    );

    const forWhisper = await resolveActiveModel(root, { role: 'asr', engine: 'whisper.cpp' });
    assert.equal(
      forWhisper?.id,
      'asr/whisper-tiny-q5_1',
      'whisper.cpp 应当跳过 active 槽里那个 ONNX，挑中它自己读得动的 ggml',
    );
  });

  it('★ 一个能读的都没有时返回 undefined（宁可"没模型"，也不给一个会崩的）', async () => {
    const { root, onnx } = await store();
    await install(root, {
      id: 'asr/sherpa-streaming-zh-14m',
      role: 'asr',
      file: onnx,
      active: true,
    });

    const forWhisper = await resolveActiveModel(root, { role: 'asr', engine: 'whisper.cpp' });
    assert.equal(
      forWhisper,
      undefined,
      '只有 ONNX 时 whisper.cpp 必须报"没有"，而不是把 ONNX 交出去',
    );
  });

  it('★ 用户显式选的模型同样要过格式关（选中即崩溃是我们的建模缺陷，不是他的错）', async () => {
    const { root, ggml, onnx } = await store();
    await install(root, { id: 'asr/sherpa-streaming-zh-14m', role: 'asr', file: onnx });
    await install(root, { id: 'asr/whisper-tiny-q5_1', role: 'asr', file: ggml });

    const bad = await resolveModelById(root, {
      role: 'asr',
      engine: 'whisper.cpp',
      id: 'asr/sherpa-streaming-zh-14m',
    });
    assert.equal(bad, undefined, '显式指定也不能把 ONNX 交给 whisper.cpp');

    // 反向：能读的那个必须照常拿得到（别把判断修成"永远拒绝"）
    const good = await resolveModelById(root, {
      role: 'asr',
      engine: 'whisper.cpp',
      id: 'asr/whisper-tiny-q5_1',
    });
    assert.equal(good?.id, 'asr/whisper-tiny-q5_1');
  });
});
