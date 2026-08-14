/**
 * 「适配 X · 当前用不上」这行字的判据（T-191 ④）。
 *
 * ## 用户 2026-08-09 在 `:10000` 上问的就是它
 *
 * > 「2.1『适配 sherpa-onnx · 当前用不上』这个是什么情况」
 *
 * 而同一时刻 daemon 在 `GET /api/health` 里说的是：
 *
 * ```json
 * { "id": "sherpa-onnx", "available": false,
 *   "reason": "未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字" }
 * ```
 *
 * `[实测]` 目录里带 `engines:['sherpa-onnx']` 的**只有 4 条**，其中两条正是
 * `asr/sherpa-streaming-zh-14m` 与 `asr/paraformer-zh-small` ——
 * **daemon 让他装的那两个模型，卡片上写着「当前用不上」。**
 *
 * ## 判据（Manager 2026-08-09）
 *
 * 那行字要能让人分清：(a) 有更好的替代所以用不上 / (b) 出了问题所以用不上 / (c) 该做什么。
 * 「当前用不上」三件都答不了，所以这里改成**照抄 daemon 的 `reason`** —— 它自带 (b)+(c)。
 *
 * ## ⚠️ #112：`reason` 现在是**档位 + 数据**，上面那句中文已经不在契约里了
 *
 * 那句中文正是这次修掉的东西：它被这张卡原样插进
 * `models.engineFit.notEnabledWithReason` 的 `{{reason}}` 里，**英文界面上半句中文**。
 * 本模块的职责一个字没变 ——「哪几条原因该被念出来」—— 只是那"一条原因"现在是
 * `EngineUnavailableReason`，措辞归 `components/common/engineReasonText.ts` + 两份 locale。
 *
 * 所以下面的断言也从「那句话里有没有某个词」换成了**落在哪一档、带了哪些数据**。
 * 「读起来说没说清下一步」那一层没有丢，它搬去了 `engineReasonText.test.ts`
 * （断的是渲染出来的英文，比在这里读一句中文更接近用户）。
 *
 * ## 把名字遮住，这些断言什么时候会失败
 *
 * 任何人把 `reason` 又丢掉、把"还不知道"当成"不能用"、
 * 或者让提示去念一个**不相干引擎**的原因。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineFit, type LocalEngine } from './engineFit';

/**
 * 同一台机器、同一刻的 `pipeline.engines`，**#112 之后的形状**。
 *
 * 两条不可用的腿刻意落在**不同的档**：都写 `model_not_installed` 的话，
 * 两条原因会是同一个对象，「只念这条模型声明的那个引擎的原因」那条就分不出真假了。
 * 这个组合本身也是真机上会出现的 —— 一个没装、一个装了但文件缺。
 */
const LIVE: LocalEngine[] = [
  { id: 'whisper.cpp', available: true },
  { id: 'sherpa-onnx', available: false, reason: { kind: 'model_not_installed' } },
  {
    id: 'paraformer',
    available: false,
    reason: {
      kind: 'installed_but_files_incomplete',
      installedIds: ['asr/paraformer-zh-small'],
    },
  },
];

