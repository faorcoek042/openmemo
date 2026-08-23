/**
 * ★★ **「卸载成了，但有 N 个文件没删掉」—— 这句话在界面上到底有没有说出来。**
 *
 * ## 它和 `silentFailures.test.tsx` 是同一族，但不是同一条规则
 *
 * 那份守的是「**写操作失败了**，界面必须说话」。这一份守的是它的**第三档**：
 *
 *   > **写操作成功了，但结果和用户以为的不一样 —— 界面同样必须说话。**
 *
 * `795f091` 让两个卸载端点在有拒绝时回 `200 + filesNotRemoved`（干净的那条路仍是 204），
 * **而两个 web 调用方都是 `api<void>(…)`** —— body 被整个丢掉，界面上一个字都没有。
 * 用户点了卸载：卡片消失了，磁盘一个字节没回来，产品从头到尾没提过这件事（#109）。
 * 这不是"失败没说话"，所以上面那份用例一条都抓不到它；它需要自己的腿。
 *
 * ## 🔴 第一条断言钉的是 #107 的教训，不是文案
 *
 * 那一轮的结论写在契约注释里：
 *
 *   > 用户点卸载看到「有 N 个文件没能删」，最自然的解读是「卸载失败了，我再点一次」
 *   > —— 而记录其实已经走了，**再点会拿到 404**。
 *
 * 所以断言不是"横幅出现了"，是**横幅最先说的那一句必须是"记录已经清掉了"**
 * （`said.startsWith(...)`）。一个只说残留、不说卸载已生效的横幅**照样是 bug**，
 * 而"有没有横幅"那种断言看不出这个区别。
 *
 * ## 为什么钉**整句词条**，而不是钉关键词
 *
 * 本仓对关键词判据有过明确结论（见 `silentFailures.test.tsx` 文件头的 B11）：
 * **文案写得越好，关键词判据越判不出来**。所以这里把两份 locale 里那句话
 * 原样读出来、自己做一遍插值，再要求它逐字出现在渲染结果里。
 * 这不是循环论证：期望值来自 **JSON 文件**，被测的是**组件的渲染结果**，
 * 中间隔着"有没有把 `filesNotRemoved` 接出来、参数传没传对、tone 选没选对"这几件事
 * —— 也正是 #109 断掉的那几米。
 *
 * ⚠️ 用中文那一份：宿主把 `openmemo.locale` 钉成了 `zh-CN`（见 `dom-env.ts` 末尾），
 *   所有组件测试都在中文界面上跑。
 *
 * ## ★★ #113：同一条规则的**第二档来源**
 *
 * 那条 200 现在有两个来源，而它们对用户是两件事：
 *
 *   · `filesNotRemoved`      —— 我们**不肯**删（记录越界）。他只能自己去删。
 *   · `filesFailedToRemove`  —— 我们**试了、没删动**（`fs.rm` 抛了）。
 *     这一档**可能会变**：句柄放开了、权限改了就删得掉，
 *     所以它必须把「能做什么」说出口（Windows 上重启一次多半就好）。
 *
 * 于是本文件多出两组判据，缺一条都能被绕过：
 *   ① 第三档那条横幅**说得出三件事**：没删掉 + **在哪儿**（绝对路径）+ 能做什么；
 *   ② **两档不许互相污染** —— 只有拒绝时不许冒出"我们没删动"，
 *      只有失败时不许冒出"记录指向了数据目录之外"（那是一句编出来的成因）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { render, click, stubApi } from './host';
import ModelsPage from '../features/models/ModelsPage';
import RuntimePage from '../features/runtime/RuntimePage';
import zhLocale from '../app/i18n/locales/zh-CN.json';

const UNINSTALL = (zhLocale as unknown as { uninstall: Record<string, string> }).uninstall;
/**
 * ★ #113：三格「删不动」的措辞表，从**产品真正读的那份 JSON** 里取。
 * 三句话必须各不相同 —— 把 `REMOVAL_FAILURE_KEYS` 三格指向同一个词条
 * （一种很自然的"简化"）会让"能做什么"这件事整个消失，而下面的断言正是钉它。
 */
const REMOVAL_FAILURE = (
  zhLocale as unknown as { uninstall: { removalFailure: Record<string, string> } }
).uninstall.removalFailure;

