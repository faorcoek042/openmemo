import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogGroupWithFitness } from '@openmemo/shared';

import { isSuperseded, speedClassOf, splitAsrSections } from './asrSections';

/**
 * 转写 Tab 的分组规则（D-10 #9 / #10 / #29）。
 *
 * ## 为什么这几条值得单独存在
 *
 * 分组是**判断**，渲染是排版。判断写在组件里就只能靠"数一数渲染出几张卡"来验，
 * 而那种断言在**一张卡都没渲染出来**时同样是绿的（本仓 ⑤A 家族的常客）。
 *
 * ## 最要紧的一条：VAD / 标点必须出现，且**不能混进转写列表**
 *
 * `ModelsPage` 原来写死 `g.role === 'asr'`，于是 `role=vad` 的两个条目
 * **在网页上根本不存在**。后果不止"少两张卡"：daemon 的 `model.vad` 自检项
 * 算好了一句 remediation「在「模型」页安装 `vad/silero-vad-ggml`」——
 * **而那一页不渲染 VAD**。一条具体但无法执行的指引比没有指引更糟：
 * 用户会照着去做，发现那页什么都没有，然后开始怀疑是自己的问题。
 *
 * 但"让它出现"和"把它塞进 ASR 列表"是两回事：
 * 用户心智里"识别引擎"与"切句子的""补标点的"不是同一类东西。
 * 所以判据有两半 —— **在 realtime 里** 且 **不在其它任何一组里**。
 */

type G = CatalogGroupWithFitness;

/** 造一个够用的目录组。字段少写不影响判据 —— 分组只看 role / tags / speedClass。 */
function group(
  groupId: string,
  role: string,
  variants: { id: string; speedClass?: string; tags?: string[] }[],
  groupTags: string[] = [],
): G {
  return {
    groupId,
    role,
    tags: groupTags,
    variants: variants.map((v) => ({
      id: v.id,
      speedClass: v.speedClass ?? 'balance',
      tags: v.tags ?? [],
    })),
  } as unknown as G;
}

/** 与 `vendor/manifests/` 里的真实标签一致 —— 判据不许写死 id，所以夹具只带标签。 */
const PARAFORMER = group('asr/paraformer-zh-small', 'asr', [
  {
    id: 'asr/paraformer-zh-small',
    speedClass: 'fast',
    tags: ['recommended-default-zh', 'offline'],
  },
]);
const TURBO = group('asr/whisper-large-v3-turbo', 'asr', [
  { id: 'turbo-q5_0', speedClass: 'quality', tags: ['recommended-default', 'multilingual'] },
  { id: 'turbo-f16', speedClass: 'quality', tags: ['multilingual'] },
]);
const SHERPA = group('asr/sherpa-streaming-zh-14m', 'asr', [
  { id: 'asr/sherpa-streaming-zh-14m', speedClass: 'fast', tags: ['streaming', 'required-for-f3'] },
]);
const VAD = group('vad/silero-vad', 'vad', [
  { id: 'vad/silero-vad-onnx', speedClass: 'fast', tags: ['vad'] },
  { id: 'vad/silero-vad-ggml', speedClass: 'fast', tags: ['vad'] },
]);
const PUNCT = group('punctuation/ct-transformer-zh-en', 'punctuation', [
  { id: 'punctuation/ct-transformer-zh-en', speedClass: 'balance', tags: ['punctuation'] },
]);
const TINY = group('asr/whisper-tiny', 'asr', [{ id: 'tiny-q5_1', speedClass: 'fast', tags: [] }]);
const SMALL = group('asr/whisper-small', 'asr', [
  { id: 'small-q5_1', speedClass: 'balance', tags: [] },
]);
const V3 = group('asr/whisper-large-v3', 'asr', [
  { id: 'v3-q5_0', speedClass: 'quality', tags: ['high-accuracy'] },
]);
const V2 = group('asr/whisper-large-v2', 'asr', [
  { id: 'v2-q5_0', speedClass: 'quality', tags: ['superseded'] },
  { id: 'v2-f16', speedClass: 'quality', tags: ['superseded'] },
]);
const V1 = group('asr/whisper-large-v1', 'asr', [
  { id: 'v1-f16', speedClass: 'quality', tags: ['superseded'] },
]);
/** ADR-016 砍掉的内置 GGUF。目录里还在，这一页一条都不该出现。 */
const LLM = group('llm/qwen3-4b', 'llm', [
  { id: 'llm/qwen3-4b-q4_k_m', speedClass: 'balance', tags: ['recommended-default'] },
]);

const ALL = [VAD, SHERPA, PARAFORMER, PUNCT, LLM, TINY, SMALL, V1, V2, V3, TURBO];

const idsOf = (gs: readonly G[]) => gs.map((g) => g.groupId);

