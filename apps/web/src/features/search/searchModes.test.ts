/**
 * T-164 ⑤ —— **搜索的三档模式选择器是装饰品**。
 *
 * ## 缺陷原状（`progress-audit §4⑤` 实测）
 *
 * - `SearchPage.tsx:12` 的 `MODES` 是**写死常量**，恒渲染三个 tab，默认停在 `hybrid`；
 * - `apps/daemon/src/http/rest/search.ts` **从头到尾不读 `mode`** —— 三档返回同一份关键词结果；
 * - `features/search/api.ts` 的 `select: (d) => d.hits` 把服务端的
 *   `modes` / `semanticReason` **整个丢掉**，而 live 响应里那两个字段一直是有的：
 *   `{semantic:false, semanticReason:"sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）"}`。
 * - `SearchPage.tsx:24-25` 的注释白纸黑字写着「向量不可用时 **UI 相应隐藏后两档**」——
 *   **那段隐藏逻辑不存在。**
 *
 * 用户切到「语义」，以为换了检索方式，界面一个字都不说。
 *
 * ## 这些断言为什么钉得住（先读断言，别读名字）
 *
 * 缺陷版本**恒渲染三个 tab**，所以任何「页面上有三个 tab」「有『语义』字样」之类的断言
 * 在缺陷版本下都是绿的 —— 那是本轮反复踩到的那一类（`row.textContent.includes('2')`
 * 被 `127.0.0.1` 里的 `2` 匹中）。
 * 所以这里钉的是两件**只有修好了才成立**的事：
 *   ① 服务端说没有的档，`availableModes` 里就不许出现；
 *   ② 请求里**实际发出去**的那一档，必须是服务端真的提供的那一档。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SEMANTIC_UNAVAILABLE_KEYS,
  availableModes,
  effectiveMode,
  missingModes,
  normalizeModes,
} from './modes';

/**
 * ★ 取证：live `GET /api/search?q=x`（`progress-audit` 抓的那份）。
 * `rest/search.ts` 的 `modeReport()` 今天就长这样。
 *
 * ⚠️ #112 第 11 处改了 `semanticReason` 这一格的**形状**：从一句中文散文换成
 * 判别式联合。`chineseTokenizer` 那个旧键名照旧留在夹具里 —— 它是另一条腿
 *（T-200 A-2）的取证，daemon 曾经真的发过它。
 */
const LIVE_MODES = {
  keyword: true,
  chineseTokenizer: true,
  semantic: false,
  semanticReason: { kind: 'vector_extension_not_loaded' },
  hybrid: false,
};

/**
 * **缺陷原状**：daemon 上一版在这一格里发的就是这句中文散文。
 *
 * 留着它当**反向样本**，而不是当"live 值" —— 上一版这份用例把它当作正确答案钉住
 *（`assert.equal(m.semanticReason, LIVE_MODES.semanticReason)`），
 * 那正是「把缺陷钉成正确」：它要求前端把一句中文原样带到界面上，
 * 而界面把它插进 `search.modesUnavailable` 那句**英文**里 ——
 * 英文用户读到的逐字是 `Semantic search is unavailable: sqlite-vec 未加载`。
 */
const OLD_PROSE_REASON = 'sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）';

