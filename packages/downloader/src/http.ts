/**
 * HTTP helpers: metadata probing, Range support detection, retry policy.
 *
 * Verified behaviours these are written against (R-04 §2.2, measured with curl):
 *   - HF `/resolve/` returns 302 to a *signed, expiring* CloudFront URL. That URL must
 *     NOT be cached across retries — we always re-resolve. (Ollama's download.go has
 *     dedicated redirect-with-backoff logic for the same reason.)
 *   - `x-linked-size` and `x-linked-etag` come back on the 302 itself, so one HEAD gives
 *     both size and SHA-256 without following the redirect.
 *   - `x-linked-etag` == the tree API's `lfs.oid` == the file's SHA-256. Cross-verified.
 *   - Range requests return 206 with `content-range` at both offset 0 and mid-file.
 *   - Anonymous rate limits, from live response headers:
 *       "api"       q=500  w=300s
 *       "resolvers" q=3000 w=300s
 *   - Gated repos answer 401 with `x-error-code: GatedRepo`.
 */

export interface RemoteFileInfo {
  /** Content length in bytes, or null if the origin would not say. */
  sizeBytes: number | null;
  /** SHA-256 from `x-linked-etag` when the origin is HF/ModelScope, else null. */
  sha256: string | null;
  etag: string | null;
  lastModified: string | null;
  acceptRanges: boolean;
  status: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | 'GATED_REPO'
      | 'RATE_LIMITED'
      | 'NOT_FOUND'
      | 'PROVIDER_UNREACHABLE'
      | 'NETWORK_TIMEOUT'
      | 'INTERNAL',
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const USER_AGENT = 'OpenMemo/0.1 (+https://github.com/openmemo)';

export function classifyStatus(status: number, headers: Headers): HttpError | null {
  if (status >= 200 && status < 400) return null;
  const errCode = headers.get('x-error-code');
  if (status === 401 || status === 403) {
    if (errCode === 'GatedRepo' || errCode === 'RepoNotFound') {
      return new HttpError(
        headers.get('x-error-message') ?? 'Access to this repository is restricted',
        status,
        'GATED_REPO',
      );
    }
    return new HttpError(`Access denied (${status})`, status, 'GATED_REPO');
  }
  if (status === 404) return new HttpError('Not found', status, 'NOT_FOUND');
  if (status === 429) {
    const ra = headers.get('retry-after');
    return new HttpError('Rate limited', status, 'RATE_LIMITED', ra ? Number(ra) : undefined);
  }
  if (status >= 500) {
    return new HttpError(`Origin error ${status}`, status, 'PROVIDER_UNREACHABLE');
  }
  return new HttpError(`Unexpected status ${status}`, status, 'INTERNAL');
}

/** Strip the quotes HTTP ETags are wrapped in, and the W/ weak marker. */
function unquoteEtag(v: string | null): string | null {
  if (!v) return null;
  return v.replace(/^W\//, '').replace(/^"|"$/g, '');
}

/**
 * Probe a URL for size / digest / Range support.
 *
 * Uses GET with `Range: bytes=0-0` rather than HEAD: some CDNs and corporate proxies
 * mishandle HEAD, and a 1-byte GET proves Range support at the same time.
 *
 * IMPORTANT — why `redirect: 'manual'` on the first hop:
 * HF and ModelScope put `x-linked-size` and `x-linked-etag` (the content SHA-256) on the
 * *302*, not on the CDN response it points at. With `redirect: 'follow'` the runtime
 * returns only the final 206 and both headers read back as null, silently disabling the
 * "reject a wrong file before transferring a single byte" check. Verified directly:
 *   follow → status=206, x-linked-size=null
 *   manual → status=302, x-linked-size=2497280256, x-linked-etag="7485fe6f…"
 */
export async function probeRemoteFile(
  url: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; token?: string } = {},
): Promise<RemoteFileInfo> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = {
      'user-agent': USER_AGENT,
      range: 'bytes=0-0',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    };