/**
 * 自己做一遍 i18next 的插值。
 *
 * ⚠️ 缺参数时**留着占位符**（不是替成空串）—— 下面有一条断言专门检查渲染结果里
 * 没有 `{{…}}` 残留，而"参数名写错了"正是这一族最常见的半成品：
 * 句子出现了、数字和文件名却还是两个花括号。
 */
function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
}

const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 服务端拒绝删除的那两条 —— **形状照抄 `RefusedFileReport`**。
 *
 * `reason` 用的是 `packages/downloader/src/store.ts` 里 `assertInsideInstallRoots()`
 * 真的会抛出来的那句英文原话（带绝对路径）。契约刻意没有把它收成枚举，
 * 界面必须原样照登 —— 而**那串路径就是"那几个文件在哪儿"唯一的答案**。
 * 两条而不是一条：这样 `{{n}}` 是 2、`{{names}}` 是两个名字用 ', ' 接起来，
 * 一条的话"数错了""没接起来"都看不出来。
 */
const REFUSED = [
  {
    name: 'ggml-tiny-q5_1.bin',
    reason:
      'Legacy installed-file record "/opt/OpenMemo/runtime/probe/ggml-tiny-q5_1.bin" resolves to ' +
      '/opt/OpenMemo/runtime/probe/ggml-tiny-q5_1.bin, which is outside every allowed root ' +
      '(/home/u/.openmemo/models) — refusing to hand out a path we do not own',
  },
  {
    name: 'ggml-tiny-encoder.mlmodelc',
    reason:
      'Unpack directory derived from ggml-tiny-encoder.mlmodelc resolves to ' +
      '/opt/OpenMemo/runtime/probe/ggml-tiny-encoder.mlmodelc, which is outside every allowed ' +
      'root (/home/u/.openmemo/models) — refusing to hand out a path we do not own',
  },
] as const;

const EXPECTED_TITLE = fill(UNINSTALL['recordRemovedFilesKept']!, {
  n: String(REFUSED.length),
  names: REFUSED.map((f) => f.name).join(', '),
});

/**
 * ★ #113：服务端**试着删了、没删动**的那三条 —— 形状照抄 `FailedFileReport`。
 *
 * 🔴 **三条恰好覆盖三格 kind**，这是判据的一部分而不是凑数：
 * 界面按 `Record<RemovalFailureKind, string>` 分档渲染措辞，
 * 只测一格的话「三格全指同一句话」这种退化在断言里看不出来 ——
 * 而那正是"能做什么"这件事被抹掉的方式。
 *
 * `detail` 用的是 Node 在各自 errno 下真会抛的那串（带绝对路径），
 * 契约刻意没有把它收成枚举，界面必须原样照登。
 */
const FAILED = [
  {
    name: 'ggml-cpu.dll',
    path: 'C:\\Users\\u\\.openmemo\\models\\by-name\\backend\\cpu\\ggml-cpu.dll',
    kind: 'in_use',
    detail:
      "EBUSY: resource busy or locked, unlink 'C:\\Users\\u\\.openmemo\\models\\by-name\\backend\\cpu\\ggml-cpu.dll'",
  },
  {
    name: 'whisper-cli',
    path: '/home/u/.openmemo/models/by-name/backend/cpu/whisper-cli',
    kind: 'permission_denied',
    detail:
      "EACCES: permission denied, unlink '/home/u/.openmemo/models/by-name/backend/cpu/whisper-cli'",
  },
  {
    name: 'ggml-tiny-encoder.mlmodelc',
    path: '/home/u/.openmemo/models/by-name/asr/ggml-tiny-encoder.mlmodelc',
    kind: 'unknown',
    detail:
      'Path is a directory: rm returned EISDIR (is a directory) /home/u/.openmemo/models/by-name/asr/ggml-tiny-encoder.mlmodelc',
  },
] as const;

const EXPECTED_FAILED_TITLE = fill(UNINSTALL['recordRemovedFilesFailed']!, {
  n: String(FAILED.length),
  names: FAILED.map((f) => f.name).join(', '),
});

/** 204 —— 全删干净了，客户端拿到的是 `undefined`。 */
const cleanUninstall = (): Response => new Response(null, { status: 204 });

