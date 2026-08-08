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

import { availableModes, effectiveMode, missingModes, normalizeModes } from './modes';

/**
 * ★ 取证：live `GET /api/search?q=x`（`progress-audit` 抓的那份，逐字粘贴）。
 * `rest/search.ts` 的 `modeReport()` 今天就长这样。
 */
const LIVE_MODES = {
  keyword: true,
  chineseTokenizer: true,
  semantic: false,
  semanticReason: 'sqlite-vec 已加载，但尚无 embedding 生成环节（链路未接通）',
  hybrid: false,
};

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

  it('★ 服务端给的原因被原样留下来（界面要说的就是这句，不许自己编）', () => {
    const m = normalizeModes(LIVE_MODES);
    assert.equal(m.semanticReason, LIVE_MODES.semanticReason);
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
    assert.equal(normalizeModes({}).semanticReason, null);
    // 探测还没回来（modes 为 undefined）时也不许把三档摆出来
    assert.deepEqual(availableModes(undefined), ['keyword']);
  });

  it('非布尔的脏值不许被当成"可用"', () => {
    const m = normalizeModes({ keyword: 'yes', semantic: 1, hybrid: 'true', semanticReason: 42 });
    assert.deepEqual(availableModes(m), ['keyword'], '字符串 "true" 被当成了真');
    assert.equal(m.semanticReason, null, '非字符串的 reason 被原样带到界面上');
  });
});