    let res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: ac.signal,
    });
    await res.arrayBuffer().catch(() => undefined);

    // Capture origin metadata from the redirect before following it.
    let size: number | null = null;
    let sha256: string | null = null;
    let etag: string | null = null;
    let lastModified: string | null = null;
    let acceptRanges = false;

    const absorb = (h: Headers, status: number) => {
      const linkedSize = h.get('x-linked-size');
      if (size == null && linkedSize) size = Number(linkedSize);
      const linkedEtag = unquoteEtag(h.get('x-linked-etag'));
      if (sha256 == null && linkedEtag && /^[a-f0-9]{64}$/.test(linkedEtag)) sha256 = linkedEtag;
      if (etag == null) etag = unquoteEtag(h.get('etag'));
      if (lastModified == null) lastModified = h.get('last-modified');
      if (h.get('accept-ranges') === 'bytes' || status === 206) acceptRanges = true;
      if (size == null) {
        const cr = h.get('content-range');
        if (cr) {
          const m = /\/(\d+)\s*$/.exec(cr);
          if (m) size = Number(m[1]);
        }
      }
    };

    absorb(res.headers, res.status);

    // Follow up to a few hops ourselves so each hop's headers are inspected.
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops < 5) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, url).toString();
      res = await fetch(next, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
      await res.arrayBuffer().catch(() => undefined);
      absorb(res.headers, res.status);
      hops++;
    }

    const err = classifyStatus(res.status, res.headers);
    if (err) throw err;

    if (size == null) {
      const cl = res.headers.get('content-length');
      // Only trust content-length when it was NOT a partial response.
      if (cl && res.status === 200) size = Number(cl);
    }

    return {
      sizeBytes: Number.isFinite(size as number) ? (size as number) : null,
      sha256,
      etag,
      lastModified,
      acceptRanges,
      status: res.status,
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new HttpError('Request timed out', 0, 'NETWORK_TIMEOUT');
    }
    throw new HttpError((e as Error).message, 0, 'PROVIDER_UNREACHABLE');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Open a byte-range stream. Always re-resolves the URL so expiring CDN signatures are fresh. */
export async function openRangeStream(
  url: string,
  start: number,
  end: number,
  opts: { signal?: AbortSignal; token?: string; timeoutMs?: number } = {},
): Promise<{ body: ReadableStream<Uint8Array>; status: number; headers: Headers }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      range: `bytes=${start}-${end}`,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    redirect: 'follow',
    signal: opts.signal,
  });
  const err = classifyStatus(res.status, res.headers);
  if (err) throw err;
  if (!res.body) throw new HttpError('Empty response body', res.status, 'PROVIDER_UNREACHABLE');
  return { body: res.body, status: res.status, headers: res.headers };
}

export const MAX_RETRIES = 6;

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters: several parts of the same file fail together when a network blips, and
 * without it they all retry in lockstep. Ollama randomises its redirect backoff for the
 * same reason.
 */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.5 + Math.random()));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/* ═══════════════════ 探测阶段的退避重试（#108） ═══════════════════ */

/**
 * 「哪些失败重试还有救」。
 *
 * ⚠️ 这张表**只有这一份**：`download.ts` 的 `toDownloadError()` 原本另抄了一遍
 * 同样的三个码，现在改成调用它 —— 两处分头维护的判据，迟早会分头改。
 *
 * 反面同样要紧：`NOT_FOUND` / `GATED_REPO` / `INTERNAL` **一次都不重试**。
 * 404 重试三次仍然是 404，只是把用户多晾十几秒，然后给出同一个结论；
 * 而这条加重试的改动最容易做坏的方向，正是「把真的不可达也重试成绿」。
 */
export function isRetriableHttpCode(code: string): boolean {
  return code === 'NETWORK_TIMEOUT' || code === 'RATE_LIMITED' || code === 'PROVIDER_UNREACHABLE';
}

