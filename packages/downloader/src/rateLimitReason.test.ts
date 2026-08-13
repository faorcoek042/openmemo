/**
 * `httpFailureReason()` 的守卫 —— **一句「问不到上游」和一句「等 3 分钟再试」，
 * 对用户的价值差一个数量级**，而这里钉的就是那个差别。
 *
 * 背景（#100）：上游**每一次响应**都带 `x-ratelimit-remaining`，而我们原来只在
 * 403/429 时把它变成一句写死的 `rate limited by upstream (HTTP 403)` ——
 * 那句话既**不可执行**（不知道等多久），又在「有配额却 403」时**说了假话**。
 *
 * 这份用例分四组，前三组对应本条的三条要求：
 *   ① 说得出等多久时，真的把那个数**交出去**；
 *   ② **配额与成败不许塌成一件事**（含反向鉴别：有配额的 403 不许被叫成限流）；
 *   ③ **算不出时间就不许编时间**；
 *   ④ #106：**这一格里不许出现中文**。
 *
 * ## ⚠️ #106 把这份用例的断言换了一层，**要钉的性质一条没少**
 *
 * 上一版每一条断言都是 `assert.match(r, /约 3 分钟后恢复/)` —— 读的是
 * daemon 拼好的**中文句子**。那句话现在整句搬去了 `apps/web` 的两份 locale
 * （`components.reason.failed.*`），因为它会被插进一句英文里给英文用户看。
 *
 * 所以这里改钉**结构**：`kind` 落在哪一格、毫秒数是多少。而"这句话读起来
 * 到底说没说清等多久"那一层**没有丢，只是搬了家** ——
 * `apps/web/src/test/components.test.tsx` 里那组用例断的是**渲染出来的英文**，
 * 比在这里读一句中文更接近用户。两层缺一不可：
 *   · 只留这里 ⇒ 结构对了、界面上却可能是一段空白；
 *   · 只留那里 ⇒ 「算不出时间就不说时间」这条会退化成前端的一个 `?:`。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { httpFailureReason, type RateLimitSnapshot } from './upstream.js';

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);

const snap = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
  remaining: null,
  limit: null,
  resetAtMs: null,
  retryAfterMs: null,
  resource: null,
  ...over,
});

/**
 * `[实测 2026-08-12]` 一个**真的**被限流的 403 长这样（同机真请求抓下来的头）：
 *
 *   x-ratelimit-limit:10  x-ratelimit-remaining:0  x-ratelimit-reset:1786528992
 *   x-ratelimit-resource:search   （**没有** retry-after）
 *
 * 用真形状而不是我想象的形状 —— 两条会写错的细节都在这里面：
 * `limit` 不是常数 60（这个桶是 10），主配额限流**不带** `retry-after`。
 */
const REAL_403 = snap({
  remaining: 0,
  limit: 10,
  resetAtMs: NOW + 3 * 60_000,
  resource: 'search',
});

describe('① 说得出等多久，就真的把那个数交出去', () => {
  it('主配额用尽 + 有 reset ⇒ 落在带恢复时间的那一格，且毫秒数是算出来的', () => {
    const r = httpFailureReason(403, REAL_403, NOW);
    assert.deepEqual(r, {
      kind: 'quota_exhausted',
      resetInMs: 3 * 60_000,
      resource: 'search',
      limit: 10,
    });
  });

  it('把上游读到的 limit 照传，**不写死 60**（这个桶实测是 10）', () => {
    const r = httpFailureReason(403, REAL_403, NOW);
    assert.equal(r.kind === 'quota_exhausted' && r.limit, 10);
    assert.equal(
      JSON.stringify(r).includes('60'),
      false,
      `把文档里的 60 写死进来了：${JSON.stringify(r)}`,
    );
  });

  it('不足一分钟时**照旧交真实毫秒数**，不在这一侧提前抹成 0', () => {
    /*
     * ★ 这一条以前断的是「说『约 40 秒』而不是『0 分钟』」。取整现在归 web
     * （`approxEta`，中英各有说法），所以这一侧要守的性质变成了
     * **别提前把它抹掉** —— 交出去的必须是那 40 000 毫秒本身。
     * 「不许显示成 0 分钟」那一条钉在 `components.test.tsx` 的渲染用例里。
     */
    const r = httpFailureReason(403, snap({ remaining: 0, resetAtMs: NOW + 40_000 }), NOW);
    assert.equal(r.kind === 'quota_exhausted' && r.resetInMs, 40_000);
  });

  it('次级限流带 retry-after 时用它（主配额限流实测不带这个头）', () => {
    const r = httpFailureReason(429, snap({ retryAfterMs: 90_000 }), NOW);
    assert.deepEqual(r, { kind: 'rate_limited', status: 429, retryAfterMs: 90_000 });
  });
});

