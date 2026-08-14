/**
 * 录音页那条 WS 错误横幅 —— **英文用户真的读到了什么**（#112 第 19 处）。
 *
 * ## 判据为什么落在「渲染出来的那句话」上，而不是「key 存不存在」
 *
 * 这一处的缺陷不是"翻译漏了一条"，而是**帧上根本没有英文可渲染**：
 * `/ws/recorder` 的 error 帧原来只有 `messageZh`，`RecorderPage` 直接把它
 * `setStreamError()`。断言"表里有七个 key"对这个缺陷是**完全空转**的 ——
 * 缺陷版本里那张表压根不存在，而它存在之后也不保证有人真去用它。
 * 所以下面每一条都取**渲染结果**：非空、无汉字、原文那一段真的在里面。
 *
 * ## 🔴 最要紧的是最后那一条
 *
 * 渲染点是 `{streamError ? <Banner tone="warning" title={streamError} /> : null}` ——
 * **假值渲染出来的是什么都没有**。会话已经死了，而用户不知道出过事，
 * 这比一句说错了的话更糟。老 daemon 的帧（没有 `reason`）正是会走到那一步的东西，
 * 所以它单独占一条，并且**连它带来的那句中文一起钉住**：横幅里不许出现它。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import en from '../../app/i18n/locales/en.json';
import {
  RECORDER_ERROR_KEYS,
  normalizeRecorderError,
  recorderErrorText,
  type RenderableRecorderError,
} from './recorderErrorText';

/**
 * CJK 表意文字 + CJK 标点 + 全角形式。
 *
 * ⚠️ **写 `\u` 转义，不写字面量**：范围首字符是 U+3000 全角空格，
 * 直接写进正则会被 eslint 的 `no-irregular-whitespace` 判红，
 * 而且在 diff 里根本看不出来。
 */
const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

/** 从 `en.json` 取一条词条 —— **断言里不许我自己另写一句英文**。 */
function enAt(key: string): string {
  let node: unknown = en;
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  assert.equal(typeof node, 'string', `en.json 里没有 ${key} —— 断言本身就落空了`);
  return node as string;
}

/**
 * 英文界面那个 `t()`。
 *
 * ★ 它**读的是产品真正的 `en.json`**，插值规则与 i18next 一致（`{{name}}`），
 * 所以下面断言的就是用户屏幕上那句话。
 *
 * ⚠️ 它在一处**比 i18next 更严**，而这一处是刻意的：key 不存在时 i18next 会把
 * **key 本身**原样返回 —— 一个非空串。那样的话"每一格都渲染得出非空文字"
 * 这条断言就变成空转：拼错的 key 照样"非空"。这里改成当场失败。
 */
function t(key: string, params?: Record<string, unknown>): string {
  const raw = enAt(key);
  return raw.replace(/\{\{(\w+)\}\}/g, (_whole, name: string) => {
    const value = params?.[name];
    assert.notEqual(value, undefined, `词条 ${key} 要一个 {{${name}}}，调用方没传`);
    return String(value);
  });
}

/** 三条 verbatim 腿各自的原文。**互不相同** —— 否则"带上了自己的那一段"分不出真假。 */
const DETAILS = {
  start_failed: 'EACCES: permission denied, mkdir /data/media/recordings',
  engine_error: 'sherpa-onnx: decoder state is corrupt (code 7)',
  finalize_failed: 'ENOSPC: no space left on device, write',
} as const;

/**
 * 每一格的样本。**总 `Record`**：`RenderableRecorderError` 加一格而这里没有样本，
 * **编译当场就红** —— 新加的那一格不会悄悄地一条断言都没过。
 */
const SAMPLES: Readonly<Record<RenderableRecorderError['kind'], RenderableRecorderError>> = {
  stream_engine_unavailable: { kind: 'stream_engine_unavailable' },
  start_failed: { kind: 'start_failed', detail: DETAILS.start_failed },
  engine_error: { kind: 'engine_error', detail: DETAILS.engine_error },
  finalize_failed: { kind: 'finalize_failed', detail: DETAILS.finalize_failed },
  control_message_not_json: { kind: 'control_message_not_json' },
  asr_worker_not_implemented: { kind: 'asr_worker_not_implemented' },
  not_reported: { kind: 'not_reported' },
};