describe('转写 Tab 分组（D-10 #9 / #10 / #29）', () => {
  test('★ VAD 与标点必须出现在「实时字幕组件」里 —— 而且只在那里', () => {
    const s = splitAsrSections(ALL);
    assert.deepEqual(idsOf(s.realtime), [
      'vad/silero-vad',
      'asr/sherpa-streaming-zh-14m',
      'punctuation/ct-transformer-zh-en',
    ]);

    /*
     * 另一半：它们**不许**跑到别的组里去。
     * 只断"在 realtime 里"的话，把过滤器放宽成"什么都放进转写列表"照样绿 ——
     * 而那正是任务里点名不许干的事。
     */
    const elsewhere = [...s.recommended, ...s.more.flatMap((b) => [...b.groups, ...b.superseded])];
    for (const id of ['vad/silero-vad', 'punctuation/ct-transformer-zh-en']) {
      assert.equal(
        idsOf(elsewhere).includes(id),
        false,
        `${id} 同时出现在了别的组里 —— 它不是一个可以拿来替代 Whisper 的转写模型`,
      );
    }
  });

  test('★ 语言模型的目录条目一条都不许进这一页（ADR-016 砍了整条线）', () => {
    const s = splitAsrSections(ALL);
    const everything = [
      ...s.recommended,
      ...s.realtime,
      ...s.more.flatMap((b) => [...b.groups, ...b.superseded]),
    ];
    assert.equal(
      idsOf(everything).some((id) => id.startsWith('llm/')),
      false,
      '下完没有引擎能跑它 —— 留在页面上就是让用户下载一个跑不了的文件',
    );
    // 前提自检：夹具里确实放了一个，否则上面那条是在证明一件不存在的事
    assert.ok(ALL.some((g) => g.role === 'llm'));
  });

  test('★ 推荐只放带 recommended 标签的，且一个组只进一组', () => {
    const s = splitAsrSections(ALL);
    assert.deepEqual(idsOf(s.recommended), [
      'asr/paraformer-zh-small',
      'asr/whisper-large-v3-turbo',
    ]);
    // Paraformer 的 speedClass 是 fast —— 若分组不是"first match wins"，它会在「快」档里再出现一次
    const fast = s.more.find((b) => b.speedClass === 'fast');
    assert.equal(
      idsOf(fast?.groups ?? []).includes('asr/paraformer-zh-small'),
      false,
      '同一个组出现在两处 —— 用户会以为是两个不同的模型',
    );
  });

  test('★ 更多档位按 speedClass 分，顺序固定为 快 → 均衡 → 高质量', () => {
    const s = splitAsrSections(ALL);
    assert.deepEqual(
      s.more.map((b) => b.speedClass),
      ['fast', 'balance', 'quality'],
    );
    assert.deepEqual(idsOf(s.more[0]!.groups), ['asr/whisper-tiny']);
    assert.deepEqual(idsOf(s.more[1]!.groups), ['asr/whisper-small']);
  });

  test('★ superseded 收进折叠行，不平铺（4 组里有 2 组是不该选的）', () => {
    const s = splitAsrSections(ALL);
    const quality = s.more.find((b) => b.speedClass === 'quality')!;
    assert.deepEqual(idsOf(quality.groups), ['asr/whisper-large-v3'], '平铺的只该剩没被取代的');
    assert.deepEqual(
      idsOf(quality.superseded),
      ['asr/whisper-large-v1', 'asr/whisper-large-v2'],
      '被新版本取代的应收进折叠行',
    );
    // 折叠 ≠ 删除：它们仍然在返回值里，用户展开就能看到（复现旧结果是真实需求）
    assert.equal(quality.groups.length + quality.superseded.length, 3);
  });

  test('★ 只有一部分变体带 superseded 时不折叠（那多半是目录写漏了，别替它做决定）', () => {
    const half = group('asr/half', 'asr', [
      { id: 'a', speedClass: 'quality', tags: ['superseded'] },
      { id: 'b', speedClass: 'quality', tags: [] },
    ]);
    assert.equal(isSuperseded(half), false);
    assert.equal(isSuperseded(V2), true);
  });

  test('空档不返回 —— 画一个空标题只会让人问"是不是还没做完"', () => {
    const s = splitAsrSections([TINY]);
    assert.deepEqual(
      s.more.map((b) => b.speedClass),
      ['fast'],
    );
    assert.deepEqual(s.recommended, []);
    assert.deepEqual(s.realtime, []);
  });

  test('★ 服务端少发一个数组字段不许把整页带塌', () => {
    const broken = {
      groupId: 'asr/broken',
      role: 'asr',
      // tags / variants 全缺 —— 真实事故里少的就是这类可选字段
    } as unknown as G;
    const s = splitAsrSections([broken, TINY]);
    assert.equal(idsOf(s.more.flatMap((b) => b.groups)).includes('asr/broken'), true);
    // 一个档位都识别不出来时落到"均衡" —— 主张最少的那一档
    assert.equal(speedClassOf(broken), 'balance');
  });

  test('档位取多数，不是静默取第一个（目录写歪了不该变成"界面上少一组"）', () => {
    const mixed = group('asr/mixed', 'asr', [
      { id: 'a', speedClass: 'fast' },
      { id: 'b', speedClass: 'quality' },
      { id: 'c', speedClass: 'quality' },
    ]);
    assert.equal(speedClassOf(mixed), 'quality');
  });
});
