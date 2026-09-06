#!/usr/bin/env node
/**
 * `e2e-notes-assertions.mjs` 的**变异证明** —— 本机能跑，不需要 daemon、不需要包、
 * 不需要 GitHub。几十毫秒。
 *
 * ## 这份文件为什么存在
 *
 * 因为 notes 那条腿曾是 CI 守卫层里倒数第二条没有判据模块、也没有自检的腿
 * （⚠️ 这里原来写的是「**最后一条**」—— 那句话在写下的当天为真，现在不再成立：
 *   `e2e-import-audit.mjs` 也补上了这一对。留着它会让下一个人以为已经收工）：
 *
 * | 腿 | 抽出的判据模块 | 自检 |
 * |---|---|---|
 * | runtime | `e2e-runtime-assertions.mjs` | `selftest-e2e-runtime.mjs` |
 * | browser | `e2e-browser-assertions.mjs` | `selftest-e2e-browser.mjs` |
 * | record  | `e2e-record-assertions.mjs`  | `selftest-e2e-record.mjs` |
 * | **notes** | **（本轮补上）** | **（本轮补上）** |
 *
 * 而"没有判据模块"不是风格问题，是**结构上不可测**：`e2e-notes-audit.mjs`
 * 顶层执行、结尾 `process.exit()` ⇒ import 不进来 ⇒ **它那 115 处内联断言
 * 一条都没法被喂输入**。runtime 腿正是这样让一条判据烂了三周
 * （`/先安装 CPU/` 那条正则，产品改了一次文案它就再也没匹配过任何东西，
 * 而它看起来仍然像一条护栏）。
 *
 * ## 每条判据过五关
 *
 *   ① **好输入必须判绿** —— 挡"恒红"。一条恒红的判据和一条恒绿的判据
 *      在门禁上的价值完全相同，都是零；恒红的还更快被人学会无视。
 *   ② **每一条腿各有一个坏输入，必须判红** —— 挡"恒绿"。
 *      判据里 5 个格子只喂 1 个坏输入，只能证明其中 1 格有牙齿；
 *      **抽掉任意一格修法，这一组都要红。**
 *   ③ ★ **把判据在内存里退化，看它是不是真的还抓得住** ——
 *      把"修法抽掉之后的那一版"原样写在这里、喂同样的坏输入，
 *      要求**退化版放过、现行版抓住**。②只证明现行版会红，
 *      ③才证明它红的**是真东西**而不是运气。
 *   ④ **契约漂移守卫** —— `.mjs` 拿不到 TS 的类型检查，所以这里对着产品源码
 *      正面核那些字面量（错误码、content-type、selfcheck 的探针 id、
 *      prompt 的编号格式）。少了它，判据会静默退回"恒不触发"或"恒红"。
 *   ⑤ **已登记的三条空转有名有姓的桩** —— 抽的过程中发现的三处
 *      「把修法抽掉它也不红」。判据**没有动**（这一轮是让它可测，不是改它判什么），
 *      但缺口在这里有一条会说话的记录：**修好的那天这几条会红**，
 *      逼出一次显式的"删掉这个桩 + 更新报告"，而不是让缺口悄悄消失或悄悄留着。
 *
 * 用法：`node scripts/ci/selftest-e2e-notes.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHINESE_SEARCH_CHECK_ID,
  ERROR_CODES,
  EXPORT_EXPECTATIONS,
  TOKENIZERS,
  TOOL_CHECK_PREFIX,
  brief,
  checkAbsentFromList,
  checkAppShell,
  checkChineseSearchFindsSample,
  checkDeletedNoteWritesRejected,
  checkDeletionInvisible,
  checkExportEnvelope,
  checkExportableBeforeDelete,
  checkFolderCreated,
  checkFolderFilter,
  checkLlmEndpointCalled,
  checkMindmapEditPersisted,
  checkMindmapJobSucceeded,
  checkMindmapProvenance,
  checkNoTimestamp,
  checkNoteCreated,
  checkNoteGone,
  checkOffsetBeyondTotal,
  checkRefQuoteVerbatim,
  checkRefTimestamps,
  checkRejection,
  checkSearchModes,
  checkSearchablePremise,
  checkSegmentHit,
  checkSeekWithinDuration,
  checkSettingsRoundTrip,
  checkSilentDegradation,
  checkStarApplied,
  checkStarredIsFilter,
  checkStarredPagination,
  checkTimestampFidelity,
  checkTitleRoundTrip,
  checkTokenizerDegraded,
  checkTokenizerSelfReport,
  checkToolProbesUsable,
  checkTopicRefPresent,
  checkUnknownDurationIsZero,
  classifyToolChecks,
  nodesWithNonce,
  parseOutlineIndices,
  uidsOfNotePage,
} from './e2e-notes-assertions.mjs';
/*
 * ★ 只取那份**记录**，不跑那个工具 —— 逐格重扫要几十秒，而门禁要的是快速判决。
 *   `leg-coverage.mjs` 刻意不挂进 `test:ci-scripts`（它的名字不以 `selftest-` 开头，
 *   所以 T-163 的全集扫描不会要求它接链）。见那份文件头「为什么它不是门禁」。
 */
import { SUBSUMED_LEGS } from './leg-coverage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
const ok = (name) => {
  cases += 1;
  say(`  ✔ ${name}`);
};
/**
 * 一条失败的**结构化**记录。`kind` 是给 `leg-coverage.mjs` 分档用的 ——
 * 它此前靠匹配报错文本里的中文来认「红的只是记录守卫」，那是在读散文。
 */
const failed = [];
const bad = (name, why, kind = 'assertion') => {
  cases += 1;
  failures += 1;
  failed.push({ name, kind });
  say(`  ✘ ${name}\n      ${why}`);
};

/* ══════════════════════════════════════════════════════════════════════════ */
/* 夹具 —— 形状照真实响应逐格来（都是 `[实测]` 那条腿跑出来的样子）              */
/* ══════════════════════════════════════════════════════════════════════════ */

const NONCE = 'E2EMM0123ABCDEF';
const PROVIDER = 'ci_fake_openai';
const BASE_URL = 'http://127.0.0.1:19961/v1';
const TR_UID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const NOTE_UID = '01J8AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_UID = '01J8BBBBBBBBBBBBBBBBBBBBBB';
const THIRD_UID = '01J8CCCCCCCCCCCCCCCCCCCCCC';
const TS_MS = 754321;
const TS_TEXT = '12:34';
const CN_WORDS = ['会议', '纪要', '预算', '客户'];

/** 一段真转写稿的样子（jfk.wav 用 whisper-tiny 只转出 1 段，所以这里也少）。 */
const SEGMENTS = [
  { seq: 0, startMs: 0, endMs: 4300, text: 'And so my fellow Americans' },
  { seq: 1, startMs: 4300, endMs: 9100, text: 'ask not what your country can do for you' },
];

/** 导图节点：一个根、一个带 nonce 的主题、一个要点。 */
const NODES = [
  { text: '会议纪要', refs: [] },
  {
    text: `会议主题 ${NONCE}`,
    refs: [
      { transcriptUid: TR_UID, startMs: 4300, endMs: 9100, quote: 'ask not what your country' },
    ],
  },
  { text: `要点 ${NONCE}`, refs: [] },
];
const TOPIC_NODE = NODES[1];

const searchResp = (hits, extra = {}) => ({
  status: 200,
  body: { hits, modes: { tokenizer: 'simple', keyword: true }, ...extra },
});
const hitOf = (uid) => ({ noteUid: uid, source: 'note', startMs: null });
const cnAllFound = Object.fromEntries(CN_WORDS.map((w) => [w, searchResp([hitOf(NOTE_UID)])]));
/** 没装 libsimple 时的现场：HTTP 200、0 条、**一个错都不报**。 */
const cnAllSilentZero = Object.fromEntries(
  CN_WORDS.map((w) => [w, { status: 200, body: { hits: [], modes: { tokenizer: 'trigram' } } }]),
);

const notePage = (uids, extra = {}) => ({
  status: 200,
  body: { notes: uids.map((u) => ({ uid: u })), total: uids.length, hasMore: false, ...extra },
});

/** 星标分页的真实现场：56 条里 53 条加星 ⇒ 50 + 3，最早那条在第 2 页。 */
const STARRED = Array.from({ length: 53 }, (_, i) => `01J8S${String(i).padStart(21, '0')}`);
const OLDEST_STARRED = STARRED[STARRED.length - 1]; // created_at DESC ⇒ 最早的排最后
const PAGES_GOOD = [
  notePage(STARRED.slice(0, 50), { total: 53, hasMore: true }),
  notePage(STARRED.slice(50), { total: 53, hasMore: false }),
];

const toolChecks = [
  { id: 'tool.ffmpeg', status: 'ok', detail: '/root/.local/share/openmemo/models/…/ffmpeg' },
  {
    id: 'tool.ffprobe',
    status: 'warn',
    detail: '/usr/bin/ffprobe（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）',
  },
  { id: 'tool.whisperCli', status: 'fail', detail: '未找到' },
  { id: 'db.schema', status: 'ok', detail: 'v42' },
];

const selfcheckChecks = [
  { id: CHINESE_SEARCH_CHECK_ID, status: 'ok', detail: '四个探针词全部命中' },
  ...toolChecks,
];

/* ══════════════════════════════════════════════════════════════════════════ */
/* ①② 表：好输入判绿 + **每条腿**各一个坏输入判红                              */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每个条目 = 一条判据。`bad[]` 里每一条对应它内部的**一格**修法：
 * 把那一格从 `e2e-notes-assertions.mjs` 里删掉，这里对应的那条就会由红转绿 ⇒ 自检红。
 *
 * ⚠️ `bad` 的第二项是**打在 `good` 上的浅补丁**（顶层键），不是完整输入 ——
 * 这样"只有这一格坏了"是看得出来的，而不是每条都重抄一遍整份夹具
 * （重抄的那种写法里，一条被抄错了没人看得出来）。
 */