describe('#112 第 19 处：录音页的 WS 错误横幅（英文界面）', () => {
  it('前提检查：这条正则真的抓得到汉字与全角标点（否则下面全是空转）', () => {
    assert.equal(CJK.test('流式识别引擎不可用（未安装流式模型）'), true);
    assert.equal(
      CJK.test('Live transcription cannot start: no streaming model is installed.'),
      false,
    );
  });

  it('★ 每一格都渲染得出一句非空、不含汉字的英文', () => {
    const kinds = Object.keys(SAMPLES);
    assert.equal(
      kinds.length,
      Object.keys(RECORDER_ERROR_KEYS).length,
      '样本数与总表对不上 —— 有一格没被测到',
    );
    assert.ok(kinds.length >= 7, '样本少于七格，覆盖不到全部错法');

    for (const kind of kinds) {
      const text = recorderErrorText(t, SAMPLES[kind as RenderableRecorderError['kind']]);
      /*
       * 空串在这条链上不是"少一句解释"，是 `{streamError ? … : null}` 整条横幅消失。
       * 所以判据是 `trim()` 之后仍然非空，不是 `!== undefined`。
       */
      assert.notEqual(text.trim(), '', `${kind} 渲染成了空白 —— 横幅整条不会出现`);
      assert.equal(CJK.test(text), false, `${kind} 的英文里混进了中文：${text}`);
      assert.ok(
        text.length > 20,
        `${kind} 只有 ${String(text.length)} 个字符，不像一句话：${text}`,
      );
    }
  });

  it('★ 三条 verbatim 腿真的把 daemon 那段原文带上了（阶段知道、成因是原文）', () => {
    for (const [kind, detail] of Object.entries(DETAILS)) {
      const text = recorderErrorText(t, SAMPLES[kind as RenderableRecorderError['kind']]);
      assert.ok(
        text.includes(detail),
        `${kind} 把原文弄丢了 —— 用户看到一句"出错了"却拿不到任何可查的线索：${text}`,
      );
      /*
       * 而且原文**不是**这句话的全部：词条自己要说清"这一段是原文、没翻译"。
       * 只发原文等于把一段没有 i18n 的字符串当成产品文案。
       */
      assert.ok(text.length > detail.length + 20, `${kind} 除了原文什么都没说：${text}`);
    }
  });

  it('★ 总表里每个 key 都真的指到一条 en.json 词条', () => {
    for (const [kind, key] of Object.entries(RECORDER_ERROR_KEYS)) {
      assert.notEqual(enAt(key).trim(), '', `${kind} 的词条 ${key} 是空的`);
    }
  });

  it('🔴★★ 老 daemon 的帧（根本没有 reason）照样渲染出一条非空横幅', () => {
    /*
     * 逐字就是 v0.7.2 及以前那条帧 —— 连它那句中文一起。
     * 走 `JSON.parse` 而不是写对象字面量：这就是 `ws.onmessage` 手里那个东西，
     * **没有任何类型在守它**。
     */
    const frame: unknown = JSON.parse(
      '{"type":"error","code":"ASR_STREAM_UNAVAILABLE","messageZh":"流式识别引擎不可用（未安装流式模型）"}',
    );
    const reason = (frame as { reason?: unknown }).reason;
    assert.equal(reason, undefined, '这条帧本来就该没有 reason，否则测的不是老 daemon');

    const text = recorderErrorText(t, normalizeRecorderError(reason));

    // ① 有话说 —— 这一条是全文件最要紧的：假值 ⇒ 横幅整条不渲染 ⇒ 用户不知道出过事
    assert.notEqual(text.trim(), '', '老 daemon 的帧渲染成了空白 —— 会话死了，界面上一个字都没有');
    assert.equal(text, enAt('recorder.wsError.notReported'));

    // ② 说的是实话：这一版没说是哪一种，而不是替它编一个原因
    assert.equal(CJK.test(text), false, `英文横幅里出现了中文：${text}`);
    /*
     * ③ **不许回落到帧上那句 `messageZh`。** 那正是这次删掉的东西：
     * 只要还有一句中文可以兜底，前端那张总表就永远不会真的拦住谁，
     * 而英文用户读到的仍然是中文。
     */
    assert.equal(text.includes('流式识别引擎不可用'), false, `横幅回落到了帧上那句中文：${text}`);
  });

  it('★ 任何认不出来的东西都收成 not_reported，绝不返回 null / 空白', () => {
    const junk: unknown[] = [
      undefined,
      null,
      '',
      'stream_engine_unavailable', // 字符串，不是对象
      42,
      {},
      { kind: 'something_a_future_daemon_invents' },
      { kind: 42 },
      [],
    ];
    for (const raw of junk) {
      const r = normalizeRecorderError(raw);
      assert.equal(r.kind, 'not_reported', `${JSON.stringify(raw)} 没有收口`);
      assert.notEqual(recorderErrorText(t, r).trim(), '', `${JSON.stringify(raw)} 渲染成了空白`);
    }
  });

  it('★ 认得 kind、但 detail 缺了 —— 保住阶段，别改口说"不知道是哪一种"', () => {
    /*
     * `kind` 回答的是「我录的东西还在不在」（`start_failed` = 一行都没建），
     * 那是用户下一步动作的依据；`detail` 只是给排障用的原文。
     * 整条塌成 `not_reported` 会让界面说出「这一版没说是哪一种」——
     * 而它明明说了，那是我们自己编的一句假话。
     */
    const r = normalizeRecorderError({ kind: 'start_failed' });
    assert.equal(r.kind, 'start_failed');
    const text = recorderErrorText(t, r);
    assert.notEqual(text.trim(), '', 'detail 缺了就整条哑了');
    assert.equal(CJK.test(text), false, text);
    // 阶段那半句还在（取自 en.json，不是我另写的英文）
    const full = enAt(RECORDER_ERROR_KEYS.start_failed);
    const head = full.slice(0, full.indexOf('{{')).trim();
    assert.ok(head.length > 0, '词条里没有 {{detail}} 之外的内容 —— 这条断言本身落空了');
    assert.ok(text.startsWith(head), `阶段那半句丢了：${text}`);
  });
});