/** 替换 `window.confirm`（jsdom 那个是"未实现"存根，返回 undefined ⇒ 永远不会真的删）。 */
function withConfirm(answer: boolean): () => void {
  const w = window as unknown as { confirm: (m?: string) => boolean };
  const prev = w.confirm;
  w.confirm = () => answer;
  return () => {
    w.confirm = prev;
  };
}

/**
 * 一条横幅要同时说清三件事，**顺序是判据的一部分**。
 * 抽出来是因为两个页面说的必须是同一句话 —— 各写一份断言，两边就会各自漂。
 */
/**
 * 🔴 **那几段原文必须落在一个等宽容器里。**
 *
 * 这一条是**删掉「以下是系统原话，我们没有翻译它：」的前提**，不是装饰。
 *
 * 那句话的职责只有一个：**标出这一段不是我们写的**。它被删掉，是因为这一行
 * 本来就是 `font-mono` 渲染的 —— **形式已经在承担同一个职责**，话是冗余的。
 * 但那个论证只有在容器**真的还在**时才成立：有人顺手把 `font-mono` 摘掉，
 * 屏幕上就只剩一段没有任何标记的机器串冒充产品文案，
 * 而上面所有 `includes(f.reason)` 的断言**照样全绿**。
 *
 * 所以：**删了话，就得钉住形式。** 否则这次改动等于把一个信号净删掉了。
 */
function assertVerbatimIsInMonoContainer(banner: Element, raws: readonly string[]): void {
  const mono = [...banner.querySelectorAll('*')].filter((el) =>
    (el.getAttribute('class') ?? '').split(/\s+/).includes('font-mono'),
  );
  assert.ok(
    mono.length > 0,
    '横幅里一个等宽容器都没有 —— 那几段机器原文现在和我们自己的话长得一模一样。' +
      '「这一段不是产品在说话」原本由那句元说明承担，删掉它的理由就是"形式在承担"，' +
      '形式没了，理由就不成立了。',
  );
  for (const raw of raws) {
    assert.ok(
      mono.some((el) => squash(el.textContent).includes(squash(raw))),
      `这段原文没落在等宽容器里，等于在冒充我们自己的文案：\n  ${raw}`,
    );
  }
}

function assertSaysRecordRemovedButFilesKept(root: Element): void {
  const banner = root.querySelector('[data-testid="uninstall-files-kept"]');
  assert.ok(
    banner,
    '卸载回了 200 + filesNotRemoved，界面上却没有任何东西 —— 这正是 #109：' +
      '服务端算好了"哪几个文件没删掉、它们在哪"，最后一米被丢掉。' +
      `页面全文：${squash(root.textContent)}`,
  );

  const said = squash(banner.textContent);

  /*
   * ① 🔴 **最先读到的那一句必须是"记录已经清掉了"**（#107 的教训）。
   *   只说残留的横幅会把用户推去再点一次 —— 而再点一次拿到的是 404。
   */
  assert.ok(
    said.startsWith(EXPECTED_TITLE),
    '横幅开头那句不是"卸载已生效、记录已清掉" —— 用户会把它读成"卸载失败了，我再点一次"，' +
      `而记录其实已经走了，再点会拿到 404（#107）。\n  期望开头：${EXPECTED_TITLE}\n  实际全文：${said}`,
  );

  // ② 数量与文件名真的被插进去了（`{{n}}` / `{{names}}` 传错名字时句子还在、数字没了）
  for (const f of REFUSED) {
    assert.ok(said.includes(f.name), `没说是哪几个文件（缺 ${f.name}）：${said}`);
  }

  /*
   * ③ **那几个文件在哪儿** —— 只有解析层的英文原话答得出来（它带着绝对路径）。
   *
   * ⚠️ 判据变过一次。这里原来还要求那句「以下是存储层原文，我们没有翻译它：」
   * 逐字出现。那句词条**已删**：这一行本来就是**等宽字体**渲染的，
   * **形式已经在承担"这一段不是我们写的"这个职责**，那句话是纯冗余；
   * 而且它说的是「**我们**没有翻译它」—— 一句关于我们工作流程的陈述。
   *
   * 现在断的是**真正不能丢的那件事**：原文一个字不改地在屏幕上（含绝对路径），
   * 而且它落在一个等宽容器里 —— 后者由下面那条单独断，不靠措辞。
   */
  for (const f of REFUSED) {
    assert.ok(
      said.includes(f.reason),
      `没有原样照登解析层那句话（它是"文件在哪儿"唯一的出处）：\n  缺：${f.reason}\n  实际：${said}`,
    );
  }
  assertVerbatimIsInMonoContainer(
    banner,
    REFUSED.map((f) => f.reason),
  );
  assert.ok(
    said.includes(UNINSTALL['filesKeptHint']!),
    `没说"这里不需要再做什么" —— 那一句是 ① 的兑现方式：${said}`,
  );

  // ④ 插值真的发生了。半成品的形状是"句子在、花括号还在"。
  assert.equal(
    /\{\{\w+\}\}/.test(said),
    false,
    `渲染结果里还留着 {{…}} 占位符 —— 参数名传错了：${said}`,
  );

  /*
   * ⑤ 🔴 **不是错误态。** 卸载**成功了**，只是有残留。
   *   渲染成故障（`ErrorBlock` 是 `role="alert"`；`Banner` 的 critical 档会把
   *   `aria-live` 换成 `assertive`、左边那道色条换成 `border-l-critical`）
   *   会把一次成功说成失败，用户的下一步动作又变回"再点一次"。
   */
  assert.equal(
    banner.getAttribute('role'),
    'status',
    '这条横幅被渲染成了警报（`role="alert"`）—— 卸载是成功的，只有残留',
  );
  assert.equal(
    banner.getAttribute('aria-live'),
    'polite',
    'assertive 是故障级播报 —— tone 被改成 critical 了？卸载并没有失败',
  );
  assert.equal(
    /border-l-(critical|serious)/.test(banner.className),
    false,
    `用了故障级色条：${banner.className}`,
  );
  const inErrorBlock = [...root.querySelectorAll('[data-testid="error-block"]')].some(
    (el) => el.contains(banner) || squash(el.textContent).includes(REFUSED[0].name),
  );
  assert.equal(
    inErrorBlock,
    false,
    '这句话被塞进了错误块里 —— 那需要先编一个 ApiError 出来，而根本没有错误发生',
  );
}

