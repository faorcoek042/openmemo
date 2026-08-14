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
 *   `onProgress` 回调。也就是说重试的整段时间里，界面上是一根
 *   **冻在 0%、步骤写着 fetch 的进度条**（`transcribe.ts` 的 `stepFraction`
 *   把 fetch 段映射到 0.00–0.08，而这一步连 0.00 都还没动）。
 *   一根不动的进度条和"卡死了"在用户那里是同一件事。
 *   而重来的代价只是**再贴一次链接**。
 *
 * 所以这里换的是**上限**，不是"要不要重试"：一次上游抖动不该让导入直接失败
 * （那是 #111 ② 要修的东西），但也不该让人对着 0% 等一分钟。
 *
 * ## 这几个数字是怎么来的
 *
 * · `maxAttempts: 3` —— 首探 + 2 次重试。抖动通常一次就过去了；
 *   第三次还不行，基本就是真的不可达，再试是在浪费用户的时间。
 * · 退避 ≈ 0.8s / 1.6s（带 ±50% 抖动），**快速失败**（比如立刻回 503）
 *   的整段大约 1.2–3.6 秒 —— 用户几乎察觉不到，而抖动被吃掉了。
 * · `budgetMs: 25_000` —— 兜住"慢速失败"。
 *
 * ⚠️ **实话说清楚**：预算只在**要睡之前**检查，不在请求中途检查，所以它会
 *   超出 `budgetMs`，最多超一个请求超时。调用方传的是 `timeoutMs: 20_000`，
 *   于是每次都挂到超时的最坏情况是：第 1 次 20s → 还剩预算，睡 0.8s →
 *   第 2 次到 ~41s → 预算已过，抛 `budgetExhausted: true`。
 *   **也就是最坏约 41 秒**（今天是 20 秒后直接失败）。
 *   嫌长就调这一个旋钮：`budgetMs` 调到 20_000 以下，慢速失败就退回单次。
 *   刻意不去动 `timeoutMs`：那会改变"慢但能用的上游"的成败，
 *   是另一件事，不该搭在重试这一改里。
 */
export const MEDIA_PROBE_RETRY_POLICY: ProbeRetryPolicy = {
  maxAttempts: 3,
  baseMs: 800,
  capMs: 4000,
  budgetMs: 25_000,
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
