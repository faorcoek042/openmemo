/**
 * #90 C —— **换了模型立刻提交，这一次必须跑用户选的那个。**
 *
 * ## 那个竞态
 *
 * 重转面板里的模型选择器是 `onChange` **立刻** `POST /api/models/activate`
 * （不是提交时）。daemon await 落盘 `active.json` 再返回 200，所以"存下来了"可信。
 *
 * **"生效了"不可信**：转写用的路径来自 `bundle.modelPath`，而 `bundle` 只在
 * `main.ts` 那个 **800ms debounce**（滑动窗口）的 SSE 监听里重建。于是 200 回来、
 * 用户立刻点「开始重跑」—— 这一次跑的仍是**旧模型**。
 * 审计实测到的正是这一幕：`active.json` 已改，跑的还是上一个，**零报错**。
 *
 * ## 这个文件钉两件事（Manager 给的两条判据）
 *
 * 1. **修法有效**：不重建 bundle 的前提下改 `active.json`，起任务时解析出来的
 *    必须是新模型。抽掉 `transcribe.ts` 里那段现读 → 它拿到的是快照里的旧值 → 红。
 * 2. **其余部分没变**：同一次改动**不许**动摇引擎选择与后端探测。
 *    这条不是"我小心了"，是能红的断言 —— 谁要是让引擎选择读上了 `active.json`，
 *    第二组当场红。
 *
 * ## 为什么第 1 条不起真 daemon
 *
 * 被测的那一跳是**纯解析**：`resolveWhisperModelPath()` 读盘 → runner 把它当
 * `override.modelPath` 喂给 `pipelineFor`。起真 daemon 要真模型、真后端二进制，
 * 而它们证明不了多一分 —— 反倒会让这条用例在没装 whisper-cli 的机器上假绿。
 * runner 那一跳的接线由 `mergeWords.test.ts`（全仓唯一调 `runTranscribeJob` 的用例）
 * 覆盖着，它会因为 deps 少一个字段而编译不过。
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { GGML_FILE_MAGIC } from '@openmemo/downloader';

import { resolveWhisperModelPath } from './setup.js';

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

/** whisper.cpp 自己检查的那 4 个字节。从常量写出来，不手抄（抄反过一次）。 */
const GGML_MAGIC = (() => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return b;
})();

/** 两个**都能被 whisper.cpp 加载**的模型 —— 差别只在"哪个被激活"。 */
async function storeWithTwoModels(): Promise<{ root: string; a: string; b: string }> {
  const root = await mkdtemp(join(tmpdir(), 'om-race-'));
  made.push(root);
  await mkdir(join(root, 'by-name', 'asr'), { recursive: true });
  const a = join(root, 'by-name', 'asr', 'ggml-tiny-q5_1.bin');
  const b = join(root, 'by-name', 'asr', 'ggml-large-v3-q5_1.bin');
  for (const f of [a, b]) await writeFile(f, Buffer.concat([GGML_MAGIC, Buffer.alloc(64)]));
  await install(root, { id: 'asr/whisper-tiny-q5_1', file: a });
  await install(root, { id: 'asr/whisper-large-v3-q5_1', file: b });
  return { root, a, b };
}

async function install(root: string, p: { id: string; file: string }): Promise<void> {
  await mkdir(join(root, 'manifests', 'asr'), { recursive: true });
  await writeFile(
    join(root, 'manifests', 'asr', `${p.id.replace(/\//g, '_')}.json`),
    JSON.stringify({
      id: p.id,
      role: 'asr',
      integrity: 'ok',
      files: [{ role: 'weights', path: p.file }],
    }),
  );
}

/** 用户在选择器里点一下 = daemon 落盘这一个文件。**只写它，什么都不重建。** */
async function activate(root: string, id: string): Promise<void> {
  await writeFile(join(root, 'active.json'), JSON.stringify({ asr: id }));
}