const SUITES = [
  {
    name: 'checkSettingsRoundTrip（provider 配置真的落到 daemon 那边）',
    fn: checkSettingsRoundTrip,
    good: {
      status: 200,
      settings: { 'llm.defaultProviderId': PROVIDER, [`llm.baseUrl.${PROVIDER}`]: BASE_URL },
      providerId: PROVIDER,
      baseUrl: BASE_URL,
    },
    bad: [
      ['PATCH 没回 200', { status: 500 }],
      ['回读不到 defaultProviderId（只回了 200，没落库）', { settings: {} }],
      [
        '☑ 独占：baseUrl 落了、defaultProviderId 没落 —— 只有那一格会响',
        { settings: { [`llm.baseUrl.${PROVIDER}`]: BASE_URL } },
      ],
      [
        'baseUrl 回读成了别的地址（配到了别人家的端点）',
        {
          settings: {
            'llm.defaultProviderId': PROVIDER,
            [`llm.baseUrl.${PROVIDER}`]: 'https://api.deepseek.com/v1',
          },
        },
      ],
    ],
  },
  {
    name: 'checkMindmapJobSucceeded（导图 job 真的成了）',
    fn: checkMindmapJobSucceeded,
    good: {
      postStatus: 202,
      jobUid: '01J8JJJJJJJJJJJJJJJJJJJJJJ',
      jobState: { state: 'succeeded' },
    },
    bad: [
      ['POST 没回 202', { postStatus: 500 }],
      ['没拿到 jobUid', { jobUid: undefined }],
      ['jobUid 是空串', { jobUid: '' }],
      [
        '★ job 被 blocked（没有转写稿）—— 前置没跑，不是 F4 坏了，但同样是红',
        { jobState: { state: 'blocked', blockedCode: 'NO_TRANSCRIPT', note: 'blocked' } },
      ],
      ['job failed', { jobState: { state: 'failed', error: 'llm timeout', note: 'failed' } }],
      ['job 超时没到终态', { jobState: { state: 'TIMEOUT', note: '300s 内没到终态' } }],
    ],
  },
  {
    name: 'checkLlmEndpointCalled（产品真去打了那个端点，不是凭空造图）',
    fn: checkLlmEndpointCalled,
    good: { chatCalls: 2, calls: [{ url: '/v1/chat/completions' }] },
    bad: [
      [
        '★ 一次真请求都没有（只有 /models + 能力探测）—— 那张图不是这个端点给的',
        { chatCalls: 0, calls: [{ url: '/v1/models' }, { url: '/v1/chat/completions' }] },
      ],
    ],
  },
  {
    name: 'checkMindmapProvenance（GET 回来的图带 llm 出处 + 节点里有 nonce）',
    fn: checkMindmapProvenance,
    good: {
      status: 200,
      generatedBy: `llm:${PROVIDER}`,
      nodes: NODES,
      nonce: NONCE,
      providerId: PROVIDER,
    },
    bad: [
      ['GET 没回 200', { status: 404 }],
      ['★ generatedBy 说是用户写的（图不是那条链生成的）', { generatedBy: 'user' }],
      ['generatedBy 指向另一个 provider', { generatedBy: 'llm:someone_else' }],
      [
        '★★ 节点里一个 nonce 都没有 —— 产品凭空造了一张图',
        { nodes: [{ text: '会议纪要' }, { text: '第一个主题' }] },
      ],
      ['一个节点都没有（空图也算生成成功？）', { nodes: [] }],
    ],
  },
  {
    name: 'checkTopicRefPresent（那个带 refs 的主题节点在，且期望值算得出来）',
    fn: checkTopicRefPresent,
    good: {
      node: TOPIC_NODE,
      label: `会议主题 ${NONCE}`,
      nodeTexts: NODES.map((n) => n.text),
      expectedSeg: SEGMENTS[1],
      expectedIdx: 1,
    },
    bad: [
      ['找不到那个节点', { node: undefined }],
      ['节点在但没有 refs', { node: { text: `会议主题 ${NONCE}` } }],
      ['节点在但 refs 是空数组', { node: { text: `会议主题 ${NONCE}`, refs: [] } }],
      [
        '★ 我回给产品的编号在转写稿里不存在 ⇒ 期望值算不出来，前提不成立当场红（本腿不留第三态）',
        { expectedSeg: undefined, expectedIdx: 99 },
      ],
    ],
  },
  {
    name: 'checkRefTimestamps（时间戳 = 从转写稿独立算出来的真值）',
    fn: checkRefTimestamps,
    good: { ref: TOPIC_NODE.refs[0], seg: SEGMENTS[1] },
    bad: [
      [
        '★★ 变异证明用的那个：段落整体平移 1 秒',
        { seg: { startMs: SEGMENTS[1].startMs + 1000, endMs: SEGMENTS[1].endMs + 1000 } },
      ],
      ['★ 产品把主题指到了隔壁段落（循环论证的那一版会放它过去）', { seg: SEGMENTS[0] }],
      ['只有 startMs 对，endMs 错', { seg: { startMs: 4300, endMs: 999999 } }],
      ['ref 里根本没有 startMs', { ref: { endMs: 9100 } }],
    ],
  },
  {
    name: 'checkRefQuoteVerbatim（quote 是原文逐字 + 指向对的转写稿）',
    fn: checkRefQuoteVerbatim,
    good: { ref: TOPIC_NODE.refs[0], segments: SEGMENTS, transcriptUid: TR_UID },
    bad: [
      [
        '★ quote 是模型改写过的句子（重转写之后这条 ref 永久失效）',
        {
          ref: {
            ...TOPIC_NODE.refs[0],
            quote: '不要问国家能为你做什么，这是一句被改写过的中文',
          },
        },
      ],
      [
        '★ ref 指向另一份转写稿',
        { ref: { ...TOPIC_NODE.refs[0], transcriptUid: '01J8XXXXXXXXXXXXXXXXXXXXXX' } },
      ],
      ['转写稿是空的（对不出原文）', { segments: [] }],
      [
        '☑ 独占 / ✅ #90 的 ⑤-b：quote 是空串 —— `joined.includes("")` 恒真，从前这里是绿的',
        { ref: { ...TOPIC_NODE.refs[0], quote: '' } },
      ],
      [
        '☑ 独占：quote 全是空白（trim 之后还是空）—— 同一条空转的另一张脸',
        { ref: { ...TOPIC_NODE.refs[0], quote: '   \n\t ' } },
      ],
      [
        '☑ 独占：产品干脆不发 quote 这个字段（`String(undefined ?? "")` 也是空串）',
        { ref: { transcriptUid: TR_UID, startMs: 4300, endMs: 9100 } },
      ],
    ],
  },
  {
    name: 'checkMindmapEditPersisted（PATCH 真落库、revision 真前进、出处转 user）',
    fn: checkMindmapEditPersisted,
    good: {
      patchStatus: 200,
      patchRevision: 3,
      patchMindmapUid: '01J8MMMMMMMMMMMMMMMMMMMMMM',
      revisionBefore: 2,
      rereadStatus: 200,
      rootText: `会议纪要 已编辑${NONCE}`,
      editMark: `已编辑${NONCE}`,
      generatedBy: 'user',
    },
    bad: [
      ['PATCH 没回 200', { patchStatus: 409 }],
      ['★ revision 没前进（乐观锁失去依据）', { patchRevision: 2 }],
      ['revision 倒退', { patchRevision: 1 }],
      ['没有 mindmapUid', { patchMindmapUid: undefined }],
      ['回读没回 200', { rereadStatus: 500 }],
      ['★ 编辑没落库（只回了 200）', { rootText: '会议纪要' }],
      [
        '★ generatedBy 还是 llm —— 下一次"重新生成"会不声不响覆盖用户的编辑',
        { generatedBy: `llm:${PROVIDER}` },
      ],
    ],
  },
  {
    name: 'checkRejection（该拒的请求被按设计拒掉了：状态码 + 错误码）',
    fn: checkRejection,
    good: {
      status: 400,
      body: { error: { code: ERROR_CODES.invalidMindmap } },
      expectStatus: 400,
      expectCode: ERROR_CODES.invalidMindmap,
      label: '非法 doc 的 PATCH',
    },
    bad: [
      ['★ 照收了（校验是摆设）', { status: 200, body: {} }],
      [
        '★ 换了个码 —— 400 是对的但语义不是"这份 doc 非法"',
        { body: { error: { code: 'BAD_QUERY_PARAM' } } },
      ],
      ['没有 error 那一格', { body: {} }],
      ['500 而不是 400（拒是拒了，但那是崩了不是校验）', { status: 500 }],
    ],
  },
  {
    name: 'checkExportEnvelope（200 + content-type 正确 + 正文里有 nonce）',
    fn: checkExportEnvelope,
    good: {
      fmt: 'md',
      status: 200,
      contentType: EXPORT_EXPECTATIONS.md.ct,
      body: `# 会议纪要\n- 会议主题 ${NONCE} [${TS_TEXT}]\n`,
      nonce: NONCE,
    },
    bad: [
      ['★ 判据自己没覆盖这个格式（表漂了）', { fmt: 'pdf' }],
      ['没回 200', { status: 404 }],
      [
        '★ content-type 回落成 text/plain —— 浏览器不会当成下载',
        { contentType: 'text/plain; charset=utf-8' },
      ],
      ['正文是空的', { body: '' }],
      ['★★ 只回了一个骨架、一个节点都没写（前四格全能满足）', { body: '# \n' }],
      [
        '☑ 独占：nonce 生成那一步自己坏了（空串）⇒ nonce 那一格恒真，只剩"正文是空的"在守',
        { body: '', nonce: '' },
      ],
    ],
  },
  {
    name: 'checkNoTimestamp（这份导出里没有时间戳 —— 缺席检测本身要有区分力）',
    fn: checkNoTimestamp,
    good: {
      body: '<opml><outline text="会议主题"/></opml>',
      label: 'opml',
      timecode: TS_TEXT,
      ms: TS_MS,
    },
    bad: [
      [
        '★★ 变异证明用的那个：把它拿去量 md（md 里确实有 [12:34]）',
        { body: `- 主题 [${TS_TEXT}]`, label: 'md' },
      ],
      ['毫秒原值漏进了 opml', { body: `<outline start="${TS_MS}"/>` }],
    ],
  },
  {
    name: 'checkTimestampFidelity（时间戳只有 md 与 json 带得走）',
    fn: checkTimestampFidelity,
    good: {
      bodies: {
        md: `- 会议主题 ${NONCE} [${TS_TEXT}]`,
        opml: `<opml><outline text="会议主题 ${NONCE}"/></opml>`,
        mm: `<map><node TEXT="会议主题 ${NONCE}"/></map>`,
        json: `{"refs":[{"startMs":${TS_MS}}]}`,
      },
      timecode: TS_TEXT,
      ms: TS_MS,
    },
    bad: [
      [
        '★ md 里的时间戳没了（导出对用户失去意义，而只查"opml/mm 没有"的判据会放它过去）',
        {
          bodies: {
            md: `- 会议主题 ${NONCE}`,
            opml: '<opml/>',
            mm: '<map/>',
            json: `{"refs":[{"startMs":${TS_MS}}]}`,
          },
        },
      ],
      [
        '★ json 里的 startMs 没了',
        {
          bodies: {
            md: `- 会议主题 ${NONCE} [${TS_TEXT}]`,
            opml: '<opml/>',
            mm: '<map/>',
            json: '{"refs":[{}]}',
          },
        },
      ],
      [
        '★ 时间戳漏进了 opml（界面上那句"导出损耗"说明成了假话）',
        {
          bodies: {
            md: `- [${TS_TEXT}]`,
            opml: `<outline start="${TS_MS}"/>`,
            mm: '<map/>',
            json: `{"startMs":${TS_MS}}`,
          },
        },
      ],
      [
        '★ 时间戳漏进了 mm',
        {
          bodies: {
            md: `- [${TS_TEXT}]`,
            opml: '<opml/>',
            mm: `<node TEXT="[${TS_TEXT}]"/>`,
            json: `{"startMs":${TS_MS}}`,
          },
        },
      ],
      [
        '☑ 独占：有人把表改成四格全 ts:false ⇒ 正向那一半成了关于空集的废话',
        {
          bodies: { md: '- 主题', opml: '<opml/>', mm: '<map/>', json: '{}' },
          table: Object.fromEntries(
            Object.entries(EXPORT_EXPECTATIONS).map(([f, s]) => [f, { ...s, ts: false }]),
          ),
        },
      ],
      [
        '☑ 独占：反过来，四格全 ts:true ⇒ 缺席那一半成了废话',
        {
          bodies: {
            md: `[${TS_TEXT}]`,
            opml: String(TS_MS),
            mm: String(TS_MS),
            json: String(TS_MS),
          },
          table: Object.fromEntries(
            Object.entries(EXPORT_EXPECTATIONS).map(([f, s]) => [
              f,
              { ...s, ts: true, mark: s.mark ?? ((_t, ms) => String(ms)) },
            ]),
          ),
        },
      ],
    ],
  },
  {
    name: 'checkNoteCreated（import 真的建出一条笔记）',
    fn: checkNoteCreated,
    good: { status: 202, noteUid: NOTE_UID },
    bad: [
      ['没回 202', { status: 500 }],
      ['没有 noteUid', { noteUid: undefined }],
      ['★ uid 不是 26 位 ULID（回了个自增 id / 截断了）', { noteUid: '42' }],
    ],
  },
  {
    name: 'checkTitleRoundTrip（PATCH 改标题 → GET 读得回来）',
    fn: checkTitleRoundTrip,
    good: { patchStatus: 200, getStatus: 200, title: '改过的标题', expectTitle: '改过的标题' },
    bad: [
      ['PATCH 没回 200', { patchStatus: 404 }],
      ['GET 没回 200', { getStatus: 404 }],
      ['★ 回了 200 但标题没变（只改了内存）', { title: '原来的标题' }],
    ],
  },
  {
    name: 'checkStarApplied（PUT /star 生效：回执与回读都说 true）',
    fn: checkStarApplied,
    good: { putStatus: 200, putStarred: true, rereadStarred: true },
    bad: [
      ['PUT 没回 200', { putStatus: 404 }],
      ['回执说没加上', { putStarred: false }],
      ['★ 回执说加上了，回读却是 false（只回了句好听的）', { rereadStarred: false }],
    ],
  },
  {
    name: 'checkSearchablePremise（★ 非空虚前提：删之前搜得到）',
    fn: checkSearchablePremise,
    good: { hits: [hitOf(NOTE_UID), hitOf(OTHER_UID)], noteUid: NOTE_UID },
    bad: [
      ['★★ 删之前就搜不到 ⇒ "删完搜不到"是句恒真的废话', { hits: [] }],
      ['搜到的全是别人的笔记', { hits: [hitOf(OTHER_UID)] }],
    ],
  },
  {
    name: 'checkDeletionInvisible（删完：列表里没有了、搜索也搜不到了）',
    fn: checkDeletionInvisible,
    good: {
      deleteStatus: 200,
      deleteOk: true,
      listUids: [OTHER_UID],
      afterHits: [],
      noteUid: NOTE_UID,
    },
    bad: [
      ['DELETE 没回 200', { deleteStatus: 500 }],
      ['回执的 ok 不是 true', { deleteOk: false }],
      ['★ 删完还在列表里', { listUids: [OTHER_UID, NOTE_UID] }],
      [
        '★★ 列表里没了、FTS 索引里还在（只删了一半，只查列表的判据会放它过去）',
        { afterHits: [hitOf(NOTE_UID)] },
      ],
    ],
  },
  {
    name: 'checkNoteGone（软删之后 GET 回 404 NOTE_NOT_FOUND）',
    fn: checkNoteGone,
    good: { status: 404, body: { error: { code: ERROR_CODES.noteNotFound } } },
    bad: [
      [
        '★★ 变异证明用的那个：拿一条活着的笔记来量（200）',
        { status: 200, body: { uid: NOTE_UID } },
      ],
      [
        '★ 裁决是 404 不是 410（410 隐含"永久移除"，会让"可恢复"在协议层说不通）',
        { status: 410, body: { error: { code: ERROR_CODES.noteNotFound } } },
      ],
      [
        '404 了但码不对 —— "不存在"和"没权限"不是一回事',
        { body: { error: { code: 'FORBIDDEN' } } },
      ],
      ['404 了但没有 error 那一格', { body: {} }],
    ],
  },
  {
    name: 'checkDeletedNoteWritesRejected（写路径同样 404，且导出那格的码对得上）',
    fn: checkDeletedNoteWritesRejected,
    good: {
      patchStatus: 404,
      starStatus: 404,
      exportStatus: 404,
      exportBody: { error: { code: ERROR_CODES.noteNotFound } },
    },
    bad: [
      ['★★ 已删除的笔记还能被继续编辑', { patchStatus: 200 }],
      ['★ 已删除的笔记还能被打星标', { starStatus: 200 }],
      ['已删除的笔记还能被导出', { exportStatus: 200 }],
      [
        '☑ 独占 / ✅ #90 的 ⑤-a：404 的理由是「这条笔记没有导图」而不是「这条笔记不存在」——' +
          ' 软删守卫被抽掉时就长这样，从前这里是绿的',
        { exportBody: { error: { code: ERROR_CODES.noMindmap } } },
      ],
      ['☑ 独占：导出 404 了但连 error 那一格都没有', { exportBody: {} }],
    ],
  },
  {
    name: 'checkExportableBeforeDelete（★ 非空虚前提：删之前这条笔记真的有导图）',
    fn: checkExportableBeforeDelete,
    good: {
      status: 200,
      contentType: EXPORT_EXPECTATIONS.md.ct,
      body: `# 会议纪要\n- 会议主题 ${NONCE}\n`,
    },
    bad: [
      [
        '★★ 夹具那一半悄悄失败了：这条笔记根本没有导图 ⇒ F5-a6 的错误码那格会恒红，' +
          '把"夹具没造出来"报成"产品退化了"',
        { status: 404 },
      ],
      ['content-type 不对（导出的不是 md）', { contentType: 'application/json; charset=utf-8' }],
      ['★ 回了 200 但正文是空的 —— 这份导图是个空壳', { body: '' }],
    ],
  },
  {
    name: 'checkAbsentFromList（这条笔记不在这份结果里）',
    fn: checkAbsentFromList,
    good: { page: notePage([NOTE_UID]), uid: OTHER_UID, label: '文件夹外那条' },
    bad: [
      [
        '★★ 变异证明用的那个：拿它去量**在**结果里的那一条',
        { uid: NOTE_UID, label: '文件夹内那条' },
      ],
    ],
  },
  {
    name: 'checkFolderCreated（POST /api/folders 真建出来了）',
    fn: checkFolderCreated,
    good: { status: 201, folderUid: '01J8FFFFFFFFFFFFFFFFFFFFFF' },
    bad: [
      ['没回 201', { status: 200 }],
      ['没有 uid', { folderUid: undefined }],
      ['uid 是空串', { folderUid: '' }],
    ],
  },
  {
    name: 'checkFolderFilter（?folder= 只返回该文件夹里的笔记）',
    fn: checkFolderFilter,
    good: {
      page: notePage([NOTE_UID], { total: 1 }),
      insiderUid: NOTE_UID,
      outsiderUid: OTHER_UID,
      expectTotal: 1,
    },
    bad: [
      ['筛出来的没回 200', { page: { status: 400, body: {} } }],
      [
        '☑ 独占：内容全对、只有状态码不是 200',
        { page: { status: 400, body: { notes: [{ uid: NOTE_UID }], total: 1 } } },
      ],
      ['★ 文件夹里那条没被筛出来（PUT /folder 没生效）', { page: notePage([], { total: 0 }) }],
      [
        '☑ 独占：筛出来的是**另一条**笔记（total 也对得上）—— 只有"里面那条在"会响',
        { page: notePage([THIRD_UID], { total: 1 }) },
      ],
      [
        '★★ folder 参数被整个忽略、返回全部（"静默回落到全部"）',
        { page: notePage([NOTE_UID, OTHER_UID], { total: 2 }) },
      ],
      [
        '☑ 独占：文件夹外那条混了进来，而 total 跟着一起说了谎（2/2 自洽）',
        { page: notePage([NOTE_UID, OTHER_UID], { total: 2 }), expectTotal: 2 },
      ],
      [
        '★ 列表对了但 total 说了另一个数（分页会据此翻错页数）',
        { page: notePage([NOTE_UID], { total: 7 }) },
      ],
    ],
  },
  {
    name: 'checkStarredPagination（★ 星标分页真的跨过了第 50 条，且一条都不少）',
    fn: checkStarredPagination,
    good: { pages: PAGES_GOOD, pageSize: 50, oldestStarredUid: OLDEST_STARRED },
    bad: [
      ['一页都没翻到', { pages: [] }],
      [
        '第 2 页 500 了（只看第一页的判据不知道）',
        { pages: [PAGES_GOOD[0], { status: 500, body: {} }] },
      ],
      [
        '☑ 独占：第 2 页正文全对、只有状态码是 500',
        {
          pages: [
            PAGES_GOOD[0],
            {
              status: 500,
              body: {
                notes: STARRED.slice(50).map((u) => ({ uid: u })),
                total: 53,
                hasMore: false,
              },
            },
          ],
        },
      ],
      [
        '★★ 非空虚前提：数据没超过一页 ⇒ 这条边界根本没跑到，下面几格全是废话',
        {
          pages: [notePage(STARRED.slice(0, 3), { total: 3, hasMore: false })],
          oldestStarredUid: STARRED[2],
        },
      ],
      [
        '☑ 独占：total 恰好等于一页（50，不是 > 50）—— 边界仍然没跨过，别的格全自洽',
        {
          pages: [
            notePage(STARRED.slice(0, 50), { total: 50, hasMore: true }),
            notePage([], { total: 50, hasMore: false }),
          ],
          oldestStarredUid: STARRED[49],
        },
      ],
      [
        '★ 第 1 页没满页（limit 被谁改小了）',
        {
          pages: [
            notePage(STARRED.slice(0, 7), { total: 53, hasMore: true }),
            notePage(STARRED.slice(7), { total: 53, hasMore: false }),
          ],
        },
      ],
      [
        '★ 第 1 页 hasMore 说没有了（翻页会在这儿停住，后面 3 条永远看不到）',
        {
          pages: [notePage(STARRED.slice(0, 50), { total: 53, hasMore: false }), PAGES_GOOD[1]],
        },
      ],
      [
        '★★ 事故原形：只翻出一页，第 50 条之后的星标笔记静默消失',
        { pages: [notePage(STARRED.slice(0, 50), { total: 53, hasMore: false })] },
      ],
      [
        '★★ 有笔记被静默吞掉：两页并起来 52 条，total 说 53',
        {
          pages: [
            notePage(STARRED.slice(0, 50), { total: 53, hasMore: true }),
            notePage(STARRED.slice(50, 52), { total: 53, hasMore: false }),
          ],
        },
      ],
      [
        '★★ 最早那条被换成了重复的一条：条数对得上、人却少了一个',
        {
          pages: [
            notePage(STARRED.slice(0, 50), { total: 53, hasMore: true }),
            notePage([...STARRED.slice(50, 52), STARRED[0]], { total: 53, hasMore: false }),
          ],
        },
      ],
      [
        '☑ 独占：total 说 54 而并起来只有 53 —— 有一条从来没出现在任何一页上',
        {
          pages: [
            notePage(STARRED.slice(0, 50), { total: 54, hasMore: true }),
            notePage(STARRED.slice(50), { total: 54, hasMore: false }),
          ],
        },
      ],
      [
        '☑ 独占：条数对得上（53=53），但最早那条被换成了一个新 uid —— 只有"含最早那条"会响',
        {
          pages: [
            notePage(STARRED.slice(0, 50), { total: 53, hasMore: true }),
            notePage([...STARRED.slice(50, 52), THIRD_UID], { total: 53, hasMore: false }),
          ],
        },
      ],
      [
        '★ 最后一页 hasMore 仍然是 true（翻页永远停不下来）',
        {
          pages: [PAGES_GOOD[0], notePage(STARRED.slice(50), { total: 53, hasMore: true })],
        },
      ],
    ],
  },
  {
    name: 'checkStarredIsFilter（starred 筛的是"筛"）',
    fn: checkStarredIsFilter,
    good: { totalAll: 60, totalStarred: 53, minUnstarred: 3 },
    bad: [
      ['★★ 把全部都返回了（根本没筛）', { totalStarred: 60 }],
      ['筛出来的比全量还多', { totalStarred: 61 }],
      [
        '★ 非空虚前提：没加星的不足 3 条 ⇒ 这一轮证不出"筛"在起作用',
        { totalAll: 54, totalStarred: 53 },
      ],
      ['total 不是数字（字段名漂了，读到 undefined）', { totalAll: undefined }],
      ['starred total 不是数字', { totalStarred: undefined }],
    ],
  },
  {
    name: 'checkOffsetBeyondTotal（offset 越界回空页，不报错也不绕回第一页）',
    fn: checkOffsetBeyondTotal,
    good: { status: 200, notes: [], hasMore: false },
    bad: [
      ['★ 越界 offset 报错了', { status: 500 }],
      ['★★ 绕回了第一页（用户以为到底了，其实在原地打转）', { notes: [{ uid: NOTE_UID }] }],
      ['空页却说 hasMore=true（翻页永远停不下来）', { hasMore: true }],
    ],
  },
  {
    name: 'checkChineseSearchFindsSample（★★ 四个中文两字词都搜得到本次样本）',
    fn: checkChineseSearchFindsSample,
    good: { responses: cnAllFound, words: CN_WORDS, noteUid: NOTE_UID },
    bad: [
      ['一个词都没给 ⇒ 关于空集的废话', { words: [] }],
      ['没有样本 uid', { noteUid: '' }],
      [
        '★★ 那个静默：没有 libsimple ⇒ HTTP 200 + 0 条，一个错都不报',
        { responses: cnAllSilentZero },
      ],
      [
        '★ 只有一个词搜不到（分词器对某些两字词退化）',
        { responses: { ...cnAllFound, 客户: searchResp([]) } },
      ],
      [
        '★ 搜到了，但命中的是别人的笔记（"什么都返回"的搜索会满足只数条数的判据）',
        { responses: Object.fromEntries(CN_WORDS.map((w) => [w, searchResp([hitOf(OTHER_UID)])])) },
      ],
      [
        '☑ 独占：样本 uid 是空串，而 hit 的 noteUid 恰好也是空 ⇒ 下面那格恒真，只剩前提在守',
        {
          noteUid: '',
          responses: Object.fromEntries(CN_WORDS.map((w) => [w, searchResp([hitOf('')])])),
        },
      ],
      ['搜索直接报错', { responses: { ...cnAllFound, 会议: { status: 500, body: {} } } }],
    ],
  },
  {
    name: 'checkSearchModes（/api/search 自报的分词器档位）',
    fn: checkSearchModes,
    good: {
      modes: { tokenizer: 'simple', keyword: true },
      expectTokenizer: 'simple',
      requireKeyword: true,
    },
    bad: [
      [
        '★ 判据自己写错了期望值（不在契约的两格里）⇒ 它会恒红，这里当场拦住',
        { expectTokenizer: 'Simple' },
      ],
      [
        '☑ 独占：产品与判据一起漂到了契约外的同一个值（两边"一致"，但契约里没有这一格）',
        { modes: { tokenizer: 'Simple', keyword: true }, expectTokenizer: 'Simple' },
      ],
      ['★★ 退回 trigram 了', { modes: { tokenizer: 'trigram', keyword: true } }],
      [
        '★★ 键名漂回旧的 chineseTokenizer ⇒ 读到 undefined（T-200 A-2 那次）',
        { modes: { chineseTokenizer: true, keyword: true } },
      ],
      ['关键词检索那一格关了', { modes: { tokenizer: 'simple', keyword: false } }],
    ],
  },
  {
    name: 'checkTokenizerSelfReport（health 与 selfcheck 也说是 simple）',
    fn: checkTokenizerSelfReport,
    good: {
      healthExtensions: { tokenizer: 'simple', libsimple: true, sqliteVec: true },
      selfcheckChecks,
      expectTokenizer: 'simple',
    },
    bad: [
      [
        '★ health 说 trigram（search 说 simple，两处口径不一致 —— 其中一处漂了）',
        { healthExtensions: { tokenizer: 'trigram', libsimple: true } },
      ],
      ['libsimple 没加载', { healthExtensions: { tokenizer: 'simple', libsimple: false } }],
      [
        `★★ selfcheck 里 ${CHINESE_SEARCH_CHECK_ID} 那一项不见了 —— **判据本身没了**`,
        { selfcheckChecks: toolChecks },
      ],
      [
        '★ 探针在，但它自己是红的',
        {
          selfcheckChecks: [
            { id: CHINESE_SEARCH_CHECK_ID, status: 'fail', detail: '四个词全 0 条' },
            ...toolChecks,
          ],
        },
      ],
      ['一条自检项都没有', { selfcheckChecks: [] }],
    ],
  },
  {
    name: 'checkTokenizerDegraded（变异实例确实退化了 —— 变异体本身成立）',
    fn: checkTokenizerDegraded,
    good: { extensions: { libsimple: false, tokenizer: 'trigram' } },
    bad: [
      [
        '★★ 变异实例其实**没有**退化（OPENMEMO_EXT_DIR 没生效）⇒ 第 13 节什么都没证明',
        { extensions: { libsimple: true, tokenizer: 'simple' } },
      ],
      [
        'libsimple 说没了、分词器却还是 simple（自相矛盾）',
        { extensions: { libsimple: false, tokenizer: 'simple' } },
      ],
      [
        '☑ 独占：分词器确实退成了 trigram，但 libsimple 还说自己在（这一格自己在守）',
        { extensions: { libsimple: true, tokenizer: 'trigram' } },
      ],
    ],
  },
  {
    name: 'checkSilentDegradation（那个静默：200 + 一个错都不报）',
    fn: checkSilentDegradation,
    good: { responses: cnAllSilentZero, words: CN_WORDS },
    bad: [
      ['一个词都没给 ⇒ 关于空集的废话', { words: [] }],
      [
        '★ 产品改成明确报错了 —— 这条会红，那时该改的是这条判据（缺陷不再静默是好事）',
        {
          responses: {
            ...cnAllSilentZero,
            会议: { status: 200, body: { hits: [], error: { code: 'TOKENIZER_DEGRADED' } } },
          },
        },
      ],
      [
        '搜索直接 500 —— 那也不是"静默"',
        { responses: { ...cnAllSilentZero, 纪要: { status: 500, body: {} } } },
      ],
    ],
  },
  {
    name: 'checkSegmentHit（segment 命中带得回可用的 startMs）',
    fn: checkSegmentHit,
    good: {
      probeWord: 'fellow',
      hit: { source: 'segment', noteUid: NOTE_UID, startMs: 4300, seq: 1, transcriptUid: TR_UID },
      hits: [],
    },
    bad: [
      ['★ 转写稿里挑不出探针词（夹具前提没造出来 ⇒ 本腿口径是当场判红）', { probeWord: '' }],
      ['没有 source=segment 的命中', { hit: undefined }],
      [
        '★★ startMs 是字符串（前端 parseSeekParam 会静默取到 NaN，表现成"点进去没跳"）',
        { hit: { startMs: '4300', transcriptUid: TR_UID } },
      ],
      ['startMs 是浮点', { hit: { startMs: 4300.5, transcriptUid: TR_UID } }],
      ['startMs 是负数', { hit: { startMs: -1, transcriptUid: TR_UID } }],
      ['segment 命中没有 transcriptUid', { hit: { startMs: 4300 } }],
    ],
  },
  {
    name: 'checkSeekWithinDuration（startMs 不超过这条笔记的 durationMs）',
    fn: checkSeekWithinDuration,
    good: { hit: { startMs: 4300 }, durationMs: 11000 },
    bad: [
      [
        '★★ 非空虚前提：durationMs=0 ⇒ parseSeekParam 明写此时不夹取，这条判据无从谈起',
        { durationMs: 0 },
      ],
      ['durationMs 是负数', { durationMs: -1 }],
      [
        '☑ 独占：durationMs=0 且命中就在 0ms（0<=0 成立）⇒ 只有那条非空虚前提会响',
        { durationMs: 0, hit: { startMs: 0 } },
      ],
      ['没有 segment 命中', { hit: null }],
      ['★ 命中的 startMs 超出了时长（点进去会被夹到末尾）', { hit: { startMs: 99999 } }],
    ],
  },
  {
    name: 'checkUnknownDurationIsZero（时长未知时如实回 0，不编一个数）',
    fn: checkUnknownDurationIsZero,
    good: { status: 200, durationMs: 0 },
    bad: [
      ['GET 没回 200', { status: 404 }],
      ['★ 编了一个非零上界（会把对的 ?t= 夹坏）', { durationMs: 1 }],
      ['编了一个像模像样的时长', { durationMs: 180000 }],
    ],
  },
  {
    name: 'checkAppShell（深链在包里真的可达 —— 拿到的是应用外壳）',
    fn: checkAppShell,
    good: {
      status: 200,
      html: '<!doctype html><div id="root"></div><script src="/a.js"></script>',
    },
    bad: [
      [
        '★★ 变异证明用的那个：非导航请求打同一条深链，拿到 404',
        { status: 404, html: '{"error":{"code":"NOT_FOUND"}}' },
      ],
      ['★ 回了 200，但正文不是应用外壳（"什么路径都回 200"的兜底）', { html: 'Not Found' }],
      [
        '☑ 独占：正文确实是应用外壳，但状态码是 404（比如 SPA 兜底带错了码）',
        { status: 404, html: '<div id="root"></div>' },
      ],
      ['正文是空的', { html: '' }],
    ],
  },
  {
    name: 'checkToolProbesUsable（★ 空集守卫：selfcheck 里必须真有 tool.*）',
    fn: checkToolProbesUsable,
    good: { status: 200, checks: selfcheckChecks },
    bad: [
      ['★★ 自检取不回来 ⇒ 「借了宿主 0 个」会被当成一条发现报出去', { status: 500, checks: [] }],
      ['★ 200 了但一条 tool.* 都没有（前缀漂了）', { checks: [{ id: 'db.schema', status: 'ok' }] }],
      ['一条自检项都没有', { checks: [] }],
    ],
  },
];