/**
 * ★★ #113：第三档那条横幅要同时说清**三件事**，顺序同样是判据的一部分。
 *
 *   ① 先说「记录已经清掉了」—— 与上面那条一字不差的理由（#107 的教训）；
 *   ② **在哪儿** —— 绝对路径必须逐条出现在屏幕上。这一档的用户动作是他自己去删，
 *      没有路径他无从下手，而这是整条链上唯一的出处；
 *   ③ **能做什么** —— 按 kind 分档的那句话，逐条**逐字**命中两份 locale 里的词条。
 *
 * 🔴 ③ 为什么钉整句而不是关键词：见文件头。这里还多一层 ——
 * 三格 kind 的三句话必须**互不相同**，否则「三格全指同一个词条」这种退化
 * 会让"能做什么"整个消失，而关键词判据看不出这个区别。
 */
function assertSaysRecordRemovedButFilesFailed(root: Element): void {
  const banner = root.querySelector('[data-testid="uninstall-files-failed"]');
  assert.ok(
    banner,
    '卸载回了 200 + filesFailedToRemove，界面上却没有任何东西 —— 这正是 #113 的下半场：' +
      'daemon 好不容易把"哪几个没删动、在哪儿、能做什么"算了出来，最后一米又丢掉。' +
      `页面全文：${squash(root.textContent)}`,
  );

  const said = squash(banner.textContent);

  // ① 最先读到的那一句必须是"卸载已生效、记录已清掉"
  assert.ok(
    said.startsWith(EXPECTED_FAILED_TITLE),
    '横幅开头那句不是"卸载已生效、记录已清掉" —— 用户会把它读成"卸载失败了，我再点一次"，' +
      `而记录其实已经走了，再点会拿到 404（#107）。\n  期望开头：${EXPECTED_FAILED_TITLE}\n  实际全文：${said}`,
  );

  for (const f of FAILED) {
    // ② 名字与**绝对路径**都要在屏幕上
    assert.ok(said.includes(f.name), `没说是哪几个文件（缺 ${f.name}）：${said}`);
    assert.ok(
      said.includes(f.path),
      `没说那个文件在哪儿（缺 ${f.path}）—— 这一档的用户动作是他自己去删，` +
        `没有路径这条横幅就只是在通报一个他做不了任何事的坏消息：${said}`,
    );

    // ③ 那一格的**建议**必须逐字出现（期望值来自产品真正读的 zh-CN.json）
    const advice = fill(REMOVAL_FAILURE[f.kind]!, { name: f.name, path: f.path });
    assert.ok(
      said.includes(advice),
      `kind="${f.kind}" 那一格的措辞没出现在屏幕上 —— 用户拿不到"能做什么"。` +
        `\n  期望：${advice}\n  实际：${said}`,
    );

    /*
     * 系统原话，逐条照登。
     * ⚠️ 同上：不再要求「以下是系统原话，我们没有翻译它：」那句前缀 ——
     * 它已删，职责由等宽字体承担（见下面那条容器断言）。
     */
    assert.ok(
      said.includes(f.detail),
      `没有原样照登系统那句话（unknown 那一档它是唯一说得出的东西）：\n  缺：${f.detail}\n  实际：${said}`,
    );
    assertVerbatimIsInMonoContainer(banner, [f.detail]);
  }

  /*
   * 🔴 三格必须说三句**不一样**的话。把 `REMOVAL_FAILURE_KEYS` 三格指向同一个
   * 词条，上面每一条 `includes` 都还是绿的（同一句话出现三次），
   * 而"能做什么"这件事已经没了。这一条专门堵那一路。
   */
  const advices = new Set(FAILED.map((f) => REMOVAL_FAILURE[f.kind]!));
  assert.equal(
    advices.size,
    FAILED.length,
    `三格 kind 指向的词条只有 ${String(advices.size)} 句不同的话 —— ` +
      '分档塌成了一句，用户不论撞上哪种成因都拿到同一条建议',
  );

  assert.ok(
    said.includes(UNINSTALL['filesFailedHint']!),
    `没说"卸载本身已经生效" —— 那一句是 ① 的兑现方式：${said}`,
  );

  // ④ 插值真的发生了
  assert.equal(
    /\{\{\w+\}\}/.test(said),
    false,
    `渲染结果里还留着 {{…}} 占位符 —— 参数名传错了：${said}`,
  );

  /*
   * ⑤ 🔴 **不是错误态。** 卸载成功了、记录真的走了，只是有几个文件没删动。
   *   渲染成故障会把用户的下一步动作推回"再点一次"（#107 定过的反面）。
   *   这一档"更严重"的那部分由**那句话本身**（重启一次多半就好）承担，不由色条承担。
   */
  assert.equal(banner.getAttribute('role'), 'status', '这条横幅被渲染成了警报');
  assert.equal(banner.getAttribute('aria-live'), 'polite', 'assertive 是故障级播报');
  assert.equal(
    /border-l-(critical|serious)/.test(banner.className),
    false,
    `用了故障级色条：${banner.className}`,
  );
}

