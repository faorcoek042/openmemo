/**
 * F4（思维导图）+ F5（笔记管理与检索）端到端断言 —— **纯函数，与网络无关**。
 *
 * ## 为什么非抽不可
 *
 * `e2e-notes-audit.mjs` 抽出来之前是 **1,879 行、115 处内联 `ok()`/`eq()`、
 * 顶层执行、结尾 `process.exit()`** —— 和 `e2e-runtime-audit.mjs` 被抓那次
 * 一模一样的形状：**import 不进来 ⇒ 它内部的判据一条都没法被喂输入。**
 *
 * runtime 那条腿因此烂了三周没人发现：
 *
 * ```js
 * // e2e-runtime-audit.mjs（修复前）
 * /先安装 CPU/.test(String(p.inapplicableReason ?? ''))
 * ```
 *
 * 文案从「先安装 CPU」改成「先装 CPU」的那天起，它**再也没有匹配过任何东西**，
 * 而它看起来仍然像一条护栏。修法就是本文件在做的事：把判据抽成纯函数、
 * 再对每一条写一份「坏输入必须被抓住 / 好输入必须放过」的证明
 * （`e2e-runtime-assertions.mjs` + `selftest-e2e-runtime.mjs`）。
 *
 * browser 腿（`e2e-browser-assertions.mjs`）、record 腿（`e2e-record-assertions.mjs`）
 * 已经照做。notes 是倒数第二条 —— **最后一条是 import**
 * （`e2e-import-assertions.mjs` + `selftest-e2e-import.mjs`）。
 * ⚠️ 这里原来写着「notes 是最后一条」，那句话在写下的当天为真、现在不是了。
 *
 * ## 这里的每个函数都满足四条
 *
 *   1. **纯**：只吃数据、只回 `{ ok, reason }`，不发请求、不读盘、不看时钟；
 *   2. **可被喂坏数据**：`selftest-e2e-notes.mjs` 对每一条都准备了「必须判红」的
 *      变异输入，**并且**准备了「必须判绿」的对照组 ——
 *      只拒不收的函数（恒假 ⇒ 恒红）和只收不拒的函数（恒真 ⇒ 恒绿）
 *      在门禁上的价值完全相同，都是零；
 *   3. **多条腿的判据，每条腿各有一个坏输入**：一条判据里 5 个 `ok()`，
 *      只喂一个坏输入只能证明其中一条有牙齿。抽掉任意一条修法，自检都要红；
 *   4. **契约字面量单独立出来**（`ERROR_CODES` / `EXPORT_EXPECTATIONS` /
 *      `CHINESE_SEARCH_CHECK_ID` …）：`.mjs` 拿不到 TS 的类型检查，所以
 *      `selftest-e2e-notes.mjs` 里有一组**契约漂移守卫**，正面核这些字面量
 *      还在不在产品源码里。少了它，判据会静默退回"恒不触发"或"恒红"。
 *
 * ## ⚠️ 这里**刻意没有** `Undecided` / `undecidable` 那一档
 *
 * 另外三条腿的判据模块有第三态（runtime 的 `checkUninstallReachedDisk` 会回
 * `undecidable: true`，browser 的 `judgeDeadButton` 会回 `'undecidable'`）。
 * 本腿**没有**，这是有意的，不是漏做：
 *
 *   · notes 腿的口径是「**前提构造不出来 = 当场判红**」（见 `e2e-notes-audit.mjs`
 *     文件头与第 3 节 `!subject`、第 11 节挑不出探针词那两处）；
 *   · 那条口径正是 `e2e-notes.yml` 里覆盖面那一格的论证依据。
 *
 * **要给这里的任何一条判据加第三态，先去改 `e2e-notes.yml` 的那段论证。**
 * 只在这里加一个 `undecidable`，会让一条"没验到"悄悄被数成"验过了"——
 * 那正是 `--undecided` 这条管道当初要消灭的东西（`null` vs `0`：没查 vs 查过了确实没有）。
 *
 * ⚠️ 本文件里的 `MUT-UNKNOWN` 是**变异级**的第三态（`mutation-verdict.mjs` 判的），
 * 与这里说的**断言级**第三态不是一回事，别混。
 *
 * 证明在 `scripts/ci/selftest-e2e-notes.mjs`：把这里任何一条判据抽掉，那边当场红。
 */

/* ────────────────────────── 通用小工具 ────────────────────────── */

/**
 * 统一的返回形态。`ok:false` 必须带上**能定位**的理由，不要只说"不匹配"。
 *
 * ⚠️ 不返回布尔：一个裸 `false` 到了调用方就只剩「这条红了」，
 * 而 CI 日志里读到它的人需要的是「红在哪一格、期望什么、实得什么」。
 */
const no = (reason) => ({ ok: false, reason });
const yes = (reason = '') => ({ ok: true, reason });

/**
 * 转字符串并**截断**。
 *
 * ⚠️ PROTOCOL §8：断言失败时 `util.inspect` 会顺着 `parentNode` / `parent`
 * 指针把整棵树展开（实测涨到 10.5 GB，表现成"脚本炸了"而不是"断言变红"）。
 * 所以这里一律先转成字符串再比、再截断。与 `e2e-notes-audit.mjs` 里那份同义。
 */
export function brief(v) {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = String(s ?? '');
  return s.length > 300 ? `${s.slice(0, 300)}…(共 ${s.length} 字符)` : s;
}

/** 逐条跑，第一条不成立就回它 —— 与原来一串 `ok()` / `eq()` 的短路语义一致。 */
function all(steps) {
  for (const step of steps) {
    const r = typeof step === 'function' ? step() : step;
    if (!r.ok) return r;
  }
  return yes();
}

/** `eq()` 的纯函数版：**先转字符串再比**（同 §8）。 */
function same(actual, expected, what) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  return a === e ? yes() : no(`${what} —— 期望 ${brief(e)}，实得 ${brief(a)}`);
}