/** 探测阶段的一次尝试。`waitedMsBefore` 记的是**决定等多久**，不是实测耗时。 */
export interface ProbeAttempt {
  /** 1 起数。 */
  attempt: number;
  /** 这次尝试之前退避了多久；第 1 次恒为 0。 */
  waitedMsBefore: number;
  ok: boolean;
  /** `HttpError.code`，成功时是 `'OK'`。 */
  code: string;
  status: number;
  message: string;
}

export interface ProbeRetryPolicy {
  /** 含第一次在内的**总**尝试次数上限。 */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  /** 从第一次尝试开始算的墙钟总预算。到点就停，哪怕次数还没用完。 */
  budgetMs: number;
}

/**
 * ★ 默认策略。**两条上限都是显式的，而且都会被写进错误消息里**。
 *
 * 为什么是 4 次 / 60 秒：`[CI 实测 2026-08-12]` 那一夜的上游故障窗口，
 * 19:59–20:00 六个文件全部 `Origin error 503`，20:06 同一批文件又全部成功 ——
 * 也就是一个**分钟量级**的窗口。原本这一步零重试（探大小失败即整源判死），
 * 一次抖动直接转成用户眼里的"装不上"。
 *
 * 退避 ≈ 1.5s / 3s / 6s（`backoffMs` 带 ±50% 抖动，所以是区间不是定值），
 * 最坏总等待约 16 秒；60 秒预算是**连请求耗时一起算**的硬顶，
 * 用来兜住"每次请求都挂到 20 秒超时"这种慢速失败 —— 那种情况下次数还没用完，
 * 预算先到，于是它**照样红**，只是把"我等了多久才认输"说清楚。
 *
 * 不做成"重试到成功为止"：那样一个真的下线的源会让安装任务永远转圈，
 * 而用户看到的和"卡死"没有区别。
 */
export const PROBE_RETRY_POLICY: ProbeRetryPolicy = {
  maxAttempts: 4,
  baseMs: 1500,
  capMs: 12_000,
  budgetMs: 60_000,
};