/* ══════════════════════════════════════════════════════════════════════════ */
say('── ① 好输入必须判绿（挡"恒红" —— 一条恒红的门两周内就会被所有人学会无视）');

for (const s of SUITES) {
  const r = s.fn(s.good);
  if (r.ok) ok(`${s.name} → 判绿`);
  else bad(`${s.name} 的好输入应当判绿`, `判据把一个合法现场判红了：${r.reason}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ② 每一条腿各一个坏输入，必须判红（抽掉任意一格修法，这一组当场红）');

assert.ok(
  SUITES.length >= 30,
  `判据少于 30 条（实际 ${SUITES.length}）—— 要么抽漏了，要么有人成批删了。` +
    '这条地板只防塌方：扫不到东西的自检，失效的样子和"全都过了"一模一样。',
);
for (const s of SUITES) {
  assert.ok(
    s.bad.length >= 1,
    `${s.name} 一个坏输入都没有 —— 只跑好输入的自检证明不了任何东西（恒真的函数也能过）`,
  );
  for (const [why, patch] of s.bad) {
    const r = s.fn({ ...s.good, ...patch });
    if (r.ok) bad(`${s.name}「${why}」应当判红`, '判据放它过去了 —— 这条绕过法此刻是活的');
    else ok(`${s.name}「${why}」→ 判红`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ②-bis 「删了也绿」那 7 格的登记还对得上吗（`leg-coverage.mjs` 的门禁那一半）');

/*
 * ②只保证「每条判据至少有一个坏输入」。更强的那个问题是「**判据里的每一格**
 * 是不是都有一个只有它会响的输入」——把那一格删掉，②还红不红？
 *
 * 那个问题由 `scripts/ci/leg-coverage.mjs` 回答（手动跑，几十秒，逐格删了再跑本文件）。
 * `[实测 2026-09-06]` 99 格 → **91 格有专属坏输入**（上面打 `☑ 独占` 的那些就是为补齐
 * 它们加的：第一次扫 94 格里有 22 格没有）；剩 7 格删掉之后自检**照样绿** ——
 * 因为②表里每个坏输入都会被**相邻那一格先判红**，没有用例专门盯着它们。
 * 它们不是空转（缺陷仍会被相邻那格抓住），是**数学上被吞掉**，
 * 理由逐条记在 `SUBSUMED_LEGS` 里。另有 1 格删掉就 TypeError，判不了。
 *
 * ★ 这一段是那个工具的**门禁那一半**，秒级：`SUBSUMED_LEGS` 里每条 `needle`
 *   必须在判据源码里**恰好出现一次**。
 *
 * ⚠️ 为什么非要有这一段：#90 里那个扫描器是跑完就删的临时脚本，只在文件头留了
 * 一句"复现命令"。**这个仓已经证明过"下一个人记得读文件头"不成立** ——
 * 那 22 格就是这么长出来的。所以这份记录不靠人记得回来重跑：
 * 有人动了这 7 格里的任何一格，这里当场红，把他领到 `leg-coverage.mjs` 跟前。
 *
 * ⚠️ 它**不是豁免名单**。名单里记的不是"这几格不用管"，是"这几格为什么被吞掉"，
 * 而且每一条都是**可核对的事实**（源码里恰好一处）。
 */
{
  const src = readFileSync(join(REPO, 'scripts', 'ci', 'e2e-notes-assertions.mjs'), 'utf8');
  assert.ok(
    SUBSUMED_LEGS.length >= 5,
    `SUBSUMED_LEGS 只剩 ${SUBSUMED_LEGS.length} 条 —— 少于 5 条时多半是这份记录被清空了，` +
      '而它被清空的样子和"全都补上专属坏输入了"一模一样。真补齐了请连这条地板一起改。',
  );
  for (const leg of SUBSUMED_LEGS) {
    const hits = src.split(leg.needle).length - 1;
    if (hits === 1) {
      ok(
        `「${leg.needle.slice(0, 44)}…」在判据源码里恰好一处（被吞掉的理由：${leg.why.slice(0, 40)}…）`,
      );
    } else {
      bad(
        `SUBSUMED_LEGS 对不上判据源码：\`${leg.needle.slice(0, 60)}\``,
        `源码里 ${hits} 处（期望恰好 1 处）—— 这一格被改/删/复制了。\n` +
          `      它原本是「删了也绿」的 7 格之一，理由是：${leg.why}\n` +
          '      请重跑 `node scripts/ci/leg-coverage.mjs`，并更新 SUBSUMED_LEGS。',
        /*
         * ★ `kind` 是给 `leg-coverage.mjs` 分档的**结构信号**：这条红来自
         *   **记录守卫**（它正在逐格删格子，所以这条必然响），不是来自任何一个坏输入。
         *   它此前靠匹配上面那句中文来认，`[实测]` 因此把一格误记过。
         */
        'subsumed-record',
      );
    }
  }
  // 前提检查：拿一个必不存在的 needle 过一遍，证明上面那组不是恒真
  if (src.includes(`must(definitely_not_a_real_leg_${Date.now()})`))
    bad('②-bis 的前提检查', '不可能的 needle 竟然命中了 —— 这组守卫是恒真的');
  else ok('②-bis 的前提检查：不存在的 needle 确实匹配不到（上面那组不是恒真）');
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ③ ★ 把判据在内存里退化 —— 退化版必须放过②抓住的那些（否则②红得是运气）');