/* ══════════════════════════ /models ══════════════════════════ */

const VARIANT_ID = 'asr/dummy-q5';
const DELETE_MODEL = `DELETE /models/${encodeURIComponent(VARIANT_ID)}`;

/**
 * `/models` 四个 query 的最小桩 + 一个**已安装**的变体（不然卡片上是「下载」不是「卸载」）。
 * 形状照 `components.test.tsx` 里那份已经跑通的夹具，只加"已安装"这一件事。
 */
function stubModelsPage(deleteHandler: unknown) {
  const variant = {
    id: VARIANT_ID,
    groupId: 'asr/dummy',
    role: 'asr',
    arch: 'whisper',
    format: 'ggml',
    quantization: 'q5_1',
    speedClass: 'balance',
    languages: ['multi'],
    tags: [],
    totalSizeBytes: 60_000_000,
    catalogVersion: '2026.08.14',
    license: { id: 'MIT', url: 'https://example.invalid', requiresAcceptance: false, gated: false },
    files: [{ name: 'a.bin', sha256: 'x'.repeat(64), sizeBytes: 60_000_000, optional: false }],
    requirements: { ramRequiredMB: 512, vramRequiredMB: 0, computedAtContext: null },
    fitness: {
      tier: 'recommended',
      // 契约里 reasonZh / reasonEn 成对（#106）—— 夹具只写一份就是造一个生产者产不出的形状
      reasonZh: 'dummy reason',
      reasonEn: 'dummy reason',
      notRecommendedForLanguage: false,
      speedTier: 'unknown',
      speedSource: 'none',
      estMinutesPerAudioHour: null,
      estGpuLayers: null,
    },
  };
  const catalog = {
    stale: false,
    fetchedAt: '2026-08-14T00:00:00.000Z',
    groups: [
      {
        groupId: 'asr/dummy',
        role: 'asr',
        displayName: 'Dummy ASR',
        displayNameZh: '假装的转写模型',
        descriptionZh: '一段用来占位的中文描述',
        descriptionEn: 'a stub group',
        // `recommended-default` 让它落进「推荐」那一组（分组规则见 asrSections.ts）
        tags: ['recommended-default'],
        variants: [variant],
      },
    ],
  };
  return stubApi({
    '/models/catalog?role=all&lang=zh': catalog,
    '/models/catalog?role=all&lang=en': catalog,
    '/models/installed': {
      models: [
        {
          id: VARIANT_ID,
          /*
           * ⚠️ `groupId` / `displayName` 不是可有可无的装饰：本页的 `AsrModelPicker`
           * 会拿它们去拼下拉里那一行（`optionLabel()` 在 `quantization` 存在时
           * 直接 `displayName.toLowerCase()`）。少写一个，整页在渲染时就抛，
           * 而这条用例会变成"页面根本没起来"。
           */
          groupId: 'asr/dummy',
          displayName: 'Dummy ASR (Q5_1)',
          role: 'asr',
          arch: 'whisper',
          format: 'ggml',
          quantization: 'q5_1',
          sizeBytes: 60_000_000,
          installedAt: '2026-08-01T00:00:00.000Z',
          verifiedAt: '2026-08-01T00:00:00.000Z',
          integrity: 'ok',
          files: [],
        },
      ],
      active: { asr: null, llm: null },
    },
    '/models/storage': {
      usedBytes: 60_000_000,
      volume: { freeBytes: 1_000_000_000, totalBytes: 2_000_000_000 },
      breakdown: [],
      reclaimable: { orphanBlobsBytes: 0, stalePartialsBytes: 0 },
    },
    '/jobs': { jobs: [] },
    '/settings': { settings: {} },
    '/secrets': { secrets: [], disclosure: null },
    [DELETE_MODEL]: deleteHandler,
  });
}

