/**
 * `e2e-browser-audit.mjs` 里**「点下去有反应吗」那条判据本身** —— 抽出来是为了能对它写证明。
 *
 * ## 为什么非抽不可
 *
 * 抽出来之前，判据是 `clickAndObserve()` 里的一个四项或：
 *
 * ```js
 * reacted: before.url !== after.url || before.fp !== after.fp
 *          || newReqs.length > 0 || newErrs.length > 0
 * ```
 *
 * 它量的是**观测窗里发生过什么**，不是**这一次点击导致了什么** —— 两者只在
 * 「页面自己不动」时才碰巧相等。页面自己一动，这条判据就恒真：
 *
 * | 现场 | 变异体在场（按钮已被弄死） | 窗内观测 | 老判据 |
 * |---|---|---|---|
 * | `[CI 实测 run 31736237514, win32]` | 是 | DOM 自己变了、`/api` 0 条 | **有反应=true** ⇒ 变异存活 |
 * | `[CI 实测 run 31833084492, win32]` | 是 | DOM 自己变了、`/api` 0 条 | **有反应=true** ⇒ 变异存活 |
 * | `[CI 实测 run 31902320145, win32]` | 是 | DOM 自己变了、`/api` 0 条 | **有反应=true** ⇒ 变异存活 |
 * | `[CI 实测 run 31902320145, darwin]` | 是 | DOM 自己变了、`/api` 4 条（全是后台轮询） | **有反应=true** ⇒ 变异存活 |
 * | `[CI 实测 run 31902320145, linux]` | 是 | 恰好全静止 | 有反应=false ⇒ 变异被抓住 |
 *
 * 同一条腿、同一个变异体，判决取决于**后台有没有恰好在那 1.5 秒里动一下**。
 * linux 那格不是它更严，是它更走运 —— 而"走运"在 8-13 起连着三夜没再发生。
 *
 * 同一个缺口在**绿的那些轮**里也一直在，只是没人红：三个平台的 B2 现场都长这样
 * （`[CI 实测 run 31823008501]` 三格逐字相同；⚠️ **不是 31902320145** ——
 * 那一轮 win32 印的是 `有反应 = false`，引用它会让"三平台逐字相同"这句话当场破功。
 * 早先这里就引错了，2026-08-17 复核逐格核出来）：
 *
 * ```
 * ── 「去安装模型」（asr.goInstall）
 *    存在=false 可见=- 禁用=- 文案=""
 *    点击成功=false
 *    URL 变了=false  DOM 变了=true  /api 请求 1 条
 *    **有反应 = true**
 * ```
 *
 * **一个不存在、压根没被点过的按钮，被量成了「点下去有反应」。**
 * 这就是①空转：判据在"什么都没发生"时也成立。
 *
 * ## 修法：把「窗里发生过」换成「这一次点击导致了」
 *
 * 两件事，缺一不可：
 *
 *   ① **空转对照窗**（`ambient`）：点之前先量**同样长**的一段、**什么都不点**。
 *      那一段里页面自己发的请求、自己改的 DOM，一律**不算**点击的反应。
 *   ② **该发生的那件事**（`expectApi`）：对有名有姓的按钮，写明"点它必须发出哪一条
 *      请求"。后台轮询发的是别的端点，凑不出这一条 —— 于是判决不再取决于运气。
 *
 * ⚠️ ② **不是**钉住变异体的机制。变异体用的是捕获阶段 `stopImmediatePropagation`，
 * 而这里钉的是**产品的契约**（「点『立即测速』必须去测速」）。换一种弄死按钮的办法
 * （删 onClick、`pointer-events:none`、handler 里 return）它照样红 —— 因为那条请求
 * 一样发不出来。判据钉的是"该发生的事没发生"，不是"我知道你是怎么坏的"。
 *
 * ⚠️ **未捕获异常仍然只算「有反应」的一格，不算「该发生的事发生了」。** 反方向的假绿
 * （v0.7.3 抓到过一条：变异体抛了超时，而框架把任何抛出都读成"如期变红"）就是从
 * "把炸了当成红"来的。所以 `judgeDeadButton()` 要求 `reacted && expected === 'hit'`
 * **两条同时成立**才判"活着" —— 光有异常凑不出 `hit`。
 *
 * 证明在 `scripts/ci/selftest-e2e-browser.mjs`：把这里的两条修法逐条抽掉，那边当场红。
 */