/**
 * ★ 媒体导入（用户贴一个链接进来）那条路的策略。**刻意比出厂策略短**。
 *
 * ## 为什么不直接用 `PROBE_RETRY_POLICY`
 *
 * 两件事不一样，而且不是"前台/后台"这么简单：
 *
 * · **组件安装**是用户点完可以走开的后台任务，而且 29 个组件是**单源**——
 *   探测失败 = 这个组件今天装不上，代价高、重来一次也不便宜。等 16 秒值。
 * · **媒体导入**里探测发生在 `resumableFetch()` 的**第一行**，早于任何一次
 *   `onProgress` 回调。重试的整段时间里界面是**冻住的**，而且**重试本身对用户
 *   完全不可见**（见下）。一根不动的进度条和"卡死了"在用户那里是同一件事，
 *   而重来的代价只是**再贴一次链接**。
 *
 * 所以这里换的是**上限**，不是"要不要重试"：一次上游抖动不该让导入直接失败
 * （那是 #111 ② 要修的东西），但也不该让人对着一个僵死的界面等更久。
 *
 * ## ⚠️ 订正一处事实：冻住的时候界面上写的**不是** 0%
 *
 * 本注释上一版写的是"冻在 0%、步骤写着 fetch"，**那是错的**。
 * 真实情况：探测重试发生时，最后发出去的一条进度是 `transcribe.ts` 的
 * `{ step: 'probe', fraction: 1 }` —— 因为在字节真的开始流动之前，
 * **没有任何东西会发 `step: 'fetch'`**。经 `stepFraction()` 换算后，
 * 用户看到的是「**解析中 · 10%**」并停在那里不动。
 * 结论不变（还是一根僵死的进度条），但别拿错的数字去推下一个决定。
 *
 * ## 为什么不让重试变得可见（走查过了，不是没想）
 *
 * 「重试可见的话多等一会是『它在努力』，不可见就是『它死了』」——
 * 成立。但这条路上**没有任何现成的信号能承载它**：
 *
 * · `ResumableFetchOptions.onProgress` 是 `(fraction, bytes, total)`，纯数字；
 * · `FetchRequest.onProgress` 是 `(fraction) => void` —— 这是 `MediaSource`
 *   适配器契约（ADR-002 / D-01 §6.4），**4 个适配器**都实现它；
 * · `StepProgress.message` 这个字段**存在但是死的**：唯一的生产者是
 *   `audio/vad.ts`，而唯一的消费者 `jobs/runners/transcribe.ts` 直接把它丢掉，
 *   线上契约 `JobProgressEvent` 里根本没有对应的格子；
 * · 看起来最像现成通道的 `step: string`（注释写着 free-form）**在渲染层不是**
 *   —— `stepLabel.ts` 要求 `progress.<step>` 这个 locale key 预先存在，
 *   否则一律渲染成「处理中 / Working」，**比现在的「解析中」信息还少**；
 *   而且它不传插值参数，`(2/3)` 这种计数**根本表达不出来**。
 *
 * 真要做，是 10–13 个文件、**2 个导出接口**（其中一个是 ADR 规定的适配器契约）、
 * 4 个适配器实现、daemon 的 `stepFraction` 权重表、两份 locale。
 * 那是改契约，不是"顺手发一个信号"。
 * ★ 还有一个坑：`stepFraction` 里 `weights[p.step] ?? [0, 1]` ——
 *   发一个没登记的 step 会让总进度从 0.10 **倒退回 0.00**。
 *
 * 组件下载那条路（PR #56）也是同一个处置：`onRetry` 只 `console.warn`。
 * **全仓没有任何一条"进行中的重试"是对用户可见的。** 保持一致。
 *
 * ⇒ 既然发不出信号，就按第二条走：**把最坏值压回今天的量级**。
 *
 * ## 这几个数字是怎么来的
 *
 * 关键算式（`probeRemoteFileWithRetry` 里是 `elapsed + delay > budgetMs` 才罢手，
 * 也就是**只在要睡之前检查、不在请求中途检查**）：
 *
 *     最坏总时长 ≈ budgetMs + timeoutMs
 *
 * 调用方传 `timeoutMs: 20_000`，而**今天（零重试）的最坏值就是 20 秒**。
 * 所以 `budgetMs` 直接决定我们比今天多让用户等多久：
 *   · `budgetMs: 25_000`（上一版）⇒ 最坏 ≈ **45 秒**，是今天的两倍多。**不行。**
 *     （上一版注释写的是"约 41 秒"，那只是其中一条轨迹，不是上界。一并订正。）
 *   · `budgetMs: 4_000`（现在）  ⇒ 最坏 ≈ **24 秒**，而**最常见的那种坏
 *     —— 上游挂起 —— 恰好是 20 秒，与今天一模一样**：
 *     第 1 次挂满 20s，`20000 + 退避 > 4000` 当场罢手，一次都不多等。
 *
 * · `maxAttempts: 3` / `baseMs: 400` ⇒ 退避 0.2–0.6s、0.4–1.2s。
 *   **快速失败**（那一夜的 `Origin error 503` 就是立刻回）整段约 1.2–2.4 秒，
 *   三次全用得上、且离 4 秒预算有余量（这一点被测试钉住了）。
 *   ★ 也就是说：压预算**没有牺牲**真正要救的那个场景。
 * · `capMs: 2_000` —— 只对 429 的 `Retry-After` 生效（其余走退避，最大才 1.2s）。
 *   一个说"60 秒后再来"的头在这里最多等 2 秒，还能再试一次。
 *
 * ## 压预算**牺牲**了什么（说清楚，别假装没有）
 *
 * 失去的是"每次都要好几秒才失败"的那种上游的重试机会（第 1 次就烧掉 4 秒预算，
 * 直接罢手）。这是刻意的取舍：那种上游**用户等得最久、而重试成功率最低**。
 * 宁可少救一次抖动，也不要让人对着一个僵死的界面多等一倍。
 *
 * ⚠️ 想把 `budgetMs` 调回去的人请先读这一段：**它被两件事约束着** ——
 *   ① 最坏值 = `budgetMs + timeoutMs`，而基准是今天的 20 秒；
 *   ② 重试全程**用户看不见**。① 是算术，② 一旦有人把重试做成可见的，
 *   这个数就可以重新谈。在那之前，它不是一个可以随手放大的旋钮。
 *
 * 刻意**不动** `timeoutMs`：那会改变"慢但能用的上游"的成败，是另一件事，
 * 不该搭在重试这一改里。
 */