/*
 * ②只证明「现行判据对这些输入会红」。它证不了「现行判据比退化版更强」——
 * 一个 `() => ({ok:false})` 也能让②全绿。所以这里把**修法抽掉之后的那一版**
 * 原样写出来，喂同样的坏输入：**退化版必须放它过去**。
 * 两条一起才说明现行判据抓到的是真东西。
 */
function degraded(name, weakFn, strongFn, input, why) {
  const weak = weakFn(input);
  const strong = strongFn(input);
  if (!strong.ok && weak.ok) {
    ok(`★ ${name}：退化版放过、现行版抓住 —— ${why}`);
  } else if (strong.ok) {
    bad(`★ ${name}`, `**现行判据自己就放过去了**：这一格今天是空转的。${why}`);
  } else {
    bad(
      `★ ${name}`,
      `退化版也把它判红了 —— 说明我抄的"退化版"不是真的退化版，这条对照什么都没证明`,
    );
  }
}

/* ── ③-a 星标分页：退化成「只看第一页」（就是那个事故本身） ─────────────────── */
const paginationOnlyFirstPage = ({ pages, pageSize }) => {
  const p1 = pages?.[0];
  if (p1?.status !== 200) return { ok: false, reason: '第 1 页没回 200' };
  return (p1.body?.notes ?? []).length === pageSize
    ? { ok: true, reason: '第 1 页满页' }
    : { ok: false, reason: '第 1 页没满页' };
};
degraded(
  'checkStarredPagination',
  paginationOnlyFirstPage,
  checkStarredPagination,
  {
    pages: [notePage(STARRED.slice(0, 50), { total: 53, hasMore: false })],
    pageSize: 50,
    oldestStarredUid: OLDEST_STARRED,
  },
  '「只翻出一页、最早那条星标笔记从此看不见」正是 limit 先切 / starred 后筛那个事故',
);
degraded(
  'checkStarredPagination（吞掉一条）',
  paginationOnlyFirstPage,
  checkStarredPagination,
  {
    pages: [
      notePage(STARRED.slice(0, 50), { total: 53, hasMore: true }),
      notePage(STARRED.slice(50, 52), { total: 53, hasMore: false }),
    ],
    pageSize: 50,
    oldestStarredUid: OLDEST_STARRED,
  },
  '两页并起来 52 条而 total 说 53 —— 有一条被静默吞掉了，只看第一页永远发现不了',
);