describe('★★ #90 C 换了模型立刻提交：跑的必须是用户选的那个', () => {
  it('★★ 不重建 pipeline，改完 active.json 起任务就要看见新模型', async () => {
    const { root, a, b } = await storeWithTwoModels();

    await activate(root, 'asr/whisper-tiny-q5_1');
    const before = await resolveWhisperModelPath(root, null, {});
    assert.equal(before.path, a, '前提没达成：一开始激活的应该是 A，后面的断言就没意义了');

    // ── 用户在面板里换成 B 并**立刻**提交（这里连一毫秒都不等）──
    await activate(root, 'asr/whisper-large-v3-q5_1');

    const atJobStart = await resolveWhisperModelPath(root, null, {});
    assert.equal(
      atJobStart.path,
      b,
      '换完模型立刻起任务，拿到的还是旧模型 —— 用户选了 B，这一次跑的是 A，' +
        '而且全程没有任何一处会报错，他只能靠转写质量去猜',
    );
  });

  it('★ 环境变量仍然压过 active.json（现读不许把开发用的覆盖手段吃掉）', async () => {
    const { root, a, b } = await storeWithTwoModels();
    await activate(root, 'asr/whisper-large-v3-q5_1');
    const r = await resolveWhisperModelPath(root, null, { OPENMEMO_ASR_MODEL: a });
    assert.equal(r.path, a, '三级优先序的第一级被现读绕过了 —— env > active.json > 扫描');
    assert.notEqual(r.path, b);
  });

  it('★ ASR≠VAD 那道闸跟着一起搬了（不搬 = 起任务时绕过它）', async () => {
    const { root, b } = await storeWithTwoModels();
    await activate(root, 'asr/whisper-large-v3-q5_1');
    // 把"解析出来的那个"同时当成 VAD 权重传进去 —— 闸必须否掉它
    const r = await resolveWhisperModelPath(root, b, {});
    assert.equal(
      r.path,
      null,
      'ASR 解析到了 VAD 权重却放行 —— whisper 拿 VAD 网络去转写，健康检查全绿，' +
        '用户只看到转写结果是垃圾',
    );
    assert.equal(r.warnings.length, 1, '否掉了但一个字不说，等于把它藏起来');
  });

  it('解析不出来时如实给 null（现读不许变成一条新的失败路径）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'om-race-empty-'));
    made.push(empty);
    const r = await resolveWhisperModelPath(empty, null, {});
    assert.equal(r.path, null);
    assert.equal(r.warnings.length, 0, '什么都没装不是一件需要警告的事');
  });
});

/**
 * ★★ Manager 划的边界的**可执行版本**：只有模型路径这一件事会动。
 *
 * 判据不是"我没改引擎那几行"，而是一条性质：
 * **`active.json` 变了，模型路径必须变，而引擎侧的输入必须逐字不变。**
 *
 * 这条性质今天成立，靠的是一个容易看反的事实（我第一次判断时就看反了）：
 * `active.json` 只喂 whisper.cpp 那一条路径；sherpa 与 paraformer 的模型是按
 * **安装记录的文件形状**挑的（`looksLikeTransducer` / `looksLikeParaformer`），
 * 从不读 `active.json`；而引擎可不可用只取决于二进制在不在
 * （`WhisperCppEngine.isAvailable()` 全文只有一句 `isExecutable(tools.whisperCli)`）。
 *
 * 谁要是哪天让引擎选择读上了 `active.json`，下面这条当场红 ——
 * 那时候「起任务时现读模型」就不再是安全的，必须回来重新论证。
 */
describe('★★ #90 C 边界：现读模型不许动摇引擎选择', () => {
  it('★★ active.json 换来换去，whisper.cpp 之外的引擎解析结果逐字不变', async () => {
    const { root } = await storeWithTwoModels();
    const { resolveStreamingModel, resolveOfflineChineseModel } = await import('./setup.js');

    await activate(root, 'asr/whisper-tiny-q5_1');
    const streamBefore = await resolveStreamingModel(root, {});
    const paraBefore = await resolveOfflineChineseModel(root, {});

    await activate(root, 'asr/whisper-large-v3-q5_1');
    const streamAfter = await resolveStreamingModel(root, {});
    const paraAfter = await resolveOfflineChineseModel(root, {});

    assert.deepEqual(
      { dir: streamAfter.dir ?? null, reasonZh: streamAfter.reasonZh },
      { dir: streamBefore.dir ?? null, reasonZh: streamBefore.reasonZh },
      'sherpa 的解析被 active.json 影响了 —— 那意味着激活能改变 engines[] 的成员，' +
        '于是"只现读模型路径"这条边界不再成立，起任务时现读会配出「新模型 + 旧引擎」',
    );
    assert.deepEqual(
      { model: paraAfter.model ?? null, reasonZh: paraAfter.reasonZh },
      { model: paraBefore.model ?? null, reasonZh: paraBefore.reasonZh },
      'paraformer 的解析被 active.json 影响了 —— 同上',
    );
  });

  it('★ 而 whisper.cpp 那条**确实**跟着变（否则上一条是靠"什么都没变"蒙对的）', async () => {
    const { root, a, b } = await storeWithTwoModels();
    await activate(root, 'asr/whisper-tiny-q5_1');
    assert.equal((await resolveWhisperModelPath(root, null, {})).path, a);
    await activate(root, 'asr/whisper-large-v3-q5_1');
    assert.equal(
      (await resolveWhisperModelPath(root, null, {})).path,
      b,
      '两条一起看才有意义：一条说"引擎侧没动"，另一条说"模型侧真的动了"',
    );
  });
});