export const MEDIA_PROBE_RETRY_POLICY: ProbeRetryPolicy = {
  maxAttempts: 3,
  baseMs: 400,
  capMs: 2000,
  budgetMs: 4000,
};

/**
 * 下一次重试等多久。
 *
 * 429 带 `Retry-After` 时**听服务端的**（上限仍是 `capMs`：一个说"两小时后再来"的
 * 头，照它等就等于挂死；我们照上限等一次，失败了如实报 429）。
 * 其余情况走 `backoffMs` 的指数退避 + 抖动。
 */
export function nextProbeDelayMs(
  failedAttempt: number,
  retryAfterSec: number | undefined,
  policy: ProbeRetryPolicy = PROBE_RETRY_POLICY,
): number {
  if (retryAfterSec != null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(Math.round(retryAfterSec * 1000), policy.capMs);
  }
  return backoffMs(failedAttempt - 1, policy.baseMs, policy.capMs);
}

/**
 * 探测重试全部用尽之后抛的错。
 *
 * 它**仍然是 `HttpError`**（码、状态、`retryAfterSec` 逐字沿用最后一次失败），
 * 所以上层 `toDownloadError()` 的分类一个字都不用改；多出来的只有
 * `attempts` / `budgetExhausted` —— 也就是"试了几次、每次隔多久、每次为什么失败"。
 */