/* ── ③-b 删除：退化成「只查列表」 ───────────────────────────────────────────── */
const deletionListOnly = ({ deleteStatus, listUids, noteUid }) =>
  deleteStatus === 200 && !(listUids ?? []).includes(noteUid)
    ? { ok: true, reason: '不在列表里' }
    : { ok: false, reason: '还在列表里' };
degraded(
  'checkDeletionInvisible',
  deletionListOnly,
  checkDeletionInvisible,
  {
    deleteStatus: 200,
    deleteOk: true,
    listUids: [OTHER_UID],
    afterHits: [hitOf(NOTE_UID)],
    noteUid: NOTE_UID,
  },
  '列表里没了、FTS 索引里还在 —— 用户从搜索点进去会看到一条"已删除"的笔记',
);

/* ── ③-c 时间戳：退化成「只查 md/json 有」 ─────────────────────────────────── */
const fidelityForwardOnly = ({ bodies, timecode, ms }) =>
  String(bodies?.md ?? '').includes(`[${timecode}]`) &&
  String(bodies?.json ?? '').includes(String(ms))
    ? { ok: true, reason: 'md/json 都带上了' }
    : { ok: false, reason: 'md/json 少了一个' };
degraded(
  'checkTimestampFidelity',
  fidelityForwardOnly,
  checkTimestampFidelity,
  {
    bodies: {
      md: `- [${TS_TEXT}]`,
      opml: `<outline start="${TS_MS}"/>`,
      mm: '<map/>',
      json: `{"startMs":${TS_MS}}`,
    },
    timecode: TS_TEXT,
    ms: TS_MS,
  },
  '时间戳漏进了 opml —— 界面上那句"导出损耗"说明成了假话，而只查正向的判据看不见',
);

