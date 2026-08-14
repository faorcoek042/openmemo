/**
 * 「这个 ASR 引擎为什么用不了」—— **英文用户真的读到了什么**（#112 第 8–10 处）。
 *
 * ## 判据为什么落在「渲染出来的那句话」上，而不是「key 存不存在」
 *
 * 这一处的缺陷不是"翻译漏了一条"，而是 `/api/health` 的
 * `pipeline.engines[].reason` **本身就是一句 daemon 拼好的散文**，
 * 被三个渲染点原样插值：录音页的引擎状态条（`AsrEngineStatus`）、
 * 模型页的 `EngineFitChip`、重转弹窗里「上次用的引擎没了」那一行。
 * 而它有**两个产出方，方向相反的两句谎**：
 *
 * ```
 * 英文界面：Sherpa-onnx（未安装流式中文模型 —— 去「模型」页装 …）
 * 中文界面：Sherpa-onnx（the streaming recognition component is not installed (…)）
 * ```
 *
 * 断言"总表里有四个 key"对这个缺陷是**完全空转**的：缺陷版本里那张表压根不存在，
 * 而它存在之后也不保证有人真去用它。所以下面每一条都取**渲染结果**：
 * 非空、无汉字、而且**带数据的那几档真的把数据带上了**。
 *
 * ## 🔴 `normalizeEngineReason` 那两条为什么单独占篇幅
 *
 * 那一格是从网线上来的 JSON —— 编译期对它一无所知。老 daemon（或一次版本错配）
 * 发来的是一句**中文散文字符串**，而这三个渲染点全是
 * `{reason ? `（${text}）` : ''}` 形状：认错了就等于把那句中文又请回英文界面，
 * 认成"有东西但渲染成空串"则会在括号里留下一对空括号。
 * 所以下面钉的是：**认不出 ⇒ `null` ⇒ 那一段整个不出现**。
 *
 * ## 结构那一层没有丢，只是在另一侧
 *
 * 「daemon 交出来的到底是哪一档、里面有没有中文」钉在
 * `apps/daemon/src/pipeline/engineUnavailableReason.test.ts`。两层缺一不可：
 *   · 只留那里 ⇒ 结构对了、界面上却可能是一段空白；
 *   · 只留这里 ⇒ daemon 哪天又往结构字段里塞一句中文，这边照样绿。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EngineUnavailableReason } from '@openmemo/shared';

import en from '../../app/i18n/locales/en.json';
import {
  ENGINE_UNAVAILABLE_KEYS,
  engineUnavailableText,
  normalizeEngineReason,
} from '../../components/common/engineReasonText';

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

/** 每一档带的数据。**互不相同** —— 否则"把数据带上了"分不出真假。 */
const IDS = ['asr/sherpa-streaming-zh-14m', 'asr/paraformer-zh-small'] as const;
const ENV_VAR = 'OPENMEMO_SHERPA_STREAM_DIR';
const DIR = '/opt/models/sherpa-stream';
const PROBE = 'the streaming recognition component is not installed (sherpa-onnx-node: ENOENT)';

/**
 * 每一格的样本。**总 `Record`**：`EngineUnavailableReason` 加一档而这里没有样本，
 * **编译当场就红** —— 新加的那一档不会悄悄地一条断言都没过。
 */
const SAMPLES: Readonly<Record<EngineUnavailableReason['kind'], EngineUnavailableReason>> = {
  model_not_installed: { kind: 'model_not_installed' },
  installed_but_files_incomplete: {
    kind: 'installed_but_files_incomplete',
    installedIds: IDS,
  },
  override_dir_incomplete: { kind: 'override_dir_incomplete', envVar: ENV_VAR, dir: DIR },
  engine_probe_text: { kind: 'engine_probe_text', text: PROBE },
};