export class ProbeFailedError extends HttpError {
  constructor(
    last: HttpError,
    readonly attempts: ProbeAttempt[],
    /** true = 是**预算**先到，不是次数用完。两者在报告里必须分得开。 */
    readonly budgetExhausted: boolean,
    readonly policy: ProbeRetryPolicy,
  ) {
    super(last.message, last.status, last.code, last.retryAfterSec);
    this.name = 'ProbeFailedError';
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * 中文版「试了几次、每次隔多久、每次为什么失败」。
 *
 * ⚠️ 「只试了一次」有**两种**成因，措辞必须分开：
 *   · 确定性失败（404 之类）→ 是我们**决定**不重试；
 *   · 预算先到 → 是我们**没能**再试。
 * 把后者也说成"确定性失败不重试"，就是拿一句假话解释一次真失败。
 */
export function describeProbeAttemptsZh(e: ProbeFailedError): string {
  const tried = e.attempts.length;
  if (tried === 1 && !e.budgetExhausted) {
    return (
      `未重试（${e.code} 属于确定性失败，再试一次仍是同一个结果）：` +
      `只试了 1 次 —— ${e.attempts[0]?.message ?? e.message}。`
    );
  }
  const waits = e.attempts
    .slice(1)
    .map((a) => secs(a.waitedMsBefore))
    .join(' / ');
  const trail = e.attempts.map((a) => `第 ${String(a.attempt)} 次 ${a.message}`).join('；');
  return (
    `${tried === 1 ? '未能重试' : '已退避重试'}：共 ${String(tried)} 次尝试` +
    `（上限 ${String(e.policy.maxAttempts)} 次、总预算 ${secs(e.policy.budgetMs)}）` +
    (waits ? `，间隔 ${waits}` : '') +
    `；${trail}。` +
    (e.budgetExhausted ? `⚠️ 是**总预算先用尽**，次数还没试满。` : '')
  );
}

/** 英文版，内容与 {@link describeProbeAttemptsZh} 逐条对应。 */
export function describeProbeAttemptsEn(e: ProbeFailedError): string {
  const tried = e.attempts.length;
  if (tried === 1 && !e.budgetExhausted) {
    return `No retry (${e.code} is deterministic): 1 attempt — ${e.attempts[0]?.message ?? e.message}.`;
  }
  const waits = e.attempts
    .slice(1)
    .map((a) => secs(a.waitedMsBefore))
    .join(' / ');
  const trail = e.attempts.map((a) => `#${String(a.attempt)} ${a.message}`).join('; ');
  return (
    `Retried with backoff: ${String(tried)} attempts (cap ${String(e.policy.maxAttempts)}, ` +
    `budget ${secs(e.policy.budgetMs)})` +
    (waits ? `, waits ${waits}` : '') +
    `; ${trail}.` +
    (e.budgetExhausted ? ' NOTE: the time budget ran out before the attempt cap.' : '')
  );
}

/**
 * ★ `probeRemoteFile` 的退避重试外壳（#108）。
 *
 * ## 为什么外挂一层，而不是把重试塞进 `probeRemoteFile`
 *
 * `probeRemoteFile` 是"发一次请求、把头读明白"的那一层，`resumableFetch.ts`
 * 也直接用它。重试是**策略**，不是那一层的语义：谁需要谁包一层，
 * 才不会出现"某个调用方莫名其妙慢了一分钟"。
 *
 * ## 它保证的两件相反的事
 *
 *   · 抖一下（一次 hang up、一次 503）→ 退避后成功，**照常返回**，
 *     `attempts` 里留着"第几次才成的"证据（调用方负责说出来）；
 *   · 真的不可达 → 次数或预算用尽后**照样抛**，错误里带得出次数/间隔/每次原因。
 *
 * 取消（`opts.signal`）**永远不重试**：用户按了取消还接着重试，是另一种不听话。
 */
export async function probeRemoteFileWithRetry(
  url: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    token?: string;
    policy?: Partial<ProbeRetryPolicy>;
    /** 每次**决定重试**时回调一次（拿到的是刚失败的那次）。用于日志，不影响判定。 */
    onRetry?: (attempt: ProbeAttempt, delayMs: number) => void;
  } = {},
): Promise<{ info: RemoteFileInfo; attempts: ProbeAttempt[] }> {
  const policy: ProbeRetryPolicy = { ...PROBE_RETRY_POLICY, ...opts.policy };
  const attempts: ProbeAttempt[] = [];
  const startedAt = Date.now();
  let waitedMsBefore = 0;

  for (let n = 1; ; n += 1) {
    try {
      const info = await probeRemoteFile(url, opts);
      attempts.push({
        attempt: n,
        waitedMsBefore,
        ok: true,
        code: 'OK',
        status: info.status,
        message: `HTTP ${String(info.status)}`,
      });
      return { info, attempts };
    } catch (e) {
      const he =
        e instanceof HttpError
          ? e
          : new HttpError((e as Error)?.message ?? String(e), 0, 'PROVIDER_UNREACHABLE');
      const failed: ProbeAttempt = {
        attempt: n,
        waitedMsBefore,
        ok: false,
        code: he.code,
        status: he.status,
        message: he.message,
      };
      attempts.push(failed);

      if (opts.signal?.aborted) throw he;
      if (!isRetriableHttpCode(he.code)) throw new ProbeFailedError(he, attempts, false, policy);
      if (n >= policy.maxAttempts) throw new ProbeFailedError(he, attempts, false, policy);

      const delay = nextProbeDelayMs(n, he.retryAfterSec, policy);
      if (Date.now() - startedAt + delay > policy.budgetMs) {
        throw new ProbeFailedError(he, attempts, true, policy);
      }
      waitedMsBefore = delay;
      opts.onRetry?.(failed, delay);
      await sleep(delay, opts.signal);
    }
  }
}