/* ── ③-d 中文检索：退化成「HTTP 200 就算过」 ───────────────────────────────── */
const cnStatusOnly = ({ responses, words }) => {
  for (const w of words ?? []) {
    if ((responses ?? {})[w]?.status !== 200) return { ok: false, reason: `q=${w} 没回 200` };
  }
  return { ok: true, reason: '四个词全是 200' };
};
degraded(
  'checkChineseSearchFindsSample',
  cnStatusOnly,
  checkChineseSearchFindsSample,
  { responses: cnAllSilentZero, words: CN_WORDS, noteUid: NOTE_UID },
  '★★ 没装 libsimple 时中文两字词**静默返回 0 条且不报错** —— 只看状态码的判据永远发现不了',
);
degraded(
  'checkChineseSearchFindsSample（命中的是别人）',
  ({ responses, words }) => {
    for (const w of words ?? []) {
      if (((responses ?? {})[w]?.body?.hits ?? []).length === 0)
        return { ok: false, reason: `q=${w} 一条都没命中` };
    }
    return { ok: true, reason: '四个词都命中了东西' };
  },
  checkChineseSearchFindsSample,
  {
    responses: Object.fromEntries(CN_WORDS.map((w) => [w, searchResp([hitOf(OTHER_UID)])])),
    words: CN_WORDS,
    noteUid: NOTE_UID,
  },
  '只数"命中了几条"的判据，会被一个"什么都返回"的搜索满足',
);

/* ── ③-e 导图出处：退化成「有节点就算生成成功」 ────────────────────────────── */
const provenanceNodeCountOnly = ({ status, nodes }) =>
  status === 200 && (nodes ?? []).length > 0
    ? { ok: true, reason: '有节点' }
    : { ok: false, reason: '没有节点' };
degraded(
  'checkMindmapProvenance',
  provenanceNodeCountOnly,
  checkMindmapProvenance,
  {
    status: 200,
    generatedBy: `llm:${PROVIDER}`,
    nodes: [{ text: '会议纪要' }, { text: '第一个主题' }, { text: '第二个主题' }],
    nonce: NONCE,
    providerId: PROVIDER,
  },
  '产品凭空造了一张图 —— nonce 不在，而只数节点个数的判据数得很欢',
);

/* ── ③-f 时间戳真值：退化成「在转写稿里找得到一个相等的段落就算过」 ────────── */
const refTimestampCircular = ({ ref }) => {
  const hit = SEGMENTS.some((s) => Number(s.startMs) === Number(ref?.startMs));
  return hit
    ? { ok: true, reason: '这个 startMs 确实是某个真实段落的起点' }
    : { ok: false, reason: '不是任何段落的起点' };
};
degraded(
  'checkRefTimestamps',
  refTimestampCircular,
  checkRefTimestamps,
  { ref: { startMs: SEGMENTS[0].startMs, endMs: SEGMENTS[0].endMs }, seg: SEGMENTS[1] },
  '★ 循环论证的那一版：产品把主题指到了**隔壁段落**，而那个值确实是某个真实段落的起点',
);

/* ── ③-g 深链：退化成「回了 200 就算可达」 ─────────────────────────────────── */
degraded(
  'checkAppShell',
  ({ status }) =>
    status === 200 ? { ok: true, reason: '200' } : { ok: false, reason: '不是 200' },
  checkAppShell,
  { status: 200, html: 'Not Found' },
  '"任何无扩展名路径都回 200"的兜底会把本该 404 的东西变成 200 —— 只看状态码的判据看不见',
);

/* ── ③-h ✅ #90 的 ⑤-a：退化成「只钉状态码，不看错误码」 ────────────────────── */
const deletedWritesStatusOnly = ({ patchStatus, starStatus, exportStatus }) =>
  patchStatus === 404 && starStatus === 404 && exportStatus === 404
    ? { ok: true, reason: '三条写路径全是 404' }
    : { ok: false, reason: '有一条不是 404' };
degraded(
  'checkDeletedNoteWritesRejected',
  deletedWritesStatusOnly,
  checkDeletedNoteWritesRejected,
  {
    patchStatus: 404,
    starStatus: 404,
    exportStatus: 404,
    exportBody: { error: { code: ERROR_CODES.noMindmap } },
  },
  `★ 软删守卫被从导出路由抽掉 ⇒ 404 的理由变成「这条笔记没有导图」（${ERROR_CODES.noMindmap}）——` +
    ' 只钉状态码的那一版正是 #90 抓到的那条空转',
);

/* ── ③-i ✅ #90 的 ⑤-b：退化成「只做 includes，不问 quote 空不空」 ──────────── */
const quoteIncludesOnly = ({ ref, segments, transcriptUid }) => {
  const joined = (segments ?? []).map((s) => String(s?.text ?? '').trim()).join(' ');
  const quote = String(ref?.quote ?? '').trim();
  if (!joined.includes(quote.slice(0, 60))) return { ok: false, reason: 'quote 不是原文逐字' };
  return String(ref?.transcriptUid) === String(transcriptUid)
    ? { ok: true, reason: 'quote 对得上' }
    : { ok: false, reason: 'transcriptUid 不对' };
};
degraded(
  'checkRefQuoteVerbatim',
  quoteIncludesOnly,
  checkRefQuoteVerbatim,
  { ref: { ...TOPIC_NODE.refs[0], quote: '' }, segments: SEGMENTS, transcriptUid: TR_UID },
  '★ `joined.includes("")` 在 JS 里**恒真** —— 一条 quote 为空的 ref 重转写之后永久失效，' +
    '而退化版对它一个字都不说',
);

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ④ 契约漂移守卫：判据里的字面量必须真的还在产品源码里');