describe('T-164 ⑤ —— 搜索档位由服务端说了算', () => {
  it('★ 真实响应喂进去：只剩「关键词」一档，语义/混合都不许出现', () => {
    const m = normalizeModes(LIVE_MODES);
    assert.deepEqual(
      availableModes(m),
      ['keyword'],
      '服务端明说 semantic/hybrid 为假，它们却仍然可选 —— 用户点了会拿到关键词结果而不被告知',
    );
    assert.deepEqual(missingModes(m), ['hybrid', 'semantic']);
  });

  it('★ 服务端说的是**哪一格**，那一格必须原样留下来（界面按它查词条，不许自己编）', () => {
    /*
     * ⚠️ 这条断言钉的是**结构**，不是某一句话。
     *
     * 上一版它是 `assert.equal(m.semanticReason, '…sqlite-vec 已加载…')` ——
     * 把 daemon 那句中文钉成了"正确答案"。换成新的英文词条再钉一遍是**同一条断言换个串**：
     * 它照样会在有人把措辞搬回 daemon 时保持绿灯，也照样在改一个字时莫名其妙地红。
     * 措辞该不该是英文由渲染那一层的用例判（`apps/web/src/test/proxyAndSearchI18n.test.tsx`），
     * 这里只判「成因有没有原样到手」。
     */
    const m = normalizeModes(LIVE_MODES);
    assert.deepEqual(m.semanticReason, { kind: 'vector_extension_not_loaded' });
  });

  it('★ URL 里写着 mode=semantic 时，真正发出去的是 keyword —— 不许把请求参数原样转发', () => {
    /*
     * 这一条钉的是最要命的那一格：缺陷版本会把 `mode=semantic` 发出去，
     * 服务端不读它、照样回关键词结果，而界面把「语义」那个 tab 高亮着。
     * 收藏夹里的旧链接、手改地址栏都会走到这里。
     */
    const m = normalizeModes(LIVE_MODES);
    assert.equal(effectiveMode('semantic', m), 'keyword');
    assert.equal(effectiveMode('hybrid', m), 'keyword');
    assert.equal(effectiveMode(null, m), 'keyword');
  });

  it('★ 服务端真的提供三档时，三档都要回来 —— 修法不能是"永远只给关键词"', () => {
    /*
     * 阳性对照。少了它，把 `availableModes` 写成 `return ['keyword']` 也能让上面三条全绿，
     * 而那是"把选择器焊死"，不是"如实反映服务端"。
     */
    const all = normalizeModes({
      keyword: true,
      semantic: true,
      hybrid: true,
      semanticReason: null,
    });
    assert.deepEqual(availableModes(all), ['hybrid', 'keyword', 'semantic']);
    assert.deepEqual(missingModes(all), []);
    assert.equal(effectiveMode('semantic', all), 'semantic');
    assert.equal(effectiveMode(null, all), 'hybrid');
  });

  it('响应里压根没有 modes 时按"只有关键词"处理（宽松的默认在这里恰好是撒谎的那个）', () => {
    assert.deepEqual(availableModes(normalizeModes(undefined)), ['keyword']);
    assert.deepEqual(availableModes(normalizeModes({})), ['keyword']);
    // 服务端没说为什么 ⇒ `null`。界面据此说「服务端未说明原因」，而不是替它编一个成因。
    assert.equal(normalizeModes({}).semanticReason, null);
    // 探测还没回来（modes 为 undefined）时也不许把三档摆出来
    assert.deepEqual(availableModes(undefined), ['keyword']);
  });

  it('非布尔的脏值不许被当成"可用"', () => {
    const m = normalizeModes({ keyword: 'yes', semantic: 1, hybrid: 'true', semanticReason: 42 });
    assert.deepEqual(availableModes(m), ['keyword'], '字符串 "true" 被当成了真');
    assert.equal(m.semanticReason, null, '不成形状的 reason 被原样带到界面上');
  });
});

/**
 * ★★ #112 第 11 处 —— **「为什么没有语义检索」这一格是成因，不是一句话。**
 *
 * ## 缺陷原状（英文界面，逐字）
 *
 * ```
 * Semantic search is unavailable: sqlite-vec 未加载
 * ```
 *
 * daemon 在 `rest/search.ts` 把理由拼成**中文散文**，`SearchPage` 把它插进
 * `search.modesUnavailable` 这句**英文**的 `{{reason}}` 里。
 * 它符合「CJK 只出现在数据里」的表面判据（`en.json` 里一个汉字都没有），
 * **但对英文用户就是半句中文**。
 *
 * ## 这一组钉的是什么（先读断言，别读名字）
 *
 * `normalizeModes` 面对**成形的 / 不成形的 / 没有的**输入分别做什么。
 * 上一版这几条钉的是「那句中文被原样留下来了」—— **那是把缺陷钉成正确**：
 * 它要求前端把服务端那句中文带到界面上，正是要修的那件事本身。
 * 而只把断言换成新的英文串是**同一条断言换个字符串**：措辞归 locale，
 * 这一层压根不该知道那句话长什么样。
 */