describe('模型卡上「适配哪个引擎」那一行（T-191 ④）', () => {
  it('★ 引擎没启用时，必须把 daemon 那句可执行的原因带出来', () => {
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    assert.equal(r.kind, 'not-enabled');
    assert.equal(r.reasons.length, 1, `原因被丢了 —— 那正是"当前用不上"这句话的成因`);
    assert.deepEqual(
      r.reasons[0],
      { kind: 'model_not_installed' },
      '带出来的必须是 daemon 实测的那一档（它决定界面说"去装一个"还是"重装它"），' +
        '而不是随便一个状态',
    );
  });

  it('★ 用户那张卡：装上它本身就是启用那个引擎的办法 —— 不许说成"用不上"', () => {
    /*
     * `asr/sherpa-streaming-zh-14m` 的 `engines` 就是 `['sherpa-onnx']`，
     * 而 daemon 说的正是「这个引擎一个模型都没装」。
     *
     * ⚠️ #112 之后判据落在**档位**上，而不是"那句话里有没有出现模型名"：
     * 模型名本来就不该由 daemon 拼进句子（那正是半句中文的来源）。
     * `model_not_installed` 这一档的含义就是「装一个模型真能修好」——
     * 界面据此指向「模型」页，而这一页每张卡上都有 `EngineFitChip`，照着找得到。
     * 落到 `installed_but_files_incomplete` 才是真的答错了：那会叫他重装一个
     * 他根本没装过的东西。
     */
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    assert.equal(
      r.reasons[0]?.kind,
      'model_not_installed',
      '这一档的含义是"装一个就能用"，换成别的档，界面给的下一步就是错的',
    );
  });

  it('★ 引擎可用时是 fits，且不带原因（不许对着能用的东西发警告）', () => {
    const r = engineFit({ engines: ['whisper.cpp'], local: LIVE, ready: true });
    assert.equal(r.kind, 'fits');
    assert.deepEqual([...r.reasons], []);
  });

  it('★ 多引擎里只要有一个可用就是 fits', () => {
    const r = engineFit({ engines: ['sherpa-onnx', 'whisper.cpp'], local: LIVE, ready: true });
    assert.equal(r.kind, 'fits');
  });

  it('★ health 还没回来 ⇒ unknown，**不下"用不上"的判断**', () => {
    const r = engineFit({ engines: ['sherpa-onnx'], local: [], ready: false });
    assert.equal(r.kind, 'unknown', '把"我还不知道"渲染成"我知道它不行"，是同一族的谎');
    assert.deepEqual([...r.reasons], []);
  });

  it('★ 只念**这条模型声明的**引擎的原因，不许捎带别人的', () => {
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    /*
     * Paraformer 那条在夹具里是 `installed_but_files_incomplete`，
     * 而这张卡只声明了 sherpa-onnx。判据钉在"整条原因"上（`deepEqual` 到
     * 只有一条、且就是 sherpa 那条），比"某个字符串没出现"严：
     * 换个措辞、换个 id，前者照样红，后者会静默漂掉。
     */
    assert.deepEqual(
      [...r.reasons],
      [{ kind: 'model_not_installed' }],
      '念了不相干引擎的原因 —— 一条会对不相干的东西发表意见的提示，说对的时候也不该被相信',
    );
  });

  it('★ daemon 没给原因时不编一个（reasons 为空，由调用方退回中性文案）', () => {
    const r = engineFit({
      engines: ['sherpa-onnx'],
      local: [
        { id: 'whisper.cpp', available: true },
        { id: 'sherpa-onnx', available: false },
      ],
      ready: true,
    });
    assert.equal(r.kind, 'not-enabled');
    assert.deepEqual([...r.reasons], [], '没有原因就该是空的，不许凑一句出来');
  });

  it('★ 显式的 `reason: undefined` 与"这一格根本没有"是同一回事', () => {
    /*
     * #112 之前这一条钉的是「空字符串不算原因」—— 那时 `reason` 是 `string`，
     * daemon 给一句空话与不给，在类型上分不开。现在分得开了：认不出的东西在
     * `normalizeEngineReason()` 那一层就收成 `null`，`useAsrEngines()` 于是
     * **连 `reason` 这个键都不放**。这一条守的是它的下一环：
     * 到了这里，`undefined` 就是"没给"，不许被当成一条原因塞进列表。
     */
    const r = engineFit({
      engines: ['sherpa-onnx'],
      local: [{ id: 'sherpa-onnx', available: false, reason: undefined }],
      ready: true,
    });
    assert.deepEqual([...r.reasons], []);
  });

  it('★ 两个引擎给出同一条原因时去重（按整条原因，不是按 kind）', () => {
    const same = { kind: 'model_not_installed' } as const;
    const r = engineFit({
      engines: ['sherpa-onnx', 'paraformer'],
      local: [
        // 刻意是**两个不同的对象**：按引用去重会在这里漏掉
        { id: 'sherpa-onnx', available: false, reason: { ...same } },
        { id: 'paraformer', available: false, reason: { ...same } },
      ],
      ready: true,
    });
    assert.equal(r.reasons.length, 1, '同一条原因说两遍');
  });

  it('★★ 同一档、但数据不同的两条**不许**被去重掉', () => {
    /*
     * 这是上一条的鉴别腿。两个引擎可能同时落在 `installed_but_files_incomplete`，
     * 而 `installedIds` 是**不同的两串 id** —— 按 `kind` 去重会静默吃掉一条，
     * 用户于是只被告知重装其中一个，另一个坏的永远没人提。
     */
    const r = engineFit({
      engines: ['sherpa-onnx', 'paraformer'],
      local: [
        {
          id: 'sherpa-onnx',
          available: false,
          reason: {
            kind: 'installed_but_files_incomplete',
            installedIds: ['asr/sherpa-streaming-zh-14m'],
          },
        },
        {
          id: 'paraformer',
          available: false,
          reason: {
            kind: 'installed_but_files_incomplete',
            installedIds: ['asr/paraformer-zh-small'],
          },
        },
      ],
      ready: true,
    });
    assert.equal(r.reasons.length, 2, '按 kind 去重把另一个装坏了的模型藏起来了');
  });

  it('★ 本机报了这个引擎、但它不在这条模型的 engines 里 ⇒ 不影响判定', () => {
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    assert.equal(r.kind, 'not-enabled', 'whisper.cpp 可用不代表这条 sherpa 模型能用');
  });
});