/*
 * `.mjs` 拿不到 TS 的类型检查 ⇒ 判据里那些字面量与契约之间**没有任何东西在守**。
 * 改名之后：错误码那几条会退化成**恒红**（产品发的是新码），
 * `ext.chineseSearch` 那条会退化成**恒红**（`find` 永远找不到），
 * content-type 那四条会退化成恒红。恒红的门等于没有门。
 *
 * ⚠️ 每一组后面都跟一条**前提检查**：拿一个必不存在的字面量过一遍，
 * 证明这条守卫不是恒真的（本仓在 `RemovalFailureKind` 那条上就是这么钉的）。
 */
function pinLiteral(label, src, needle, notNeedle) {
  if (src.includes(needle)) ok(`${label}：源码里找得到 \`${needle}\``);
  else
    bad(
      `${label}：源码里应当找得到 \`${needle}\``,
      '契约那侧改名/删掉了，而判据里的字面量没跟上 —— 它会静默退化成恒红或恒不触发',
    );
  if (src.includes(notNeedle))
    bad(`${label} 的前提检查`, '不可能的字面量竟然命中了 —— 这条守卫是恒真的');
  else ok(`${label} 的前提检查：不存在的字面量确实匹配不到（上一条不是恒真）`);
}

{
  const contentTs = readFileSync(
    join(REPO, 'apps', 'daemon', 'src', 'http', 'rest', 'content.ts'),
    'utf8',
  );
  const notesTs = readFileSync(
    join(REPO, 'apps', 'daemon', 'src', 'http', 'rest', 'notes.ts'),
    'utf8',
  );
  const daemon = `${contentTs}\n${notesTs}`;
  const stamp = Date.now();

  for (const [key, code] of Object.entries(ERROR_CODES)) {
    pinLiteral(`ERROR_CODES.${key}`, daemon, `'${code}'`, `'${code}_NOT_REAL_${stamp}'`);
  }

  /* content-type：四条都必须逐字还在 `exportMindmap()` 里。 */
  for (const [fmt, spec] of Object.entries(EXPORT_EXPECTATIONS)) {
    pinLiteral(
      `EXPORT_EXPECTATIONS.${fmt}.ct`,
      contentTs,
      `'${spec.ct}'`,
      `'${spec.ct}-not-real-${stamp}'`,
    );
  }

  /*
   * ★ `NO_MINDMAP` 与「笔记查不到 ⇒ 404」这两条**同时**在导出路由上成立，
   *   正是 ⑤-a 那条空转的成因 —— 也正是 F5-a6 现在必须连错误码一起钉的理由。
   *   它哪天消失了（比如导出改成对"没有导图"回 200 空文档），那条判据的
   *   `exportCode` 就该跟着重看：这里红一次，把这件事交到改它的人手上。
   */
  pinLiteral(
    '导出路由的 NO_MINDMAP 分支（F5-a6 必须分码的理由）',
    contentTs,
    `'${ERROR_CODES.noMindmap}', 'no mindmap for this note'`,
    `'${ERROR_CODES.noMindmap}', 'definitely-not-real-${stamp}'`,
  );
}

{
  /*
   * ★★ 「产品发空 `quote`」**今天不可达** —— 而这条守卫盯的就是那个"今天"。
   *
   * `checkRefQuoteVerbatim` 的空 quote 那一格（#90 的 ⑤-b）价值是**纵深**：
   * 上游 `packages/mindmap/src/validate.ts` 已经挡住了生成与 PATCH 两条路径，
   * 所以端到端这一层今天不该看到空 quote。**那道闸一旦被放松，
   * 端到端这一层就是唯一还看得见的地方** —— 所以它没了必须有人知道。
   *
   * 判据钉的是**那条判断本身**（D-02 §3.5 的实现），不是"文件里出现过这几个字"。
   */
  const validateTs = readFileSync(join(REPO, 'packages', 'mindmap', 'src', 'validate.ts'), 'utf8');
  const stamp = Date.now();
  pinLiteral(
    '上游那道闸：validate.ts 的 REF_MISSING_QUOTE（D-02 §3.5）',
    validateTs,
    'if (!ref.quote || ref.quote.trim().length === 0)',
    `if (!ref.quote_not_real_${stamp})`,
  );
  pinLiteral(
    '上游那道闸的错误码',
    validateTs,
    "'REF_MISSING_QUOTE'",
    `'REF_MISSING_QUOTE_NOT_REAL_${stamp}'`,
  );
}

{
  const selfcheckTs = readFileSync(
    join(REPO, 'packages', 'runtime', 'src', 'selfcheck.ts'),
    'utf8',
  );
  const stamp = Date.now();
  /*
   * `ext.chineseSearch` 在源码里是**拼出来的**（`ext` 那一层 + `chineseSearch` 那个键），
   * 所以这里只钉后半段那个键名 —— 它改名了，`checks.find()` 就永远找不到。
   */
  const key = CHINESE_SEARCH_CHECK_ID.split('.')[1];
  pinLiteral(
    `CHINESE_SEARCH_CHECK_ID 的探针键 \`${key}\``,
    selfcheckTs,
    `${key}: () =>`,
    `${key}_not_real_${stamp}: () =>`,
  );
  pinLiteral(
    `TOOL_CHECK_PREFIX（\`${TOOL_CHECK_PREFIX}\` 那一层的 id）`,
    selfcheckTs,
    `'${TOOL_CHECK_PREFIX}ffmpeg'`,
    `'${TOOL_CHECK_PREFIX}ffmpeg_not_real_${stamp}'`,
  );
  /*
   * 🔴 ⑤-c 那条空转的成因：`borrowed` 那一档靠 `/PATH/i` 匹配 daemon 写给人看的一句中文。
   *   这条守卫挡不住**语义**漂移，但至少让"那句话被改了"这件事有人知道。
   */
  pinLiteral(
    '🔴 classifyToolChecks 的 borrowed 那一档所依赖的那句中文（⑤-c）',
    selfcheckTs,
    '来自系统 PATH，非本产品安装',
    `来自系统 PATH，非本产品安装_not_real_${stamp}`,
  );
}

{
  const schemas = readFileSync(join(REPO, 'packages', 'shared', 'src', 'schemas.ts'), 'utf8');
  /*
   * 分词器的两格必须与判据的白名单**双向**一致：
   *   · 少一格 ⇒ 产品发的那一格被 `checkSearchModes` 判成"期望值不在契约里"（恒红）；
   *   · 多一格 ⇒ 一个合法态在这里没有对应的期望值。
   */
  const m = /tokenizer: z\.enum\(\[([^\]]*)\]\)/.exec(schemas);
  if (!m) {
    bad(
      'schemas.ts 里应当有 `tokenizer: z.enum([…])`',
      '契约那个枚举被改名/删掉了，而 `TOKENIZERS` 没跟上',
    );
  } else {
    const inSchema = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    const inGuard = [...TOKENIZERS].sort();
    if (JSON.stringify(inSchema) === JSON.stringify(inGuard)) {
      ok(`SearchResponseSchema 的分词器两格与 TOKENIZERS 逐字一致：${inSchema.join('、')}`);
    } else {
      bad(
        'SearchResponseSchema 的 tokenizer 枚举与 TOKENIZERS 对不上',
        `契约里是 [${inSchema.join('、')}]，判据里是 [${inGuard.join('、')}]`,
      );
    }
    if (/'definitely_not_a_real_tokenizer'/.test(m[1]))
      bad('前提检查', '不可能的分词器名竟然命中了 —— 这条守卫是恒真的');
    else ok('前提检查：不存在的分词器名确实不在那个枚举里（上一条不是恒真）');
  }
}