async function clickModelDelete(r: Awaited<ReturnType<typeof render>>): Promise<void> {
  const btn = r.container.querySelector('[data-testid="model-delete"]');
  assert.ok(
    btn,
    '卡片上没有卸载按钮 —— 夹具没把这个变体标成已安装，后面的断言测的是别的东西。' +
      `页面全文：${squash(r.container.textContent)}`,
  );
  await click(btn);
  await r.flush();
}

describe('#109 /models 卸载：记录清掉了，但有文件留下', () => {
  test('★★ 服务端回 200 + filesNotRemoved ⇒ 界面必须说清"记录已清 + 哪几个没删 + 在哪"', async () => {
    const restore = withConfirm(true);
    const { calls } = stubModelsPage({
      modelId: VARIANT_ID,
      freedBytes: 0,
      filesNotRemoved: REFUSED,
      // #113 之后这一格在契约里是必填的；纯拒绝的那条路上它是空数组
      filesFailedToRemove: [],
    });
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();
      await clickModelDelete(r);

      // 前提先自证：请求真的发出去了（没发出去的话下面断的是"什么都没发生"）
      assert.ok(
        calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/models/')),
        `卸载请求根本没发出去：${JSON.stringify(calls)}`,
      );

      assertSaysRecordRemovedButFilesKept(r.container);
      /*
       * 🔴 **两档不许互相污染。** 这次只有"我们不肯删"，第三档那条横幅
       * 一个字都不该出现 —— 否则用户会去找几个根本没有"删不动"过的文件，
       * 还会收到一条"重启一次试试"的无用建议。
       */
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-failed"]'),
        null,
        '只有越界拒绝，界面却也说了"我们没删动" —— 两档串味了',
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ #113 服务端回 200 + filesFailedToRemove ⇒ 界面必须说清"记录已清 + 哪几个没删动 + 在哪 + 能做什么"', async () => {
    const restore = withConfirm(true);
    const { calls } = stubModelsPage({
      modelId: VARIANT_ID,
      freedBytes: 0,
      // 纯粹的 rm 失败：**没有任何拒绝**。#113 之前这条路根本不存在（回的是 204）
      filesNotRemoved: [],
      filesFailedToRemove: FAILED,
    });
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();
      await clickModelDelete(r);

      assert.ok(
        calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/models/')),
        `卸载请求根本没发出去：${JSON.stringify(calls)}`,
      );

      assertSaysRecordRemovedButFilesFailed(r.container);
      // 反向也要成立：没有拒绝，就不许冒出「记录指向了数据目录之外」那句话
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '一个文件都没被拒绝，界面却说"记录指向了数据目录之外" —— 那是一句凭空造出来的成因',
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ 反面：干净卸载（204）时不许冒出这条横幅', async () => {
    /*
     * 没有这一条，把渲染条件写成恒真也能让上面那条绿 —— 而那会让**每一次**卸载
     * 都对用户说一句"有文件被留下"，比不说更坏。
     */
    const restore = withConfirm(true);
    stubModelsPage(cleanUninstall);
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();
      await clickModelDelete(r);

      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '全都删干净了（204），界面却说有文件被留下 —— 那是凭空造出来的一句假话',
      );
      // #113：第三档那条横幅同样不许出现（否则每一次卸载都会附赠一句"有东西没删动"）
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-failed"]'),
        null,
        '全都删干净了（204），界面却说有文件没删动',
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ 先拒绝、再干净卸载 ⇒ 上一条横幅必须消失（陈旧的它是一句新的假话）', async () => {
    /*
     * 🔴 这一条钉的是"横幅存在哪儿"。用组件自己的 `useState` 存这份结果时，
     * 成功路径上忘了清它，界面就会在一次**干净**卸载之后继续挂着
     * 「有文件被留下」—— 用户会去找几个根本不存在的残留文件。
     * 现在读的是 `del.data`（react-query 一进入 pending 就把它清成 undefined），
     * 但这条断言钉的是**后果**，不是那个实现：换回 state 也照样必须绿。
     */
    const restore = withConfirm(true);
    let nth = 0;
    stubModelsPage(() => {
      nth += 1;
      return nth === 1
        ? { modelId: VARIANT_ID, freedBytes: 0, filesNotRemoved: REFUSED, filesFailedToRemove: [] }
        : cleanUninstall();
    });
    try {
      const r = await render(<ModelsPage />, { route: '/models' });
      await r.flush();

      await clickModelDelete(r);
      assert.ok(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        '第一次（有拒绝）就没出现，这条用例的前提不成立',
      );

      await clickModelDelete(r);
      assert.equal(
        nth,
        2,
        `第二次卸载请求没发出去（发出去 ${String(nth)} 次）—— 那么下面断的是"它自己消失了"`,
      );
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '上一次卸载留下的横幅，在一次干净卸载之后还挂着 —— 这不是"旧信息"，是一句新的假话：' +
          '用户会去盘上找几个已经不存在的残留文件',
      );
      r.unmount();
    } finally {
      restore();
    }
  });
});