/**
 * 一条 `page.on('request')` 记录（`"METHOD https://host/path?query"`）
 * 归一成**方法 + 路径**的键。
 *
 * 去掉 query 是刻意的：后台轮询的 `?role=all&lang=zh` 每轮都可能不同，
 * 带着 query 比会让"同一条轮询"看起来像"一条新请求"，空转对照窗就白测了。
 */
export function requestKey(entry) {
  const s = String(entry ?? '');
  const sp = s.indexOf(' ');
  if (sp < 0) return s;
  const method = s.slice(0, sp);
  const url = s.slice(sp + 1);
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    // 不是绝对 URL（相对路径 / 空串）：砍掉 query 就当路径用。
    const q = url.indexOf('?');
    path = q < 0 ? url : url.slice(0, q);
  }
  return `${method} ${path}`;
}

/** 只留 `/api/` 的那些，并归一成键（去重后返回，顺序保持首次出现）。 */
export function apiKeys(entries) {
  const out = [];
  for (const e of entries ?? []) {
    if (!String(e ?? '').includes('/api/')) continue;
    const k = requestKey(e);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * 「这一次点击有反应吗」。
 *
 * `obs`（全是字符串/布尔/数组，§8：绝不把 DOM 节点带进来）：
 *   · `clicked`        —— 这一次**真的点到了**吗（存在 + 可见 + 未禁用 + click 没抛）
 *   · `urlChanged` / `domChanged` —— 点击窗（t1→t2）里的对比
 *   · `apiRequests`    —— 点击窗里的 `/api` 请求（原始 `"METHOD url"` 记录）
 *   · `newPageErrors`  —— 点击窗里新增的未捕获异常
 *   · `ambient`        —— 空转对照窗（t0→t1，**没点**）：`{ domChanged, apiRequests }`；
 *                         `null` = 这一次没测对照窗（横扫那 40 个按钮就是这样）
 *
 * 返回 `{ reacted, why, novelApi, domCredible }`。
 */
export function judgeReaction(obs) {
  const clicked = obs?.clicked === true;
  const urlChanged = obs?.urlChanged === true;
  const domChanged = obs?.domChanged === true;
  const errs = obs?.newPageErrors ?? [];
  const windowApi = apiKeys(obs?.apiRequests);
  const ambient = obs?.ambient ?? null;

  /*
   * ★ ①空转闸：**没点到就没有反应可言**。
   *   老判据在这里恒真（页面自己在动），于是"按钮根本不在页面上"被印成
   *   "点下去有反应"。三个平台的绿轮里都躺着这一句（见文件头那段现场）。
   */
  if (!clicked) {
    return {
      reacted: false,
      why: '压根没点到它（不存在 / 不可见 / 被禁用 / click 抛了）—— 这一格不许算成"有反应"',
      novelApi: [],
      domCredible: false,
    };
  }

  const ambientApi = ambient ? apiKeys(ambient.apiRequests) : [];
  const novelApi = windowApi.filter((k) => !ambientApi.includes(k));
  /*
   * 对照窗里页面自己就在改 DOM ⇒ 这一格**不能**再当成点击的反应。
   * 它不是"判成没反应"，是"这一格量不出因果，弃权" —— 其余三格照旧作数。
   */
  const domCredible = domChanged && !(ambient && ambient.domChanged === true);

  const hits = [];
  if (urlChanged) hits.push('地址栏变了');
  if (novelApi.length > 0) hits.push(`发出了对照窗里没有的请求 ${novelApi.length} 条`);
  if (errs.length > 0) hits.push(`出现未捕获异常 ${errs.length} 条`);
  if (domCredible) hits.push('DOM 变了（且对照窗里页面是静止的）');

  const why =
    hits.length > 0
      ? hits.join('；')
      : domChanged && !domCredible
        ? '四格全空：DOM 是变了，但**空转对照窗里它自己也在变** —— 这一格量不出因果'
        : '四格全空：URL 没变、没发新请求、没报错、DOM 没变';

  return { reacted: hits.length > 0, why, novelApi, domCredible };
}

/**
 * 「点下去，**该发生的那件事**发生了吗」。
 *
 * `obs.expectApi` 形如 `'POST /api/models/sources/probe'`（`requestKey()` 的形状）。
 * 返回 `'none' | 'hit' | 'miss' | 'ambiguous'`：
 *
 *   · `none`      —— 这个按钮没写明该发生什么（横扫里的匿名按钮）
 *   · `ambiguous` —— **空转对照窗里页面自己就在发这条请求** ⇒ 这一轮量不出因果。
 *                    这是第三态，调用方必须报"无从判断"，**不许**记成通过，
 *                    也**不许**记成"变异被抓住"。
 *   · `hit` / `miss`
 */
export function judgeExpectedEffect(obs) {
  const expect = obs?.expectApi ?? null;
  if (!expect) return { verdict: 'none', why: '这个按钮没写明"该发生什么"' };
  const ambient = obs?.ambient ?? null;
  if (ambient && apiKeys(ambient.apiRequests).includes(expect)) {
    return {
      verdict: 'ambiguous',
      why: `空转对照窗里页面自己就发了 ${expect} —— 这一轮分不清是点击导致的还是它自己发的`,
    };
  }
  const seen = apiKeys(obs?.apiRequests).includes(expect);
  return {
    verdict: seen ? 'hit' : 'miss',
    why: seen ? `点击窗里发出了 ${expect}` : `点击窗里**没有** ${expect}`,
  };
}

/**
 * 有名有姓的按钮的合成判决：**它是活的，还是死的？**
 *
 * `alive` 要**两条同时成立**：
 *   ① `judgeReaction()` 说有反应（老判据，一个字没放松，只是不再把空转算进去）；
 *   ② `judgeExpectedEffect()` 命中（该发生的那件事真的发生了）。
 *
 * ⚠️ 为什么两条都要：
 *   · 只要 ① ⇒ 后台轮询就能凑出"活着"（就是 8-13 起那三夜的假绿）；
 *   · 只要 ② ⇒ 请求发出去了但界面一动不动也算"活着"，而那正是用户报的另一种
 *     "点了没反应"（B5 那条：请求发了、界面静默吞掉）。
 *
 * ⚠️ 未捕获异常只能满足 ①，满足不了 ② —— 所以"腿炸了"凑不出"活着"，
 * 也凑不出"如期变红"（那是反方向的假绿，v0.7.3 抓到过一条）。
 */
export function judgeDeadButton(obs) {
  const reaction = judgeReaction(obs);
  const expected = judgeExpectedEffect(obs);
  if (expected.verdict === 'ambiguous') {
    return { verdict: 'undecidable', why: expected.why, reaction, expected };
  }
  if (expected.verdict === 'none') {
    return {
      verdict: reaction.reacted ? 'alive' : 'dead',
      why: reaction.why,
      reaction,
      expected,
    };
  }
  if (reaction.reacted && expected.verdict === 'hit') {
    return { verdict: 'alive', why: `${reaction.why}；${expected.why}`, reaction, expected };
  }
  return {
    verdict: 'dead',
    why: !reaction.reacted ? reaction.why : expected.why,
    reaction,
    expected,
  };
}

/**
 * 「立即测速」点下去**该发生的那件事**。
 *
 * ⚠️ 这个字面量与产品的契约绑在一起：`packages/shared/src/api.ts` 的 `ENDPOINTS`
 * 里那条 `probeSources`（网页侧的调用点在 `apps/web/src/features/models/api.ts`）。
 * `.mjs` 拿不到 TS 的类型检查，所以 `selftest-e2e-browser.mjs` 里有一条
 * **契约漂移守卫**：这条 `方法 + 路径` 必须真的还在 `ENDPOINTS` 里。
 * 端点一改而这里没跟，判据会退化成**恒不命中 ⇒ 恒红**，
 * 而恒红的门等于没有门（本仓在 `KNOWN_DEAD` 那儿已经写过同一句）。
 */
export const PROBE_EFFECT = 'POST /api/models/sources/probe';