describe('#112 第 8–10 处：引擎为什么用不了（英文界面）', () => {
  it('前提检查：这条正则真的抓得到汉字与全角标点（否则下面全是空转）', () => {
    // 逐字就是被删掉的那两句 daemon 原话的片段
    assert.equal(CJK.test('未安装流式中文模型 —— 去「模型」页装'), true);
    assert.equal(CJK.test('，但文件不完整（缺 *.onnx 或 tokens.txt）'), true);
    assert.equal(CJK.test('no model is installed for it - install one on the Models page'), false);
  });

  it('★ 每一档都渲染得出一句非空、不含汉字的英文', () => {
    const kinds = Object.keys(SAMPLES);
    assert.equal(
      kinds.length,
      Object.keys(ENGINE_UNAVAILABLE_KEYS).length,
      '样本数与总表对不上 —— 有一档没被测到',
    );
    assert.equal(kinds.length, 4, '样本少于四档，覆盖不到全部原因');

    for (const kind of kinds) {
      const text = engineUnavailableText(t, SAMPLES[kind as EngineUnavailableReason['kind']]);
      /*
       * 空串在这条链上不是"少一句解释"，是括号里空无一物：
       * 渲染点是 `${LABEL}${reason ? `（${text}）` : ''}` —— 引擎被标成不可用，
       * 而"为什么"是一对空括号，正是这次修复要消灭的那种哑巴状态。
       */
      assert.notEqual(text.trim(), '', `${kind} 渲染成了空白 —— 括号里什么都没有`);
      assert.equal(CJK.test(text), false, `${kind} 的英文里混进了中文：${text}`);
      assert.ok(
        text.length > 20,
        `${kind} 只有 ${String(text.length)} 个字符，不像一句话：${text}`,
      );
    }
  });

  it('★★ 带数据的三档真的把数据带上了（少了它，这句话回答不了"那我该干什么"）', () => {
    const incomplete = engineUnavailableText(t, SAMPLES.installed_but_files_incomplete);
    for (const id of IDS) {
      assert.ok(
        incomplete.includes(id),
        `已装 id 没进这句话 —— 用户不知道该重装哪一个：${incomplete}`,
      );
    }
    assert.ok(
      incomplete.includes(`${IDS[0]}, ${IDS[1]}`),
      `多个 id 要连成一串（', ' 分隔），实际：${incomplete}`,
    );

    const override = engineUnavailableText(t, SAMPLES.override_dir_incomplete);
    assert.ok(override.includes(ENV_VAR), `没说是哪个环境变量指错了：${override}`);
    assert.ok(override.includes(DIR), `没说那个变量指向了哪里：${override}`);

    const probe = engineUnavailableText(t, SAMPLES.engine_probe_text);
    assert.ok(probe.includes(PROBE), `引擎原话被弄丢了 —— 排障时唯一的线索：${probe}`);
    /*
     * 而且原话**不是**这句话的全部：词条自己要说清"这一段是原文、没翻译"。
     * 只发原话等于把一段没有 i18n 的字符串当成产品文案
     * （同 `UpstreamFailure.upstream_error_text` 那条纪律）。
     */
    assert.ok(probe.length > PROBE.length + 20, `除了原话什么都没说：${probe}`);
  });

  it('★ 「没装」与「装了但不全」必须是**两句不同的话**（合并 = 叫人再装一遍他装过的）', () => {
    const notInstalled = engineUnavailableText(t, SAMPLES.model_not_installed);
    const incomplete = engineUnavailableText(t, SAMPLES.installed_but_files_incomplete);
    assert.notEqual(
      notInstalled,
      incomplete,
      '两档说了同一句话 —— 那这两档在界面上就是同一个东西，分开也白分',
    );
  });

  it('★ 总表里每个 key 都真的指到一条 en.json 词条', () => {
    for (const [kind, key] of Object.entries(ENGINE_UNAVAILABLE_KEYS)) {
      assert.notEqual(enAt(key).trim(), '', `${kind} 的词条 ${key} 是空的`);
    }
  });

  it('★★ daemon 真的发过来的那份 JSON，收窄之后逐字段还原', () => {
    /*
     * 走 `JSON.parse` 而不是写对象字面量：这就是 `useAsrEngines()` 手里那个东西
     * （`api<DaemonStatus>('health', …)` 的返回值），**没有任何类型在守它**。
     * 形状照 `apps/daemon/src/main.ts` 的 `engines:` 那一段。
     */
    const payload: unknown = JSON.parse(
      '{"engines":[' +
        '{"id":"sherpa-onnx","available":false,"reason":{"kind":"model_not_installed"}},' +
        '{"id":"paraformer","available":false,"reason":' +
        '{"kind":"installed_but_files_incomplete","installedIds":["asr/paraformer-zh-small"]}},' +
        '{"id":"whisper.cpp","available":false,"reason":' +
        '{"kind":"engine_probe_text","text":"whisper-cli not found on PATH"}}]}',
    );
    const engines = (payload as { engines: { reason?: unknown }[] }).engines;
    const got = engines.map((e) => normalizeEngineReason(e.reason));

    assert.deepEqual(got, [
      { kind: 'model_not_installed' },
      { kind: 'installed_but_files_incomplete', installedIds: ['asr/paraformer-zh-small'] },
      { kind: 'engine_probe_text', text: 'whisper-cli not found on PATH' },
    ]);
    // 而且每一条都真的渲染得出话来（收窄对了、渲染却哑了，用户看到的仍然是空括号）
    for (const r of got) {
      assert.ok(r, '收窄把 daemon 真的发过来的东西判成了认不出');
      assert.notEqual(engineUnavailableText(t, r).trim(), '');
    }
  });

  it('🔴★★ 认不出来的东西一律 `null` —— 尤其是老 daemon 那句中文散文', () => {
    /*
     * 老 daemon（本次修复之前）在这一格发的**就是**下面第一条：一句中文。
     * 它绝不许被包成 `engine_probe_text` 之类"看起来能渲染"的东西 ——
     * 那等于在英文界面上重新开一条中文回落路径，而那正是 #112 要堵的洞
     * （同 #106 把 `messageZh` 从帧上删掉那一手：留着回落，总表就形同虚设）。
     */
    const junk: unknown[] = [
      '未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M”',
      'the streaming recognition component is not installed',
      undefined,
      null,
      '',
      42,
      {},
      [],
      { kind: 'something_a_future_daemon_invents' },
      { kind: 42 },
      // 认得 kind、但结构化字段缺了/类型不对 ⇒ 这句话说不完整，不许半截上屏
      { kind: 'installed_but_files_incomplete' },
      { kind: 'installed_but_files_incomplete', installedIds: 'asr/paraformer-zh-small' },
      { kind: 'override_dir_incomplete', envVar: 'OPENMEMO_PARAFORMER_DIR' },
      { kind: 'override_dir_incomplete', envVar: 'OPENMEMO_PARAFORMER_DIR', dir: 7 },
      { kind: 'engine_probe_text' },
      { kind: 'engine_probe_text', text: '' },
    ];
    for (const raw of junk) {
      assert.equal(
        normalizeEngineReason(raw),
        null,
        `${JSON.stringify(raw) ?? String(raw)} 没有被判成"认不出" —— ` +
          '渲染点是 `reason ? `（…）` : ""`，认成"有东西"就会上屏',
      );
    }
  });

  it('★ `installedIds` 是空数组时仍然收得下（少列几个名字，句子照样成立）', () => {
    /*
     * 与上一条的分界线：**结构对但内容空** ≠ **结构不对**。
     * 判成 `null` 会让一台"装了但装坏了"的机器退回一句话都没有，
     * 而这一档最要紧的那半句（"你装的那个不全，重装它"）与 id 列表无关。
     */
    const r = normalizeEngineReason({ kind: 'installed_but_files_incomplete', installedIds: [] });
    assert.ok(r, '结构对、只是列表为空，不该被判成"认不出"');
    assert.deepEqual(r, { kind: 'installed_but_files_incomplete', installedIds: [] });
    assert.notEqual(engineUnavailableText(t, r).trim(), '');
  });
});