describe('#112 ⑪ semanticReason：成因归服务端，措辞归 locale', () => {
  it('★ 前提自检：总表里那两格就是"运行期认得哪几格"的名单', () => {
    /*
     * 少了这条，下面两组（认得的收下 / 认不出的丢掉）会失去参照：
     * 把 `normalizeModes` 写成"永远返回 null"能让"认不出就 null"那几条全绿。
     */
    assert.deepEqual(
      Object.keys(SEMANTIC_UNAVAILABLE_KEYS).sort(),
      ['no_embedding_stage', 'vector_extension_not_loaded'],
      '契约里增/改了一格成因，而总表没跟上 —— 那一格在界面上会没有话说',
    );
    for (const [kind, key] of Object.entries(SEMANTIC_UNAVAILABLE_KEYS)) {
      assert.ok(key.startsWith('search.semanticUnavailable.'), `「${kind}」指向的不是词条：${key}`);
    }
  });

  it('★★ 认得的每一格都被原样收下（阳性对照：没有它，下面几条靠"永远 null"就能全绿）', () => {
    for (const kind of Object.keys(SEMANTIC_UNAVAILABLE_KEYS)) {
      const m = normalizeModes({ ...LIVE_MODES, semanticReason: { kind } });
      assert.deepEqual(
        m.semanticReason,
        { kind },
        `服务端说了「${kind}」，前端却没收下 —— 界面只能退成"服务端未说明原因"`,
      );
    }
  });

  it('★★ 缺陷原状：一句中文散文**不是**成因，必须落到"服务端没说为什么"', () => {
    /*
     * 这是本条的定义性断言：把修改删掉（`typeof === 'string' ? 原样带走 : null`），
     * 它当场红 —— 因为那时这句中文会被原样带到界面上，插进一句英文里。
     */
    const m = normalizeModes({ ...LIVE_MODES, semanticReason: OLD_PROSE_REASON });
    assert.equal(m.semanticReason, null, `旧 daemon 那句中文散文被当成了成因：${OLD_PROSE_REASON}`);
  });

  it('★ 认不出的成因也归 null —— 不猜一格（猜一格 = 说一句我们并不知道的话）', () => {
    const rejected: unknown[] = [
      { kind: 'quantum_flux' }, // 将来某个新 daemon 发的新格，我们这一版没有话说
      { kind: 'toString' }, // 原型链上的名字不算"总表里有"
      { kind: 42 },
      { kind: null },
      {},
      [],
      42,
      'vector_extension_not_loaded', // 光是名字对，形状不对也不算
      null,
    ];
    assert.ok(rejected.length >= 9, '样本被缩水了 —— 这一组会漏掉半数分支');
    for (const raw of rejected) {
      const got = normalizeModes({ ...LIVE_MODES, semanticReason: raw }).semanticReason;
      assert.equal(
        got,
        null,
        `不该认得的输入被收下了：${JSON.stringify(raw)} → ${JSON.stringify(got)}`,
      );
    }
  });

  it('★ 收下来的是**成因**，不是字符串 —— 类型换了形状，运行期也得跟着换', () => {
    /*
     * 反向鉴别：如果哪天有人把 `semanticReason` 改回 `string` 直通，
     * 上面那条"中文散文归 null"仍可能被一个"只挡中文"的补丁骗过去（比如按正则过滤汉字），
     * 而这条要求它**根本不是字符串** —— 界面据此查表，字符串查不出词条。
     */
    const m = normalizeModes(LIVE_MODES);
    assert.equal(typeof m.semanticReason, 'object');
    assert.ok(
      m.semanticReason !== null &&
        Object.prototype.hasOwnProperty.call(SEMANTIC_UNAVAILABLE_KEYS, m.semanticReason.kind),
      '收下来的成因在总表里查不到词条 —— 界面会渲染成一段空白',
    );
  });
});

describe('★ T-200 A-2 分词降级：同一个事实不许两处分叉', () => {
  /*
   * 事故形状：daemon 发的键叫 `chineseTokenizer`（boolean），契约声明的却是
   * `tokenizer: 'simple'|'trigram'` —— **契约那个键全仓没有生产者**，
   * 而 `normalizeModes` 两个都没读。于是在一台 libsimple 没加载的机器上：
   *   · 就绪横幅 / 自检页（读 `/api/health` 的另一条路）：**明说降级了**
   *   · 搜索页：关键词 tab 正常亮着、`semanticReason` 只解释向量路
   *     ⇒ **用户搜「人工智能」搜不到，却被告知检索一切正常**
   */
  it('★ 服务端说 trigram ⇒ 前端必须读到 trigram（这是界面能说出降级的前提）', () => {
    assert.equal(normalizeModes({ keyword: true, tokenizer: 'trigram' }).tokenizer, 'trigram');
    assert.equal(normalizeModes({ keyword: true, tokenizer: 'simple' }).tokenizer, 'simple');
  });

  it('★ 缺省是 simple（不降级）—— 这里"严格"会凭空给好机器扣一顶帽子', () => {
    /*
     * 方向与 semantic/hybrid 相反，是刻意的：
     * 那几个宽松会**把不存在的能力摆出来给人点**；
     * 这个严格会**对一台好机器说它搜不到中文**。
     * 判据仍是那句：**哪个默认值会让界面说一句不成立的话。**
     */
    assert.equal(normalizeModes({}).tokenizer, 'simple');
    assert.equal(normalizeModes(undefined).tokenizer, 'simple');
    // 脏值不许被读成降级
    assert.equal(normalizeModes({ tokenizer: 'nonsense' }).tokenizer, 'simple');
    assert.equal(normalizeModes({ tokenizer: 42 }).tokenizer, 'simple');
  });

  it('★ 旧键名 `chineseTokenizer` 不再被认 —— 收口到契约那一侧', () => {
    /*
     * 这条钉的是"分叉真的收掉了"：如果哪天有人把 daemon 改回去发 boolean，
     * 前端会拿到缺省的 `'simple'`，界面**不会**说降级 —— 而这条用例会红，
     * 因为它要求 `chineseTokenizer:false` 不产生 `trigram`。
     * 换句话说：**它逼着两侧用同一个键名，而不是各自兼容对方。**
     */
    assert.equal(normalizeModes({ chineseTokenizer: false }).tokenizer, 'simple');
  });
});