/** `ok()` 的纯函数版。 */
function must(cond, reason) {
  return cond ? yes() : no(reason);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 契约字面量 —— `.mjs` 拿不到类型检查，所以它们由自检正面核                    */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 判据里用到的**错误码**。与 daemon 的 `sendError(res, …, '<code>', …)` 逐字对应。
 *
 * ⚠️ 每一个都由 `selftest-e2e-notes.mjs` 的契约漂移守卫核过：码在 daemon 源码里
 * 必须真的还在。少了它，`eq(body.error.code, 'X')` 会变成一条**恒红**的断言
 * （产品发的是新码），而恒红的门等于没有门。
 */
export const ERROR_CODES = Object.freeze({
  /** PATCH 一份结构非法的导图（子节点指向不存在的 key）。 */
  invalidMindmap: 'INVALID_MINDMAP',
  /** `?format=` 认不出来。**不许静默回落到 md。** */
  badFormat: 'BAD_FORMAT',
  /** `?folder=` / `?starred=` 认不出来。**不许静默回落到"全部"。** */
  badQueryParam: 'BAD_QUERY_PARAM',
  /** 笔记不存在（含软删之后）。Manager 2026-08-08 裁决：**404，不是 410**。 */
  noteNotFound: 'NOTE_NOT_FOUND',
  /**
   * 这条笔记还没有导图。
   *
   * ⚠️ 判据里**没有**用它 —— 它在这里是为了让 `checkDeletedNoteWritesRejected()`
   * 那条已知空转说得出口（见那个函数的注释）。自检的契约守卫也核它。
   */
  noMindmap: 'NO_MINDMAP',
});

/**
 * 四种导出各自的 `content-type` 与「时间戳带不带得走」。
 *
 * ⚠️ `ct` 与 `apps/daemon/src/http/rest/content.ts` 的 `exportMindmap()` 逐字对应；
 * `ts` 是**产品行为的断言**，不是配置：md 用 `includeTimestamps: true`、
 * json 是整份 doc（含 `refs[].startMs`），而 opml / mm 的序列化器结构上带不走时间。
 * 界面上那句"导出损耗"说明就建立在这四格上，所以它们变了必须有人知道。
 */
export const EXPORT_EXPECTATIONS = Object.freeze({
  /** md 里时间戳的形状是 `[12:34]`（`toMarkdown(doc, { includeTimestamps: true })`）。 */
  md: { ct: 'text/markdown; charset=utf-8', ts: true, mark: (timecode) => `[${timecode}]` },
  opml: { ct: 'text/x-opml; charset=utf-8', ts: false, mark: null },
  mm: { ct: 'application/x-freemind; charset=utf-8', ts: false, mark: null },
  /** json 是整份 doc，时间戳以**毫秒原值**出现在 `refs[].startMs` 上。 */
  json: {
    ct: 'application/json; charset=utf-8',
    ts: true,
    mark: (_timecode, ms) => String(ms),
  },
});

/**
 * `/api/selfcheck` 里那条中文检索探针的 id。
 *
 * ⚠️ 这个字面量与 `packages/runtime/src/selfcheck.ts` 绑在一起。它改名而这里没跟，
 * `checks.find(c => c.id === …)` 会**永远找不到** ⇒ `ok(!!cn, '判据本身不见了')`
 * 变成恒红。自检里有守卫。
 */
export const CHINESE_SEARCH_CHECK_ID = 'ext.chineseSearch';

/** `/api/selfcheck` 里工具那一层的 id 前缀（`tool.ffmpeg` / `tool.ytDlp` …）。 */
export const TOOL_CHECK_PREFIX = 'tool.';

/**
 * 分词器只有这两格（`packages/shared/src/schemas.ts` 的 `SearchResponseSchema`）。
 *
 * ★ 这一格本身就是一次事故的现场：`/api/search` 的 `modes` 曾经发的是
 * `chineseTokenizer`（boolean），T-200 A-2 收口成 `tokenizer: 'simple'|'trigram'`，
 * 而这条腿只在 `workflow_dispatch` 时跑 —— 于是它拿一个 daemon 早就不发的旧键名
 * 读了很久的 `undefined`，没有任何东西说过一句话。
 */
export const TOKENIZERS = Object.freeze(['simple', 'trigram']);

/* ══════════════════════════════════════════════════════════════════════════ */
/* F4-a 思维导图生成 —— 产品自己的 OpenAI 兼容链路                             */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 假的 OpenAI 兼容端点用来读懂输入的那个解析器：从 user prompt 里取出**行首**编号。
 *
 * ## 为什么它是判据而不是脚手架
 *
 * 假端点**必须真的读懂输入**：`parseOutline` 会把越界 / 重复 / 非整数的编号全丢掉，
 * 随便编一个数字会得到「没有任何有效主题」然后重试三次失败。也就是说
 * **这个正则一旦对不上产品的 prompt 格式，整条 F4 会以"产品坏了"的形状变红**，
 * 而真正坏掉的是夹具。
 *
 * 格式来自 `packages/mindmap/src/generate.ts` 的 `buildUserPrompt()`：
 * `` `[${offset + i}] ${s.text.trim()}` `` —— 编号、右括号、**一个空格**、正文。
 *
 * ⚠️ 只收**行首**的：正文里的方括号（英文转写稿里的 `[applause]` 之类）不算编号。
 * 自检里有一条对着 `buildUserPrompt` 源码的契约守卫。
 *
 * @param {string} promptText
 * @returns {number[]} 出现顺序的段落编号
 */
export function parseOutlineIndices(promptText) {
  const idx = [];
  for (const line of String(promptText ?? '').split('\n')) {
    const m = /^\[(\d+)\]\s/.exec(line);
    if (m) idx.push(Number(m[1]));
  }
  return idx;
}

/** PATCH /api/settings 之后回读，provider 配置真的落在 daemon 那边了。 */
export function checkSettingsRoundTrip({ status, settings, providerId, baseUrl }) {
  const s = settings ?? {};
  return all([
    () => same(status, 200, 'PATCH /api/settings 状态码'),
    () => same(s['llm.defaultProviderId'], providerId, '回读 llm.defaultProviderId'),
    () => same(s[`llm.baseUrl.${providerId}`], baseUrl, `回读 llm.baseUrl.${providerId}`),
  ]);
}

/**
 * 导图 job 真的 **succeeded**，不是 blocked / failed / 超时。
 *
 * ⚠️ `blocked` 单独说出来：`runMindmapJob` 没有转写稿会 `blocked: NO_TRANSCRIPT`，
 * 那是**前置步骤没跑**，不是 F4 坏了。两者判决相同（都红），但读日志的人
 * 需要分得清该去查哪边。
 */
export function checkMindmapJobSucceeded({ postStatus, jobUid, jobState }) {
  const st = jobState ?? {};
  return all([
    () => same(postStatus, 202, 'POST mindmap 状态码'),
    () =>
      must(
        typeof jobUid === 'string' && jobUid.length > 0,
        `POST /api/notes/:uid/mindmap 没回 jobUid（实得 ${brief(jobUid)}）`,
      ),
    () =>
      must(
        st.state === 'succeeded',
        `导图 job 没成功：${brief(st.note ?? st.state)}` +
          (st.blockedCode ? `（blockedCode=${brief(st.blockedCode)}）` : '') +
          (st.error ? ` error=${brief(st.error)}` : ''),
      ),
  ]);
}

/**
 * 产品真的**向那个 HTTP 端点发了请求**，不是凭空造了一张图。
 *
 * 只数 `chat/completions` 的**真请求**：`/models` 与能力探测（`Reply {"ok":true}`）
 * 是 provider 解析阶段就会发的，用它们当判据会让"产品造了假图"照样绿。
 */
export function checkLlmEndpointCalled({ chatCalls, calls }) {
  return must(
    Number(chatCalls) > 0,
    `假端点一次 chat/completions 真请求都没收到（共收到 ${(calls ?? []).length} 条请求：${brief(calls)}）` +
      ' —— 那张导图不是从这个端点流进来的',
  );
}

/**
 * 文本里含 nonce 的那些节点。
 *
 * ★ **F4-a4 与它的变异证明共用这一个** —— 变异换的是**输入**（一个从未用过的 nonce），
 * 不是另写一个谓词。另写一个的话，被证明有区分力的就不是 F4-a4 实际用的那个了，
 * 而"断言的是报出来的值、不是实际用的值"正是本仓栽过的第二种假绿。
 *
 * @param {Array<{text?: string}>} nodes
 * @param {string} nonce
 */
export function nodesWithNonce(nodes, nonce) {
  const n = String(nonce ?? '');
  if (n.length === 0) return [];
  return (nodes ?? []).filter((node) => String(node?.text ?? '').includes(n));
}

/**
 * GET 回来的导图带 llm 出处，且节点里有 nonce。
 *
 * **判据是 nonce**：假端点回的每个主题标题里都埋了本次运行随机生成的串。
 * 它出现在导图节点里，就证明这段内容真的是从那个 HTTP 端点流进产品的。
 */
export function checkMindmapProvenance({ status, generatedBy, nodes, nonce, providerId }) {
  return all([
    () => same(status, 200, 'GET mindmap 状态码'),
    () => same(generatedBy, `llm:${providerId}`, 'generatedBy'),
    () => {
      const hit = nodesWithNonce(nodes, nonce);
      return must(
        hit.length > 0,
        `没有任何节点包含 nonce ${brief(nonce)} —— 这张图不是那个端点生成的。` +
          `节点文本：${brief((nodes ?? []).map((n) => n?.text))}`,
      );
    },
  ]);
}

/**
 * 那个带 refs 的主题节点**在**（F4-a5 的前提）。
 *
 * 前提不成立时判红，不判第三态 —— 见文件头「刻意没有 Undecided」那一段。
 */
export function checkTopicRefPresent({ node, label, nodeTexts, expectedSeg, expectedIdx }) {
  return all([
    () =>
      must(
        !!node && Array.isArray(node.refs) && node.refs.length > 0,
        `找不到文本恰为「${brief(label)}」且带 refs 的节点。节点文本：${brief(nodeTexts)}`,
      ),
    () =>
      must(
        expectedSeg !== undefined && expectedSeg !== null,
        `我回给产品的编号是 ${brief(expectedIdx)}，但转写稿里没有这一段 —— ` +
          '期望值算不出来，这条判据无从谈起',
      ),
  ]);
}

/**
 * 导图节点的 `refs[0]` 时间戳 = **从转写稿独立算出来的真值**。
 *
 * ## 这条判据要防的循环论证
 *
 * 第一版写错过，错法正是本任务要防的那一种：它拿「导图报的 startMs」去转写稿里
 * **找一个相等的段落**，找到就算过。那只证明了产品报的值是某个真实段落的起点，
 * **没有证明它是对的那一个** —— 产品把主题指到隔壁段落，那一版照样绿。
 *
 * 现在期望值由**假端点自己记得回了哪个编号**给出（`llmState.returnedSegs`），
 * 再从 `GET /api/notes/:uid/transcript` 取回的段落里取 start/end，与产品的输出无关。
 *
 * ★ **F4-a5 与它的变异证明共用这一个**：变异喂的是一段整体平移 1 秒的
 * `seg`，同一个函数必须红。
 *
 * ⚠️ 变异刻意不用"换成转写稿里的另一段"：`[实测]` jfk.wav 用 whisper-tiny 只转出
 * **1 段**，那种写法在这台机器上永远造不出变异体，于是那条证明会被静默跳过。
 * 平移法与段落数无关。
 */
export function checkRefTimestamps({ ref, seg }) {
  return all([
    () => same(Number(ref?.startMs), Number(seg?.startMs), 'refs[0].startMs'),
    () => same(Number(ref?.endMs), Number(seg?.endMs), 'refs[0].endMs'),
  ]);
}

/**
 * `refs[0]` 的 quote 是**转写稿里的原文逐字**，且指向对的那份转写稿。
 *
 * quote 必须逐字，是重转写之后重定位的唯一依据（`packages/mindmap` 的设计约束）：
 * 模型改写过的句子在新转写稿里找不回来，那条 ref 就永久失效。
 *
 * 只比前 60 个字符：模型可能把一段长引文截短，但**开头不许换**。
 *
 * ## ✅ 已修（#90 抓到的 ⑤-b，Manager 2026-09-06 裁决"立刻修，一行"）
 *
 * 这一格**曾经是空转的**：`joined.includes('')` 在 JS 里**永远是 true**，
 * 所以产品把 `quote` 发成空串、或者干脆不发这个字段
 * （`String(undefined ?? '')` 也是空串），这一格照样绿 ——
 * 而那恰恰是它要防的最坏情况：**重转写之后这条 ref 永久失效**。
 * 第①类失效：断言的东西在缺陷状态下也成立。现在由下面第一格挡住。
 *
 * ## ⚠️ 顺带判的那件事：产品发空 `quote`「是不是一个真缺陷」—— **今天不可达**
 *
 * 不是。`packages/mindmap/src/validate.ts` 已经挡住了两条产出路径：
 *
 * ```ts
 * if (!ref.quote || ref.quote.trim().length === 0) {
 *   add('REF_MISSING_QUOTE', 'refs[].quote 必填，否则重转写后无法重定位', key);
 * }
 * ```
 *
 * 生成（`refFromIndices` → `validate`）与用户 PATCH（`content.ts` 写库前必校验）
 * 都过这一关，所以**空 quote 落不了库**。D-02 §3.5 那条设计约束今天有实现在守。
 *
 * ⇒ 这一格的价值是**纵深**：它盯的不是"产品今天会不会发空 quote"，
 *   而是"`validate.ts` 那道闸哪天被放松了，端到端这一层还看不看得见"。
 *   自检里有一条**契约漂移守卫**正面核 `REF_MISSING_QUOTE` 还在不在 ——
 *   那道闸没了而这里也没牙齿，就是两层同时哑掉。
 */
export function checkRefQuoteVerbatim({ ref, segments, transcriptUid }) {
  const joined = (segments ?? []).map((s) => String(s?.text ?? '').trim()).join(' ');
  const quote = String(ref?.quote ?? '').trim();
  return all([
    /*
     * ★ 这一格**必须排在 includes 之前**：`includes('')` 恒真，
     *   空 quote 走到下一格就再也拦不住了（这正是它曾经空转的原因）。
     */
    () =>
      must(
        quote.length > 0,
        'refs[0].quote 是空的（或全是空白）—— 重转写之后这条 ref 永久失效，' +
          '用户点进去会跳到一个不存在的位置。' +
          `上游 validate.ts 的 REF_MISSING_QUOTE 本该挡住它，实得 ${brief(ref?.quote)}`,
      ),
    () =>
      must(
        joined.includes(quote.slice(0, 60)),
        `refs[0].quote 不是转写稿里的原文逐字：${brief(ref?.quote)}`,
      ),
    () => same(String(ref?.transcriptUid), String(transcriptUid), 'refs[0].transcriptUid'),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F4-b 导图可编辑                                                             */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * PATCH 之后：revision 前进、内容真落库、出处从 `llm:*` 转成 `user`。
 *
 * 三格缺一不可，各自堵一种"看起来成功了"：
 *   · revision 不前进 ⇒ 并发编辑的乐观锁失去依据；
 *   · 回读不到 ⇒ 只写了内存 / 只回了 200；
 *   · `generatedBy` 还是 `llm:*` ⇒ 下一次"重新生成"会不声不响覆盖用户的编辑。
 */
export function checkMindmapEditPersisted({
  patchStatus,
  patchRevision,
  patchMindmapUid,
  revisionBefore,
  rereadStatus,
  rootText,
  editMark,
  generatedBy,
}) {
  return all([
    () => same(patchStatus, 200, 'PATCH mindmap 状态码'),
    () =>
      must(
        Number(patchRevision) > Number(revisionBefore),
        `revision 没前进（之前 ${brief(revisionBefore)}，之后 ${brief(patchRevision)}）`,
      ),
    () => must(typeof patchMindmapUid === 'string', `没有 mindmapUid：${brief(patchMindmapUid)}`),
    () => same(rereadStatus, 200, '回读 GET mindmap 状态码'),
    () =>
      must(
        String(rootText ?? '').includes(String(editMark)),
        `编辑没有落库 —— 回读到的根节点是 ${brief(rootText)}`,
      ),
    () => same(generatedBy, 'user', '编辑后的 generatedBy'),
  ]);
}

/**
 * 「这个请求被**按设计**拒掉了」—— 状态码 + 错误码。
 *
 * F4-b2（非法 doc）/ F4-c3（未知 format）/ F5-b2（不存在的 folder）/ F5-c3（`?starred=0`）
 * 共用这一条。
 *
 * ⚠️ 判据是**具体那个码**，不是"反正别 200"：400/500 也不是 200，但它们都不是
 * 「这个参数认不出来」的正确表达，而前端正是按码分档给措辞的。
 *
 * `expectCode` 传 `null` = 这一格只钉状态码（`?starred=0` 那条今天就是这样，
 * 保持与抽出前逐字一致 —— 这一轮是让它可测，不是改它判什么）。
 */
export function checkRejection({ status, body, expectStatus, expectCode, label }) {
  return all([
    () => same(status, expectStatus, `${label} 的状态码`),
    () => (expectCode === null ? yes() : same(body?.error?.code, expectCode, `${label} 的错误码`)),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F4-c 四种导出                                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一种导出格式的信封：200 + `content-type` 正确 + 正文非空 + 正文里有 nonce。
 *
 * nonce 那一格是**内容真的流过来了**的证据。少了它，一个只回 XML 骨架、
 * 一个节点都不写的序列化器照样能满足前三格。
 */
export function checkExportEnvelope({ fmt, status, contentType, body, nonce }) {
  const expect = EXPORT_EXPECTATIONS[fmt];
  const b = String(body ?? '');
  return all([
    () => must(!!expect, `format=${fmt} 不在 EXPORT_EXPECTATIONS 里 —— 判据自己没覆盖这一格`),
    () => same(status, 200, `format=${fmt} 状态码`),
    () => same(contentType, expect.ct, `format=${fmt} content-type`),
    () => must(b.length > 0, `format=${fmt} 正文是空的`),
    () =>
      must(
        b.includes(String(nonce)),
        `format=${fmt} 正文里没有 nonce ${brief(nonce)}：${brief(b.slice(0, 200))}`,
      ),
  ]);
}

/**
 * 「这份导出里**没有**时间戳」。
 *
 * ★ **F4-c2 与它的变异证明共用这一个。** 两处各写一份的话，变异证明的就不是
 * F4-c2 实际用的那个谓词了。变异把它原样拿去量 **md**（md 里确实有 `[12:34]`），
 * 必须红 —— 红不了就说明那两条 `opml/mm 没有时间戳` 的绿灯，
 * 可能只是因为这个谓词对**任何**输入都说"没有"。
 *
 * ⚠️ 时间戳用的是一个**合成的、不可能碰巧出现的**值（754321ms → 12:34），
 * 不是转写稿里的真值：真转写稿第一段常常从 0ms 开始，而 `0:00` / `0`
 * 在 XML 属性、版本号、任何数字里都可能碰巧命中 —— 拿它去断言"没有时间戳"，
 * 断言的是个恒真的东西。那正是本仓栽过的「夹具里恒为假」的镜像面。
 */
export function checkNoTimestamp({ body, label, timecode, ms }) {
  const b = String(body ?? '');
  const hitText = b.includes(String(timecode));
  const hitMs = b.includes(String(ms));
  return must(
    !hitText && !hitMs,
    `${label} 里出现了时间戳（${hitText ? String(timecode) : ''}${hitText && hitMs ? ' 和 ' : ''}${
      hitMs ? String(ms) : ''
    }）—— 界面上那句"导出损耗"说明该改了`,
  );
}

/**
 * 时间戳**只有 md 与 json 带得走**（今天仍然成立）。
 *
 * 正反两个方向都要：
 *   · 只查"md/json 有" ⇒ 一个把时间戳塞进所有格式的序列化器照样过；
 *   · 只查"opml/mm 没有" ⇒ 一个把时间戳从**所有**格式里删光的改动照样过，
 *     而那会让 md 导出对用户失去意义。
 */
export function checkTimestampFidelity({ bodies, timecode, ms, table = EXPORT_EXPECTATIONS }) {
  const formats = Object.keys(table);
  return all([
    /*
     * 非空虚前提：正反两侧都必须**真的有格式落在上面**。
     * 有人把表改成四格全 `ts: false`，下面那个循环仍然会全绿 ——
     * 而它绿的理由会是"没有任何一格需要有时间戳"，一句关于空集的废话。
     */
    () =>
      must(
        formats.some((f) => table[f].ts) && formats.some((f) => !table[f].ts),
        'EXPORT_EXPECTATIONS 里"带得走"和"带不走"必须各有至少一格 ——' +
          '全落在一侧时这条判据两个方向里有一个是恒真的',
      ),
    () => {
      for (const fmt of formats) {
        const spec = table[fmt];
        const body = String((bodies ?? {})[fmt] ?? '');
        if (spec.ts) {
          const marker = spec.mark(timecode, ms);
          const r = must(
            body.includes(marker),
            `${fmt} 里没有时间戳 ${marker}：${brief(body.slice(0, 400))}`,
          );
          if (!r.ok) return r;
        } else {
          const r = checkNoTimestamp({ body, label: fmt, timecode, ms });
          if (!r.ok) return r;
        }
      }
      return yes();
    },
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F5-a 笔记增删改查                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/** POST /api/notes/import 真的建出一条笔记（uid 是 26 位 ULID）。 */
export function checkNoteCreated({ status, noteUid }) {
  return all([
    () => same(status, 202, 'import 状态码'),
    () =>
      must(
        typeof noteUid === 'string' && noteUid.length === 26,
        `没有合法的 noteUid（ULID 应当是 26 位）：${brief(noteUid)}`,
      ),
  ]);
}

/** PATCH 改标题 → GET 读得回来。 */
export function checkTitleRoundTrip({ patchStatus, getStatus, title, expectTitle }) {
  return all([
    () => same(patchStatus, 200, 'PATCH note 状态码'),
    () => same(getStatus, 200, 'GET note 状态码'),
    () => same(title, expectTitle, '标题'),
  ]);
}

/** PUT /star 生效：回执与回读都说 `starred=true`。 */
export function checkStarApplied({ putStatus, putStarred, rereadStarred }) {
  return all([
    () => same(putStatus, 200, 'PUT star 状态码'),
    () => same(putStarred, true, 'starred 回执'),
    () => same(rereadStarred, true, '回读 starred'),
  ]);
}

/**
 * **非空虚前提**：删之前这条笔记**搜得到**。
 *
 * 没有它，「删完搜不到」是一句恒真的废话 —— 一个从来就没被索引进去的词，
 * 删不删都搜不到。本仓正在清的第①类失效（空集判通过）就是这个形状，
 * 所以它单独成一条判据、单独被自检钉住。
 */
export function checkSearchablePremise({ hits, noteUid }) {
  const mine = (hits ?? []).filter((h) => h?.noteUid === noteUid);
  return must(
    mine.length > 0,
    '删之前就搜不到这条笔记 —— 那"删完搜不到"就是句空话（恒真的断言等于没有断言）',
  );
}

/**
 * DELETE 之后：**列表里没有了、搜索也搜不到了**。
 *
 * 两条口径必须同时成立。只查一条都有真实的绕过法：
 *   · 只查列表 ⇒ 软删只改了列表查询的 WHERE，FTS 索引照旧命中；
 *   · 只查搜索 ⇒ 只从索引里删了，列表照旧渲染。
 *
 * ⚠️ 调用方必须先过 `checkSearchablePremise()`，否则第二条恒真。
 */
export function checkDeletionInvisible({ deleteStatus, deleteOk, listUids, afterHits, noteUid }) {
  return all([
    () => same(deleteStatus, 200, 'DELETE 状态码'),
    () => same(deleteOk, true, 'DELETE 回执的 ok'),
    () => same((listUids ?? []).includes(noteUid), false, '删除后仍出现在列表里'),
    () =>
      same(
        (afterHits ?? []).filter((h) => h?.noteUid === noteUid).length,
        0,
        '删除后仍然搜得到（条数）',
      ),
  ]);
}

/**
 * 软删之后 GET 这条笔记回 **404 NOTE_NOT_FOUND** —— 与列表、搜索口径一致。
 *
 * ## 为什么钉的是这个具体的码
 *
 * 缺陷已修（`repos.noteByUid()` 补上 `deleted_at IS NULL`），
 * Manager 2026-08-08 裁决 **404，不是 410**：软删在语义上可逆，
 * 410 Gone 隐含"永久移除"，会让"可恢复"在协议层说不通。
 * 断言的是 404 这个具体码，不是"反正别 200"。
 *
 * ★ **F5-a5 与它的变异证明共用这一个**：变异拿一条**活着的**笔记来量，必须红。
 * 否则"删掉的回 404"可能只是因为这个 uid 从来就不存在（拼错也 404）。
 */
export function checkNoteGone({ status, body }) {
  return all([
    () => same(status, 404, '已删除笔记的 GET 状态码'),
    () => same(body?.error?.code, ERROR_CODES.noteNotFound, '已删除笔记的 GET 错误码'),
  ]);
}

/**
 * 已删除的笔记**不能再被编辑 / 打星标 / 导出**（写路径同样 404）。
 *
 * `noteByUid` 有 10 个调用点，全是 API 入口。只验 GET 的话，
 * 「已删除的笔记还能被继续编辑」这一半仍然没人看着。
 *
 * ## ✅ 已修（#90 抓到的 ⑤-a，Manager 2026-09-06 裁决"两条都做"）
 *
 * `exportStatus` 那一格**曾经证明不了任何东西**：审计跑它用的是一条刚导入、
 * 从来没生成过导图的哑笔记，而 `content.ts` 的导出路由在**笔记查得到**时
 * 也会回 `404 NO_MINDMAP`（`mindmaps.latestOfNote(note.id)` 为空那一支）。
 * 于是它分不开「已删除的笔记被拒了」和「这条笔记本来就没有导图」——
 * **把软删守卫从导出路由上整个抽掉，这一格照样绿。**
 *
 * 两条修法都做了，缺一不可：
 *
 *   ① **夹具**：审计在删之前先给那条笔记 PATCH 一份导图（`PATCH /mindmap` 会
 *      upsert，`mindmaps.save()` 不要求先存在），并**当场断言活着的时候导出真的
 *      回 200** —— 没有这一句，PATCH 悄悄失败就会把空转原样换一个形状回来；
 *   ② **判据**：连错误码一起钉。只做①不够 —— `NO_MINDMAP` 与软删守卫今天都回
 *      404，不分码的话下一个人换个夹具就又踩回去。
 *
 * ⚠️ `exportCode` 传 `null` 会退回只钉状态码那一版（也就是那个空转）。
 *    调用方**没有一处**这样传；自检里有一条 `☑ 独占` 用例正面钉住"不分码就抓不住"。
 */
export function checkDeletedNoteWritesRejected({
  patchStatus,
  starStatus,
  exportStatus,
  exportBody,
  exportCode = ERROR_CODES.noteNotFound,
}) {
  return all([
    () => same(patchStatus, 404, '改标题的状态码'),
    () => same(starStatus, 404, '打星标的状态码'),
    () => same(exportStatus, 404, '导出的状态码'),
    () =>
      exportCode === null
        ? yes()
        : same(
            exportBody?.error?.code,
            exportCode,
            `导出的错误码（${ERROR_CODES.noMindmap} ≠ ${ERROR_CODES.noteNotFound}：` +
              '「这条笔记不存在」和「这条笔记没有导图」都是 404，不分码就分不开）',
          ),
  ]);
}

/**
 * **非空虚前提**：这条笔记**活着的时候导出真的回 200**。
 *
 * 没有它，上面那条判据会换一个形状退回空转：夹具那半（删之前 PATCH 一份导图）
 * 一旦悄悄失败，删后拿到的 404 又只可能是 `NO_MINDMAP` —— 而错误码那一格
 * 会因此**恒红**，把"夹具没造出来"报成"产品退化了"。两个方向都要有人看见。
 */
export function checkExportableBeforeDelete({ status, contentType, body }) {
  return all([
    () =>
      same(
        status,
        200,
        '删之前导出这条笔记的状态码 —— 前提是它**真的有导图**，否则 F5-a6 的错误码那一格问不出东西',
      ),
    () => same(contentType, EXPORT_EXPECTATIONS.md.ct, '删之前导出的 content-type'),
    () => must(String(body ?? '').length > 0, '删之前导出的正文是空的 —— 这份导图是个空壳'),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F5-b 文件夹                                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/** 一页 `/api/notes` 的 uid 列表。分页与筛选的判据都从它出发。 */
export function uidsOfNotePage(page) {
  return (page?.body?.notes ?? []).map((n) => n?.uid);
}

/**
 * 「这条笔记**不在**这份结果里」。
 *
 * ★ **F5-b1 与它的变异证明共用这一个**：F5-b1 用它量**文件夹外**的笔记（必须不在），
 * 变异用它量**文件夹内**的那一条（它必须在，所以谓词会红）。
 * 同一个谓词、两个已知答案相反的输入 —— 这才叫证明它有区分力。
 */
export function checkAbsentFromList({ page, uid, label }) {
  const uids = uidsOfNotePage(page);
  return must(
    uids.includes(uid) === false,
    `${label} 居然出现在这份结果里（共 ${uids.length} 条）`,
  );
}

/** POST /api/folders 真的建出一个文件夹。 */
export function checkFolderCreated({ status, folderUid }) {
  return all([
    () => same(status, 201, 'POST /api/folders 状态码'),
    () =>
      must(
        typeof folderUid === 'string' && folderUid.length > 0,
        `没有文件夹 uid：${brief(folderUid)}`,
      ),
  ]);
}

/**
 * `?folder=<uid>` **只**返回该文件夹里的笔记。
 *
 * 三格：里面那条在、外面那条不在、`total` 对得上。
 * 只查"里面那条在" ⇒ 一个把 `folder` 参数整个忽略、返回全部的实现照样过 ——
 * 这正是 `?starred=0` 那条判据要防的同一种"静默回落到全部"。
 */
export function checkFolderFilter({ page, insiderUid, outsiderUid, expectTotal }) {
  return all([
    () => same(page?.status, 200, '按 folder 筛的状态码'),
    () => same(uidsOfNotePage(page).includes(insiderUid), true, '筛出来的结果里没有那条笔记'),
    () =>
      checkAbsentFromList({
        page,
        uid: outsiderUid,
        label: '主角笔记（不在该文件夹里）',
      }),
    () => same(page?.body?.total, expectTotal, '该文件夹里的 total'),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F5-c 星标与分页边界                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ★ 星标分页真的**跨过了第 50 条**，且一条都不少。
 *
 * ## 事故原形
 *
 * `limit` 先切、`starred` 后筛 —— 第 50 条之后的星标笔记**静默消失**。
 * 页面显示的内容是对的，只是不全，用户无从知道自己少看了什么。
 *
 * ## 每一格堵一种绕过法
 *
 * | 格 | 抽掉它之后什么能溜过去 |
 * |---|---|
 * | 每页 200 | 后面几页 500，而只看第一页的判据不知道 |
 * | `total > pageSize`（**非空虚前提**） | 数据只有 3 条时整条断言恒真，边界根本没跑到 |
 * | 第 1 页满页 + `hasMore=true` | 一个"第一页只回 7 条"的实现 |
 * | `pages.length >= 2` | 第 50 条之后那一档没被走到 |
 * | 去重条数 == `total` | **有笔记被静默吞掉**（就是那个事故） |
 * | 含最早那条 | 事故会吞掉的正是它（`created_at DESC` 下它在最后一页） |
 * | 最后一页 `hasMore=false` | 翻页永远停不下来 / 停错地方 |
 *
 * @param {{pages: Array<object>, pageSize: number, oldestStarredUid: string}} o
 */
export function checkStarredPagination({ pages, pageSize, oldestStarredUid }) {
  const ps = pages ?? [];
  const page1 = ps[0];
  const seen = new Set();
  for (const p of ps) for (const u of uidsOfNotePage(p)) seen.add(u);
  const total = Number(page1?.body?.total);

  return all([
    () => must(ps.length > 0, '一页都没翻到 —— 分页判据无从谈起'),
    () => {
      for (const [i, p] of ps.entries()) {
        const r = same(p?.status, 200, `第 ${i + 1} 页状态码`);
        if (!r.ok) return r;
      }
      return yes();
    },
    () =>
      must(
        total > pageSize,
        `starred total=${brief(total)} 没超过一页（${pageSize}）—— 这条边界根本没跑到，` +
          '下面几格会变成恒真的废话',
      ),
    () => same(page1?.body?.notes?.length, pageSize, '第 1 页条数（必须满页）'),
    () => same(page1?.body?.hasMore, true, '第 1 页 hasMore'),
    () => must(ps.length >= 2, `只翻出 ${ps.length} 页 —— 第 ${pageSize} 条之后那一档没被走到`),
    () => same(seen.size, total, '所有页并起来的去重条数 ≠ total（有笔记被静默吞掉了）'),
    () =>
      same(
        seen.has(oldestStarredUid),
        true,
        '最早那条星标笔记一页都没出现 —— 这就是那个事故（limit 先切、starred 后筛）',
      ),
    () => same(ps[ps.length - 1]?.body?.hasMore, false, '最后一页 hasMore'),
  ]);
}

/**
 * `starred` 筛的是"**筛**"，不是把全部都返回。
 *
 * 第二格（未加星的至少 3 条）是**非空虚前提**：如果这一轮恰好每条笔记都加了星，
 * `totalStar < totalAll` 也会成立（还有主角笔记等没加星的存量），
 * 但那不足以证明筛选真的在起作用。审计刻意留 3 条不加星就是为了这一格。
 */
export function checkStarredIsFilter({ totalAll, totalStarred, minUnstarred = 3 }) {
  const a = Number(totalAll);
  const s = Number(totalStarred);
  return all([
    () =>
      must(
        Number.isFinite(a) && Number.isFinite(s),
        `total 不是数字：全量 ${brief(totalAll)} / 星标 ${brief(totalStarred)}`,
      ),
    () => must(s < a, `starred total=${s} 不小于全量 total=${a} —— 它没在筛`),
    () => must(a - s >= minUnstarred, `没加星的至少该有 ${minUnstarred} 条，实际差 ${a - s}`),
  ]);
}

/** `offset` 越过 `total` 时返回**空页**，而不是报错、也不是绕回第一页。 */
export function checkOffsetBeyondTotal({ status, notes, hasMore }) {
  return all([
    () => same(status, 200, '越界 offset 的状态码'),
    () => same((notes ?? []).length, 0, '越界 offset 的条数'),
    () => same(hasMore, false, '越界 offset 的 hasMore'),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F5-d 中文全文检索 —— 全脚本最值钱的一条                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ★★ 四个中文**两字词**都搜得到本次样本。
 *
 * ## 为什么这条最容易静默坏
 *
 * 没装 libsimple 时分词器退回 trigram，而 trigram 在**结构上**匹配不了长度 < 3
 * 的查询 —— 中文两字词**静默返回 0 条且不报错**（`tools.ts` / `extensions.ts`
 * 里都写着）。也就是说：这个功能坏掉的样子是 HTTP 200 + 空结果，
 * 与"这台机器上确实没有匹配的笔记"**一模一样**。
 *
 * ## ★ 这个函数是整条腿的支点
 *
 * 审计第 13 节会**另起一个 `OPENMEMO_EXT_DIR` 指向空目录的 daemon**，
 * 用**这同一个函数**去量它，要求它红。抽出来之后这件事第一次是字面意义上的
 * 「同一条断言」——抽出来之前那是两段抄写，而两段抄写只要有一段被改动，
 * 那条证明就悄悄变成了"证明另一条断言有牙齿"。
 *
 * @param {{responses: Record<string, object>, words: string[], noteUid: string}} o
 *        `responses[w]` = `/api/search?q=<w>` 的 `{ status, body }`
 */
export function checkChineseSearchFindsSample({ responses, words, noteUid }) {
  const ws = words ?? [];
  return all([
    () => must(ws.length > 0, '一个查询词都没给 —— 这条判据会退化成关于空集的废话'),
    () =>
      must(
        typeof noteUid === 'string' && noteUid.length > 0,
        `没有样本笔记的 uid：${brief(noteUid)}`,
      ),
    () => {
      for (const w of ws) {
        const r = (responses ?? {})[w];
        const st = same(r?.status, 200, `q=${w} 状态码`);
        if (!st.ok) return st;
        const mine = (r?.body?.hits ?? []).filter((h) => h?.noteUid === noteUid);
        if (mine.length === 0) {
          return no(
            `「${w}」搜不到本次样本 —— 多半是 tokenizer 退回了 trigram` +
              `（该词共命中 ${(r?.body?.hits ?? []).length} 条，其中本次样本 0 条）`,
          );
        }
      }
      return yes();
    },
  ]);
}

/**
 * `/api/search` 自报的分词器档位。
 *
 * ⚠️ 键名跟着 T-200 A-2（`ae48f0b`）改过：`modes` 早就不发 `chineseTokenizer`
 * （boolean）了，契约收口成 `tokenizer: 'simple'|'trigram'`。这条腿只在
 * `workflow_dispatch` 手动触发时跑 —— 键名改名落地那一刻起，这条断言就在拿一个
 * daemon 早就不发的旧键名读 `undefined`，理应当场红；但因为没人手动跑这条腿，
 * 直到那次 dispatch 之前没有任何东西说过一句话。
 *
 * F5-d2（主实例，simple）与 MUT-2（变异实例，trigram）共用这一个。
 */
export function checkSearchModes({ modes, expectTokenizer, requireKeyword = false }) {
  return all([
    () =>
      must(
        TOKENIZERS.includes(expectTokenizer),
        `期望的分词器 ${brief(expectTokenizer)} 不在契约的两格里（${TOKENIZERS.join('/')}）` +
          ' —— 判据自己写错了，它会恒红',
      ),
    () => same(modes?.tokenizer, expectTokenizer, 'modes.tokenizer'),
    () => (requireKeyword ? same(modes?.keyword, true, 'modes.keyword') : yes()),
  ]);
}

/**
 * `/api/health` 与 `/api/selfcheck` **也**说分词器是 simple。
 *
 * 三处（search 的 modes、health 的 extensions、selfcheck 的探针）由不同代码路径产出，
 * 所以同时要求它们并不是重复：只中一处说明其中一处漂了，那本身就值得看见。
 *
 * `ok(!!cn, …)` 那一格是**判据本身还在不在**的守卫 —— selfcheck 里那条探针
 * 被删掉时，一个只查 `cn.status === 'ok'` 的实现会因为 `undefined !== 'ok'` 而红，
 * 但红的那句话会指向产品；这里要它说清楚是**判据不见了**。
 */
export function checkTokenizerSelfReport({ healthExtensions, selfcheckChecks, expectTokenizer }) {
  const e = healthExtensions ?? {};
  const cn = (selfcheckChecks ?? []).find((c) => c?.id === CHINESE_SEARCH_CHECK_ID);
  return all([
    () => same(e.tokenizer, expectTokenizer, 'health.db.extensions.tokenizer'),
    () => same(e.libsimple, true, 'health.db.extensions.libsimple'),
    () =>
      must(
        !!cn,
        `/api/selfcheck 里没有 ${CHINESE_SEARCH_CHECK_ID} 这一项 —— **判据本身不见了**` +
          `（共 ${(selfcheckChecks ?? []).length} 项）`,
      ),
    () => same(cn?.status, 'ok', `${CHINESE_SEARCH_CHECK_ID} 状态`),
  ]);
}

/** 变异实例**确实**退化成了 trigram —— 变异体本身成立，否则第 13 节什么都没证明。 */
export function checkTokenizerDegraded({ extensions }) {
  const e = extensions ?? {};
  return all([
    () => same(e.libsimple, false, '变异实例的 libsimple'),
    () => same(e.tokenizer, 'trigram', '变异实例的 tokenizer'),
  ]);
}

/**
 * 那个**静默**：没有 libsimple 时搜索仍然 HTTP 200，一个错都不报。
 *
 * 这条判据钉的不是"产品坏了"，是"**产品坏的时候一声不吭**"——
 * 它是 `checkChineseSearchFindsSample()` 存在的全部理由。
 * 哪天产品改成"分词器退化时明确报错"，这条会红，那时该改的是这条，不是那条。
 */
export function checkSilentDegradation({ responses, words }) {
  const ws = words ?? [];
  return all([
    () => must(ws.length > 0, '一个查询词都没给 —— 这条判据会退化成关于空集的废话'),
    () => {
      for (const w of ws) {
        const r = (responses ?? {})[w];
        const st = same(r?.status, 200, `q=${w} 在变异实例上的状态码`);
        if (!st.ok) return st;
        if (r?.body?.error !== undefined) {
          return no(`q=${w} 居然报错了 —— 那反倒说明它不静默：${brief(r?.body?.error)}`);
        }
      }
      return yes();
    },
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* F5-e 搜索结果直达时间点（?t=）的服务端半条链                                */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * segment 命中带得回**可用**的 `startMs`（`?t=` 的取值来源）。
 *
 * `Number.isInteger` 不是吹毛求疵：`parseSeekParam` 拿到的是 URL 上的字符串，
 * 服务端发一个浮点或字符串过来，前端那半会在解析处静默取到 `NaN`，
 * 表现成"点进去没跳" —— 而这条链的服务端半正是要防这个。
 */
export function checkSegmentHit({ probeWord, hit, hits }) {
  return all([
    () =>
      must(
        typeof probeWord === 'string' && probeWord.length > 0,
        '转写稿里挑不出探针词 —— 这是夹具的前提没造出来（这台机器的转写稿里没有英文长词），' +
          '不是产品坏了；本腿的口径是「前提构造不出来当场判红」',
      ),
    () => must(!!hit, `没有拿到 source=segment 的命中：${brief((hits ?? []).slice(0, 3))}`),
    () => must(Number.isInteger(hit?.startMs), `startMs 不是整数：${brief(hit?.startMs)}`),
    () => must(Number(hit?.startMs) >= 0, `startMs 是负数：${brief(hit?.startMs)}`),
    () =>
      must(typeof hit?.transcriptUid === 'string', `segment 命中没有 transcriptUid：${brief(hit)}`),
  ]);
}

/**
 * 越界边界：`startMs` 不超过这条笔记的 `durationMs`。
 *
 * ⚠️ 上界必须是**正数**：`parseSeekParam` 明写 `durationMs <= 0` 时**不夹取**，
 * 也就是说上界一旦是 0，"越界夹到末尾"这条产品行为在结构上不可能发生 ——
 * 那时下面那格就成了关于空集的废话。所以 `dur > 0` 是这条判据的非空虚前提，
 * 不是顺手多加的一句。
 */
export function checkSeekWithinDuration({ hit, durationMs }) {
  const dur = Number(durationMs ?? 0);
  return all([
    () => must(dur > 0, `durationMs=${brief(durationMs)} —— 上界不存在，越界夹取无从谈起`),
    () => must(!!hit, '没有 segment 命中，这条无从谈起'),
    () =>
      must(
        Number(hit?.startMs) <= dur,
        `命中的 startMs=${brief(hit?.startMs)} 超过了 durationMs=${dur} —— 那样点进去就会被夹到末尾`,
      ),
  ]);
}

/**
 * 媒体未加载完那一档：时长未知时服务端**如实回 0，不编一个数**。
 *
 * 编一个非零上界会让 `parseSeekParam` 把对的 `?t=` 夹坏（夹到一个假的末尾）。
 *
 * ⚠️ 已知弱点（登记，不在这一轮改）：`durationMs` 在库里的**默认值就是 0**，
 * 所以这一格分不开「服务端如实报了未知」和「这一列压根没被写过」。
 * 它挡得住"编一个数"，挡不住"这条路径从来没跑到过"。
 */
export function checkUnknownDurationIsZero({ status, durationMs }) {
  const dur = Number(durationMs ?? 0);
  return all([
    () => same(status, 200, '刚导入时 GET note 的状态码'),
    () =>
      must(
        dur === 0,
        `刚导入的笔记 durationMs=${dur} —— 时长还不该知道。` +
          '编一个非零上界会让 parseSeekParam 把对的 ?t= 夹坏',
      ),
  ]);
}

/**
 * 深链 `/notes/<uid>?t=<ms>` 在包里真的可达（**浏览器导航语义**）。
 *
 * ## 为什么必须模拟地址栏导航
 *
 * `[实测]` 第一版用裸 fetch 打这条深链，拿到 404，一度以为是包里缺网页。
 * **不是，是产品做得对**：SPA 兜底刻意只对真正的导航生效
 * （`server.ts` 看 `sec-fetch-mode: navigate` 或 `Accept: text/html`），
 * 因为"任何无扩展名路径都回 index.html"会把 `/media/../../etc/passwd` 也变成 200,
 * **把本该 404 的东西变成 200 就是在遮蔽后端的拒绝**。
 *
 * ★ **F5-e4 与它的变异证明共用这一个**：变异用**非导航**请求打同一条深链，
 * 必须红 —— 证明上面那个 200 是 SPA 兜底给的，而不是"什么路径都回 200"。
 */
export function checkAppShell({ status, html }) {
  const h = String(html ?? '');
  return all([
    () => same(status, 200, '深链状态码'),
    () =>
      must(
        /<div[^>]+id=["']root["']/.test(h) || h.includes('<script'),
        `返回的不像应用外壳：${brief(h.slice(0, 200))}`,
      ),
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 12. 借了宿主几个 —— 用产品自己的判据                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * **空集守卫**：`/api/selfcheck` 里必须真的有 `tool.*` 那一层。
 *
 * 没有这一句时，拿不到自检结果会让审计打印出
 * 「✅ 产品自己下载并校验的 (0)」「❌ 装不上/不可用 (0)」，并以
 * 「**本轮结论：借了宿主 0 个**」收尾 —— **三个 0 被当成发现报了出来。**
 *
 * 这里没有 PASS 会翻转（那一段只 `say` 不 judge），但**一份会说假话的审计记录，
 * 和一次假绿一样会被引用**：后面读报告的人拿不到"这一轮没测成"这个信息。
 */
export function checkToolProbesUsable({ status, checks }) {
  const all_ = checks ?? [];
  const tools = all_.filter((c) => String(c?.id ?? '').startsWith(TOOL_CHECK_PREFIX));
  return must(
    status === 200 && tools.length > 0,
    `拿不到 ${TOOL_CHECK_PREFIX}* 自检项（HTTP ${brief(status)}，共 ${all_.length} 项、` +
      `${TOOL_CHECK_PREFIX}* ${tools.length} 项）—— 那句「借了宿主 N 个」会变成一句假话`,
  );
}

/**
 * 把 `tool.*` 自检项分成三档：自己装的 / 借宿主 PATH 的 / 装不上。
 *
 * ## 🔴🔴 已知弱点，**判据今天靠的是散文匹配** —— 别以为它可靠
 *
 * Manager 2026-09-06 裁决：**这一条最严重，但不在这一路修**
 * （正解要动 `apps/daemon`，而另一路正在动那儿）。所以这里**只留记号**，
 * 条目在 `scripts/ci/check-pending-claims.mjs`（`tool.* 的"借宿主的"靠散文认`）。
 *
 * 判据是 `status === 'warn' && /PATH/i.test(detail)`，而 `detail` 是 daemon
 * **写给人看的一句中文**（`packages/runtime/src/selfcheck.ts`：
 * 「…（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）」）。
 *
 * **那句话改一个词、或者被翻译，`borrowed` 恒为 0**，审计末尾那句
 * 「本轮结论：借了宿主 0 个」就成了一句假话 —— 而且是**朝着"更干净"的方向**说假话，
 * 没有任何东西会红。`selftest-e2e-notes.mjs` 里印了现场：同一台机器、同样借 1 个，
 * 只改一个词 ⇒ 报「借了宿主 0 个」（真值 1）。
 *
 * ⚠️ 这是「**从散文里推导语义**」那一族，与产品侧靠正则嗅探文案算警告色是同一个病；
 * 只不过这次是**守卫**在嗅散文。本仓已经栽过三次
 * （`unavailableReason` 两处、`先安装 CPU` 那条正则一处）。
 *
 * ⇒ 正解：daemon 给这一档一个**结构字段**（`origin: 'store' | 'bundled' | 'system-path'`），
 *   判据改读结构、删掉这个正则。要动契约，等 owner 排期。
 *
 * ⚠️ 两个方向今天各有一只眼睛，**但都不能替代结构字段**：
 *   · 散文被改写 ⇒ `selftest-e2e-notes.mjs` 的契约漂移守卫红（盯那句中文还在不在）；
 *   · 结构字段落地 ⇒ `check-pending-claims.mjs` 那条红（提醒来删掉这个正则）。
 *   两者都挡不住**语义**漂移（比如那句话仍含 "PATH" 但含义变了）。
 *
 * @returns {{tools: object[], own: object[], borrowed: object[], missing: object[]}}
 */
export function classifyToolChecks(checks) {
  const tools = (checks ?? []).filter((c) => String(c?.id ?? '').startsWith(TOOL_CHECK_PREFIX));
  // 🔴 散文匹配，已知脆弱：daemon 那句中文改一个词，这一档就恒为 0。见上方注释与挂起项。
  const isPathProse = (c) => /PATH/i.test(String(c?.detail ?? ''));
  return {
    tools,
    own: tools.filter((c) => c?.status === 'ok'),
    borrowed: tools.filter((c) => c?.status === 'warn' && isPathProse(c)),
    missing: tools.filter((c) => c?.status === 'fail' || (c?.status === 'warn' && !isPathProse(c))),
  };
}