/* ══════════════════════════ /runtime ══════════════════════════ */

const PACK_ID = 'ytdlp-linux-x64';

/**
 * `/runtime` 的最小桩。
 *
 * ⚠️ 包故意选 **yt-dlp**：`whisper.cpp` 的 CPU 包是承重墙
 * （`isLoadBearingPack()` ⇒ 卸载按钮 `disabled`），拿它当夹具的话这条用例
 * 会在"按钮点不动"上静默变成什么都没测。
 */
function stubRuntimePage(deleteHandler: unknown) {
  const pack = {
    id: PACK_ID,
    backend: 'cpu',
    engine: 'yt-dlp',
    engineVersion: '2026.07.04',
    os: 'linux',
    arch: 'x64',
    tier: 'downloadable',
    displayName: 'yt-dlp',
    displayNameZh: 'yt-dlp',
    totalSizeBytes: 12_000_000,
    installed: true,
    applicable: true,
    recommended: false,
    priority: 42,
    requiresDriver: null,
    inapplicability: null,
  };
  return stubApi({
    '/runtime/hardware': {
      hardware: {
        detectedAt: '2026-08-14T00:00:00.000Z',
        os: { platform: 'linux', arch: 'x64', version: '6.1' },
        cpu: { brand: 'Stub CPU', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
        ram: { totalMB: 16000, availableMB: 8000 },
        gpus: [],
        selectedGpuIndex: null,
        unifiedMemory: false,
        disks: [{ path: '/tmp/stub', pathFor: 'models_root', freeMB: 10000, totalMB: 50000 }],
        backends: [
          { id: 'cpu', installed: true, available: true, probed: true, unavailableReason: null },
        ],
        selectedBackend: 'cpu',
      },
    },
    '/backends/catalog': { stale: false, packs: [pack] },
    '/backends/installed': { selectedBackend: 'cpu', packs: [{ id: PACK_ID, selfTest: null }] },
    '/jobs': { jobs: [] },
    [`DELETE /backends/${PACK_ID}`]: deleteHandler,
  });
}

async function clickPackRemove(r: Awaited<ReturnType<typeof render>>): Promise<void> {
  const btn = r.container.querySelector(`[data-testid="backend-remove-${PACK_ID}"]`);
  assert.ok(btn, `卡片上没有卸载按钮。页面全文：${squash(r.container.textContent)}`);
  assert.equal(
    (btn as HTMLButtonElement).disabled,
    false,
    '卸载按钮是灰的 —— 这条用例会变成"点了个点不动的按钮"，什么都没测',
  );
  await click(btn);
  await r.flush();
}

describe('#109 /runtime 卸载：同一句话，不许两个页面各说各的', () => {
  test('★★ 后端包卸载回 200 + filesNotRemoved ⇒ 界面必须说同样的三件事', async () => {
    const restore = withConfirm(true);
    const { calls } = stubRuntimePage({
      packId: PACK_ID,
      freedBytes: 0,
      filesNotRemoved: REFUSED,
      filesFailedToRemove: [],
    });
    try {
      const r = await render(<RuntimePage />, { route: '/runtime' });
      await r.flush();
      await clickPackRemove(r);

      assert.ok(
        calls.some((c) => c.method === 'DELETE' && c.path === `/backends/${PACK_ID}`),
        `卸载请求根本没发出去：${JSON.stringify(calls)}`,
      );

      assertSaysRecordRemovedButFilesKept(r.container);
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-failed"]'),
        null,
        '只有越界拒绝，界面却也说了"我们没删动" —— 两档串味了',
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ #113 后端包 rm 失败 ⇒ 界面必须说同样的四件事（后端包那一侧撞上它的机会最大）', async () => {
    /*
     * ⚠️ 这一档在 `/runtime` 上不是理论风险：后端包里的动态库**可能正被推理进程
     * 加载着**，而 Windows 上那就是 `fs.rm` 抛错的头号成因。#113 之前用户在这里
     * 看到的是"卸载了、磁盘没变小、产品一个字没说"。
     */
    const restore = withConfirm(true);
    const { calls } = stubRuntimePage({
      packId: PACK_ID,
      freedBytes: 0,
      filesNotRemoved: [],
      filesFailedToRemove: FAILED,
    });
    try {
      const r = await render(<RuntimePage />, { route: '/runtime' });
      await r.flush();
      await clickPackRemove(r);

      assert.ok(
        calls.some((c) => c.method === 'DELETE' && c.path === `/backends/${PACK_ID}`),
        `卸载请求根本没发出去：${JSON.stringify(calls)}`,
      );

      assertSaysRecordRemovedButFilesFailed(r.container);
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '一个文件都没被拒绝，界面却说"记录指向了数据目录之外"',
      );
      r.unmount();
    } finally {
      restore();
    }
  });

  test('★★ 反面：干净卸载（204）时不许冒出这两条横幅', async () => {
    const restore = withConfirm(true);
    stubRuntimePage(cleanUninstall);
    try {
      const r = await render(<RuntimePage />, { route: '/runtime' });
      await r.flush();
      await clickPackRemove(r);

      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-kept"]'),
        null,
        '全都删干净了（204），界面却说有文件被留下',
      );
      assert.equal(
        r.container.querySelector('[data-testid="uninstall-files-failed"]'),
        null,
        '全都删干净了（204），界面却说有文件没删动',
      );
      r.unmount();
    } finally {
      restore();
    }
  });
});
