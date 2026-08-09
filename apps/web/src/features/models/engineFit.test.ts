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
 * ## 把名字遮住，这些断言什么时候会失败
 *
 * 任何人把 `reason` 又丢掉、把"还不知道"当成"不能用"、
 * 或者让提示去念一个**不相干引擎**的原因。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineFit, type LocalEngine } from './engineFit';

/** `:10000` 上 `GET /api/health` 的 `pipeline.engines` 原文（2026-08-09 抄的）。 */
const LIVE: LocalEngine[] = [
  { id: 'whisper.cpp', available: true },
  {
    id: 'sherpa-onnx',
    available: false,
    reason: '未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字',
  },
  {
    id: 'paraformer',
    available: false,
    reason:
      '未安装离线中文模型 —— 去「模型」页装 “Paraformer 中文 small” 即可启用（ADR-013：中文默认引擎）',
  },
];

describe('模型卡上「适配哪个引擎」那一行（T-191 ④）', () => {
  it('★ 引擎没启用时，必须把 daemon 那句可执行的原因带出来', () => {
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    assert.equal(r.kind, 'not-enabled');
    assert.equal(r.reasons.length, 1, `原因被丢了 —— 那正是"当前用不上"这句话的成因`);
    assert.match(
      r.reasons[0] ?? '',
      /去「模型」页装/,
      '带出来的必须是那句**告诉他下一步**的话，而不是随便一句状态描述',
    );
  });

  it('★ 用户那张卡：装上它本身就是启用那个引擎的办法 —— 不许说成"用不上"', () => {
    /*
     * `asr/sherpa-streaming-zh-14m` 的 `engines` 就是 `['sherpa-onnx']`，
     * 而 daemon 的原因里点名让他装的正是这一个。
     * 判据不是"文案里不许出现某个词"（那是钉关键词），
     * 是**这条提示必须携带那句话本身** —— 用户读完知道该做什么。
     */
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    assert.ok(
      r.reasons.some((x) => x.includes('sherpa 流式中文 zh-14M')),
      '提示里没有 daemon 点名的那个模型 —— 用户仍然不知道该装什么',
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
    assert.equal(
      r.reasons.some((x) => x.includes('Paraformer')),
      false,
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

  it('★ 空字符串不算原因（"给了一句空话"要按"没给"处理）', () => {
    const r = engineFit({
      engines: ['sherpa-onnx'],
      local: [{ id: 'sherpa-onnx', available: false, reason: '' }],
      ready: true,
    });
    assert.deepEqual([...r.reasons], []);
  });

  it('★ 两个引擎给出同一句原因时去重', () => {
    const same = '未安装中文模型 —— 去「模型」页装';
    const r = engineFit({
      engines: ['sherpa-onnx', 'paraformer'],
      local: [
        { id: 'sherpa-onnx', available: false, reason: same },
        { id: 'paraformer', available: false, reason: same },
      ],
      ready: true,
    });
    assert.equal(r.reasons.length, 1, '同一句话说两遍');
  });

  it('★ 本机报了这个引擎、但它不在这条模型的 engines 里 ⇒ 不影响判定', () => {
    const r = engineFit({ engines: ['sherpa-onnx'], local: LIVE, ready: true });
    assert.equal(r.kind, 'not-enabled', 'whisper.cpp 可用不代表这条 sherpa 模型能用');
  });
});