describe('② 配额与成败是两件事，不许塌成一个', () => {
  /*
   * ★★ 本组的反向鉴别腿。403 **不等于**限流：上游对私有/改名仓库、滥用保护也回 403。
   * 原来那句写死的 "rate limited by upstream (HTTP 403)" 在这一格上是**假话** ——
   * 在没有证据的地方给了一个具体的错误原因。
   */
  it('有配额却 403 ⇒ 落在「不是配额问题」那一格，不许叫它限流', () => {
    const r = httpFailureReason(403, snap({ remaining: 55, limit: 60, resource: 'core' }), NOW);
    /*
     * `deepEqual` 就是这一组要的反向鉴别，而且比 `assert.equal(r.kind !== 'quota_exhausted')`
     * 更强：它把整个值钉死，所以「有配额的 403 被说成配额用尽」这件事**表达不出来**。
     * 上一版在这里另写了一条 `不许叫它限流` 的否定断言 —— 现在那条会被 `tsc` 判成
     * 「两个字面量类型没有交集」而编译不过，**因为它已经被上面这一行蕴含了**。
     */
    assert.deepEqual(r, { kind: 'http_error_not_quota', status: 403, remaining: 55 });
  });

  it('配额充足的 403 也不许因为"还剩很多"就把状态码丢掉', () => {
    const r = httpFailureReason(403, snap({ remaining: 55 }), NOW);
    // 它仍然是一次失败，状态码必须留在结构里，不能被配额那一格盖过去
    assert.equal(r.kind === 'http_error_not_quota' && r.status, 403);
  });

  it('remaining 为 0 但请求**成功**时压根不经过这里 —— 成功路径不调用本函数', () => {
    /*
     * 这一条钉的是形状而不是字符串：`httpFailureReason` 的第一个入参是 `status`，
     * 一次成功的请求没有"失败状态码"可传，所以它在类型上就进不来。
     * `remaining: 0` 的成功请求就是成功的 —— 那个 0 说的是**下一次**。
     * （构造点在 `getJson`：只有 `res.ok === false` 的分支才会抛。）
     */
    assert.equal(typeof httpFailureReason, 'function');
    assert.equal(httpFailureReason.length, 3, '入参少了一个 —— status 与配额必须各占一格');
  });
});

describe('③ 算不出时间就不许编时间', () => {
  /*
   * ★★ 这条要求现在**由类型守着**，不只由这几条断言守着：只有 `quota_exhausted`
   * 那一格才有 `resetInMs`，而它是 `number`，不是 `number | null`。
   * 也就是说"配额用尽但不知道什么时候恢复"在类型上**写不出一个时间**。
   */
  it('配额用尽但没有 reset ⇒ 落在没有时间那一格，结构里一个毫秒数都没有', () => {
    const r = httpFailureReason(403, snap({ remaining: 0, limit: 60 }), NOW);
    assert.deepEqual(r, { kind: 'quota_exhausted_no_reset', resource: null, limit: 60 });
    assert.equal('resetInMs' in r, false, `凭空带上了一个等待时间：${JSON.stringify(r)}`);
  });

  it('reset 已经是过去时 ⇒ 同样不给时间（不许出现一个负的毫秒数）', () => {
    const r = httpFailureReason(403, snap({ remaining: 0, resetAtMs: NOW - 3 * 60_000 }), NOW);
    assert.equal(r.kind, 'quota_exhausted_no_reset');
    assert.equal('resetInMs' in r, false, `算出了负数还照传：${JSON.stringify(r)}`);
  });

  it('上游一个配额头都没给（npm / HuggingFace 就是这样）⇒ 如实说判断不了', () => {
    const r = httpFailureReason(403, snap(), NOW);
    assert.deepEqual(r, { kind: 'http_error_no_quota_info', status: 403 });
  });
});

describe('④ #106：这一格里不许出现中文', () => {
  /*
   * ★★ 这一条是**这次修复的定义**，抄 `79cc117` 钉 `AdvisoryUndeterminedReason`
   * 的那一条：`UpstreamFailure` 会被 `apps/web` 插进一句**英文**里
   * （`components.upstream.failed`），所以它里面出现的任何汉字，
   * 都会在英文界面上变成半句中文。
   *
   * ⚠️ 判据是「整个结构序列化之后不含 CJK」，不是「某个字段不含」——
   * 将来给某一格加一个中文参数（比如把包名的中文显示名塞进来），这条会红。
   *
   * ⚠️ **前提检查在下面第二条**：如果这个正则本身抓不到汉字，
   * 上面那一整组就是空转。
   */
  /**
   * CJK 表意文字 + CJK 标点（、。）+ 全角形式（（），）。
   *
   * ⚠️ **写 `\u` 转义，不写字面量**：范围首字符是 U+3000 全角空格，
   * 直接写进正则会被 eslint 的 `no-irregular-whitespace` 判红，
   * 而且在 diff 里根本看不出来。（同一条 `components.test.tsx` 里也记着。）
   */
  const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

  it('前提检查：这条正则真的抓得到汉字与全角标点（否则本组全是空转）', () => {
    assert.equal(CJK.test('上游限流（HTTP 403）'), true);
    assert.equal(CJK.test('HTTP 403 (rate limited)'), false);
  });

  it('每一种失败原因序列化之后都不含 CJK', () => {
    const cases: RateLimitSnapshot[] = [
      REAL_403,
      snap({ retryAfterMs: 90_000 }),
      snap({ remaining: 0, limit: 60 }),
      snap({ remaining: 0, resetAtMs: NOW - 1 }),
      snap({ remaining: 55, limit: 60, resource: 'core' }),
      snap(),
    ];
    assert.ok(cases.length >= 6, '样本少于六种，覆盖不到全部分支');
    for (const s of cases) {
      for (const status of [403, 429]) {
        const json = JSON.stringify(httpFailureReason(status, s, NOW));
        assert.equal(CJK.test(json), false, `失败原因里混进了中文：${json}`);
      }
    }
  });
});