{
  /*
   * ★ 假端点的 prompt 解析器与产品的 `buildUserPrompt()` 之间没有任何东西在守。
   *   格式一变，`parseOutlineIndices()` 会解析出 0 个编号 ⇒ 假端点回一张空提纲 ⇒
   *   `parseOutline` 得到「没有任何有效主题」⇒ 重试三次失败 ⇒
   *   **整条 F4 以「产品坏了」的形状变红，而真正坏的是夹具。**
   */
  const gen = readFileSync(join(REPO, 'packages', 'mindmap', 'src', 'generate.ts'), 'utf8');
  const needle = '`[${offset + i}] ${s.text.trim()}`';
  if (gen.includes(needle)) {
    ok('buildUserPrompt 的编号格式仍然是 `[编号] 正文`（parseOutlineIndices 对得上）');
  } else {
    bad(
      'buildUserPrompt 的编号格式变了',
      `generate.ts 里找不到 ${needle} —— 假端点会解析出 0 个编号，` +
        '于是整条 F4 会以「产品坏了」的形状变红，而真正坏的是夹具',
    );
  }
  if (gen.includes('`[${offset + i}] ${s.text.trim()}_not_real`'))
    bad('前提检查', '不可能的格式竟然命中了 —— 这条守卫是恒真的');
  else ok('前提检查：不存在的格式确实匹配不到（上一条不是恒真）');
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ④-bis 解析器与小工具：正反都跑一遍');

{
  const prompt = [
    '下面是转写稿的一部分，每行开头的 [数字] 是段落编号。',
    '',
    '转写稿：',
    '[0] And so my fellow Americans',
    '[1] ask not what your country can do for you [applause]',
    '',
    '输出 JSON 格式：',
  ].join('\n');
  const idx = parseOutlineIndices(prompt);
  if (JSON.stringify(idx) === JSON.stringify([0, 1])) ok('parseOutlineIndices → [0, 1]');
  else bad('parseOutlineIndices 解析错了', `实得 ${brief(idx)}`);

  // ★ 只收行首的：正文里的方括号不算编号（英文转写稿里的 [applause] 之类）
  if (parseOutlineIndices('正文里有 [3] 但不在行首').length === 0)
    ok('★ parseOutlineIndices 不把正文里的方括号当编号');
  else bad('parseOutlineIndices 把正文里的方括号当编号了', '会解析出越界的段落号');

  // 没有空格的 `[3]正文` 不算 —— 与产品的格式逐字对齐
  if (parseOutlineIndices('[3]没有空格').length === 0) ok('parseOutlineIndices 要求编号后有空白');
  else bad('parseOutlineIndices 收了没有空格的形状', '与 buildUserPrompt 的格式对不上');

  if (parseOutlineIndices('').length === 0 && parseOutlineIndices(null).length === 0)
    ok('parseOutlineIndices 对空输入回空数组（不抛）');
  else bad('parseOutlineIndices 对空输入行为不对', '它会让假端点在解析阶段炸掉');
}

{
  const hits = nodesWithNonce(NODES, NONCE);
  if (hits.length === 2) ok('nodesWithNonce 找到了那两个带 nonce 的节点');
  else bad('nodesWithNonce 数错了', `实得 ${hits.length} 个`);
  if (nodesWithNonce(NODES, 'E2EMMDEADBEEF00').length === 0)
    ok('★ nodesWithNonce 对没用过的 nonce 回空（变异证明靠的就是这一条）');
  else bad('nodesWithNonce 对没用过的 nonce 也有命中', '那条变异证明是空转的');
  /*
   * ★ 空 nonce 必须回空数组，不能回全部。
   *   `''.includes` 恒真 ⇒ 一个空 nonce 会让 F4-a4 的 nonce 那一格恒绿，
   *   而空 nonce 正是"随机串生成那一步坏了"的表现。
   */
  if (nodesWithNonce(NODES, '').length === 0) ok('★ nodesWithNonce 对空 nonce 回空（不是回全部）');
  else bad('nodesWithNonce 对空 nonce 回了全部', 'nonce 生成一坏，F4-a4 就恒绿');
}

{
  const uids = uidsOfNotePage(notePage([NOTE_UID, OTHER_UID]));
  if (JSON.stringify(uids) === JSON.stringify([NOTE_UID, OTHER_UID]))
    ok('uidsOfNotePage 取到了两条');
  else bad('uidsOfNotePage 取错了', brief(uids));
  if (uidsOfNotePage(undefined).length === 0 && uidsOfNotePage({ status: 500 }).length === 0)
    ok('uidsOfNotePage 对空/错误响应回空数组（不抛）');
  else bad('uidsOfNotePage 对空响应行为不对', '取不到时它会把整条腿炸掉而不是判红');
}

{
  const { own, borrowed, missing, tools } = classifyToolChecks(selfcheckChecks);
  const shape = `${tools.length}/${own.length}/${borrowed.length}/${missing.length}`;
  if (shape === '3/1/1/1') ok(`classifyToolChecks 分档正确（tool 共 3：自带 1 / 借 1 / 装不上 1）`);
  else bad('classifyToolChecks 分档错了', `tools/own/borrowed/missing = ${shape}，期望 3/1/1/1`);
  // 非 tool.* 的自检项一条都不许混进来
  if (tools.every((c) => String(c.id).startsWith(TOOL_CHECK_PREFIX)))
    ok(`classifyToolChecks 只收 ${TOOL_CHECK_PREFIX}* 的项`);
  else bad('classifyToolChecks 把别的层也算进来了', brief(tools.map((c) => c.id)));
}

{
  const long = 'x'.repeat(500);
  const s = brief(long);
  if (s.length < 400 && s.includes('共 500 字符')) ok('brief 截断长串（PROTOCOL §8）');
  else bad('brief 没有截断', `长度 ${s.length}`);
  // 循环引用不许把它炸掉 —— §8 那条 10.5 GB 的事故就是从这里来的
  const cyc = { name: 'a' };
  cyc.self = cyc;
  try {
    brief(cyc);
    ok('brief 对循环引用不抛（§8：断言失败不许变成"脚本炸了"）');
  } catch (e) {
    bad('brief 对循环引用抛了', String(e?.message ?? e));
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ⑤ 🔴 已登记的三条空转：**它们今天确实抓不住东西**（判据没动，等 owner 裁决）');

/*
 * ⚠️ 这一节钉的是**缺口存在**，不是"缺口是对的"（那就成了本仓四种失效里的
 *   第②种：把 bug 当正确行为断言）。
 *   每一条的形状都是：**两个应当被区分开的输入，今天得到同一个判决。**
 *   缺口一旦被修好，这里会红，逼出一次显式的「删掉这个桩 + 更新报告」，
 *   而不是让缺口悄悄消失（那样下一个人就不知道它曾经存在过）。
 */
function registerVacuity(name, aLabel, a, bLabel, b, fn, howToFix) {
  const ra = fn(a);
  const rb = fn(b);
  if (ra.ok === rb.ok) {
    ok(
      `🔴 ${name}：「${aLabel}」与「${bLabel}」今天判决相同（都${ra.ok ? '绿' : '红'}）—— 缺口仍在，已上报\n` +
        `        修法：${howToFix}`,
    );
  } else {
    bad(
      `🔴 ${name} 的缺口似乎已经被修上了`,
      `「${aLabel}」判${ra.ok ? '绿' : '红'}、「${bLabel}」判${rb.ok ? '绿' : '红'} —— ` +
        '这是好消息：请**删掉这个登记桩**，并把它从"已知空转"清单里去掉。',
    );
  }
}

/*
 * ── ✅ ⑤-a 与 ⑤-b 已修（Manager 2026-09-06），**桩已拆** ──────────────────────
 *
 * 两条的登记桩在这里存在过一天，现在删掉了 —— 这正是它们设计时说好的那一步：
 * 「修好的那天这里会红，逼出一次显式的删桩 + 更新报告」。
 * 它们今天的牙齿在②表里（`checkDeletedNoteWritesRejected` 的错误码那一格、
 * `checkRefQuoteVerbatim` 的空 quote 那一格，各带一条 `☑ 独占` 用例），
 * 以及下面 ③-h / ③-i 两组「退化版放过、现行版抓住」的对照。
 *
 * ⑤-c **没修**（要动 `apps/daemon`，另一路正在动那儿），桩还在。
 */

registerVacuity(
  '⑤-c classifyToolChecks 的 borrowed 那一档（拿散文当判据）',
  'daemon 那句中文里有 PATH ⇒ 认得出"借宿主的"',
  { status: 200, checks: toolChecks },
  '★ 那句中文被改写成不含 PATH ⇒ borrowed 恒为 0，而「借了宿主 0 个」朝着"更干净"的方向说假话',
  {
    status: 200,
    checks: toolChecks.map((c) =>
      c.status === 'warn' ? { ...c, detail: '/usr/bin/ffprobe（来自系统环境，非本产品安装）' } : c,
    ),
  },
  checkToolProbesUsable,
  'daemon 那侧给这一档一个结构字段（`origin: "store" | "bundled" | "system-path"`），' +
    '判据改读结构 —— 要动契约，需要 owner 裁决',
);

/*
 * ⑤-c 的第二半：上面那条 `checkToolProbesUsable` 对两种输入都判绿（它只管空集），
 * 真正会说假话的是 `classifyToolChecks` 的分档。这里把那句假话**印出来**。
 */
{
  const drifted = toolChecks.map((c) =>
    c.status === 'warn' ? { ...c, detail: '/usr/bin/ffprobe（来自系统环境，非本产品安装）' } : c,
  );
  const before = classifyToolChecks(toolChecks).borrowed.length;
  const after = classifyToolChecks(drifted).borrowed.length;
  if (before === 1 && after === 0) {
    ok(
      '🔴 ⑤-c 现场：同一台机器、同样借了 1 个宿主工具，' +
        `只把 daemon 那句中文改一个词 ⇒ 审计会报「借了宿主 ${after} 个」（真值 ${before}）`,
    );
  } else {
    bad(
      '🔴 ⑤-c 的缺口似乎变了',
      `原话下 borrowed=${before}，改写后 borrowed=${after} —— 请重新核一遍这条登记`,
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/**
 * ★ **机器可读的判决**（`--verdict-out <file>`）—— 给 `leg-coverage.mjs` 用。
 *
 * ## 为什么这个文件必须存在（2026-09-06 裁决）
 *
 * 那个工具此前判「这一格删了会不会崩」靠的是**对整段输出做正则**
 * （`/SyntaxError|ReferenceError|TypeError|…/`），判「红的是不是只有记录守卫」靠的是
 * **匹配一句中文**。`[实测]` 我在一条 `why` 说明里写了一次 `Type` + `Error` 拼起来的词，
 * 它当场把那一格从「没覆盖」错记成「判不了」——
 * **守卫自己在读散文**，与这一整轮在猎的是同一个病。
 *
 * 所以判决改成结构化的：本文件把 `{ cases, failures, failed[] }` 落盘，
 * 每条失败带一个 `kind`。`leg-coverage.mjs` 读这份 JSON：
 *
 *   · 文件**不存在** ⇒ 这次跑压根没走到这里 ⇒ `broke`（崩了，什么都没证明）
 *   · `failures === 0` 而退出码非 0（或反过来）⇒ 账对不上 ⇒ 同样算 `broke`
 *   · 全部失败的 `kind` 都是 `subsumed-record` ⇒ 红的只是记录守卫，**不算覆盖**
 *
 * 三条都不看一个字的散文。
 */
{
  const at = process.argv.indexOf('--verdict-out');
  if (at >= 0 && process.argv[at + 1]) {
    writeFileSync(
      process.argv[at + 1],
      `${JSON.stringify({ cases, failures, failed }, null, 2)}\n`,
    );
  }
}
/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('─'.repeat(78));
if (failures > 0) {
  say(`✘ selftest-e2e-notes：${cases} 条里 ${failures} 条不成立`);
  process.exit(1);
}
say(`✔ selftest-e2e-notes：${cases} 条断言全部成立（${SUITES.length} 条判据）`);
assert.equal(failures, 0);
