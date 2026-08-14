/**
 * Proxy configuration contract.
 *
 * Lives in `shared` because three modules must agree on it exactly: the settings UI
 * that edits it, the daemon that stores it, and the downloader that applies it. A proxy
 * setting that the downloader interprets differently from the UI is worse than none —
 * the user reads "proxy on", sees downloads fail, and has no way to tell which layer
 * disagreed.
 *
 * NOTE: no `node:` imports in this file. `shared` is bundled into the browser.
 */

export const PROXY_MODES = [
  /** Direct connection. */
  'off',
  /** Inherit `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` from the environment. */
  'system',
  /** Use the URLs configured below. */
  'manual',
] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];

export interface ProxyConfig {
  mode: ProxyMode;

  /**
   * Proxy URLs. Credentials may be embedded (`http://user:pass@host:3128`).
   *
   * `socks5` takes precedence over `httpProxy`/`httpsProxy` when set, because a user who
   * has filled in SOCKS5 has almost certainly done so deliberately — the common Chinese
   * clients (Clash, v2rayN, sing-box) expose both ports, and the SOCKS one is the one
   * that carries UDP and is less likely to be a stripped-down CONNECT-only listener.
   */
  httpProxy?: string | null;
  httpsProxy?: string | null;
  socks5?: string | null;

  /**
   * Hosts that must NOT go through the proxy. Same syntax as curl's `no_proxy`:
   * exact host, `.suffix` for domain suffixes, or `*` for everything.
   *
   * Loopback is ALWAYS bypassed regardless of this list — see `shouldBypassProxy`.
   */
  noProxy: string[];
}

/**
 * Default is `system`, not `off`.
 *
 * The target user is on a Chinese network where Hugging Face and GitHub are unreachable
 * without a proxy, and who — if they can browse at all — already has one configured at
 * the OS level. Defaulting to `off` makes the single most confusing failure the default
 * experience: the browser works, the app says "download failed", and nothing on screen
 * connects the two. Inheriting the environment costs nothing when no proxy is set, since
 * `proxyUrlFor` then finds no variables and returns null — identical to `off`.
 */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: 'system',
  httpProxy: null,
  httpsProxy: null,
  socks5: null,
  noProxy: [],
};

/**
 * Why a connectivity probe failed.
 *
 * The split between `proxy_*` and `upstream_*` is the whole point of the feature. Telling
 * a user "connection failed" when their proxy is down, versus when the proxy works and
 * Hugging Face is blocked, sends them to two completely different fixes. Collapsing both
 * into one red X is what makes proxy settings frustrating in other tools.
 */
export const PROXY_PROBE_RESULTS = [
  /** Reached the target and got a valid HTTP response. */
  'ok',
  /** Could not establish a connection to the proxy itself (refused / timeout / bad host). */
  'proxy_unreachable',
  /** Proxy answered but rejected our credentials (HTTP 407, or SOCKS5 auth failure). */
  'proxy_auth_failed',
  /** Proxy is fine; it could not reach the target, or the target hung up. */
  'upstream_unreachable',
  /** Reached the target, but it returned an unexpected status (e.g. 403 region block). */
  'upstream_error',
  /** The target hostname did not resolve (only meaningful on a direct connection). */
  'dns_failed',
  /** Probe did not run — e.g. bypassed by `noProxy`. */
  'skipped',
  /** Could not be attributed to either side. The raw error goes in `detail` —
   *  a specific-but-wrong verdict is worse than an honest "unknown". */
  'unclassified',
] as const;
export type ProxyProbeResult = (typeof PROXY_PROBE_RESULTS)[number];

/**
 * 一条探针结果那句**细节**说的是什么 —— 机器可读，措辞归两份 locale（#112）。
 *
 * ## 为什么不能复用 {@link ProxyProbeResult}
 *
 * 看起来该复用（那八格已经有 `settings.proxy.probe.*` 一整套词条），**但核过之后不行**：
 *   · 这句细节说的比芯片标签**多** —— 它点名脱敏后的代理 URL 与目标站；
 *   · 更要紧的是 `refused` 那一档发的 `result` 是 `'unclassified'`，而 `classify()`
 *     在**别的成因**上也会给出同一个 `'unclassified'`。**两者不是一一对应。**
 *
 * 硬套一张表，就是把「我不知道这是什么」塌成「我知道」。所以细节自己一根轴。
 */
export type ProxyProbeDetail =
  | {
      /**
       * 连不上代理本身 —— **一个请求都没有向目标站发出去**。
       * 这一格要说清后半句：否则用户会以为目标站也测过了。
       */
      readonly kind: 'proxy_unreachable_not_sent';
      /** 已脱敏的代理 URL（数据，不翻译）。 */
      readonly proxyUrl: string;
      /** 本来要发往的目标（`ProxyProbe.target`，例如 `YouTube`）。 */
      readonly target: string;
    }
  | {
      /** 代理答了但拒绝凭据（407）—— **这不是上游的问题**，别让用户去查目标站。 */
      readonly kind: 'proxy_rejected_credentials';
      readonly proxyUrl: string;
    }
  | {
      /**
       * 代理答了，但拒绝建立到目标的隧道（CONNECT 非 2xx、非 407）。
       *
       * ⚠️ 这一格**必须如实说「判断不下去」**：常见于按策略拒绝的企业代理，
       * 而我们分不出问题在代理策略还是目标站。给它一个具体结论就是在没有证据的地方下判断。
       */
      readonly kind: 'proxy_refused_tunnel';
      readonly proxyUrl: string;
      readonly target: string;
    }
  | {
      /**
       * fetch / DNS / TLS **原样抛回来的串**。
       *
       * ⚠️ **这一格刻意不枚举**：落进来的是一个我们没有解读过、也没有边界的集合。
       * 给它硬编一个枚举，是把「我不知道这是什么」塌成「我知道」。
       * 它如实进 `text`，界面上明说这一段是原文、不翻译 ——
       * 同 `UpstreamFailure.upstream_error_text` 的待遇。
       */
      readonly kind: 'probe_error_text';
      readonly text: string;
    };

export interface ProxyProbe {
  /** Human label, e.g. "Hugging Face". */
  target: string;
  url: string;
  result: ProxyProbeResult;
  /** Whether this request actually went through the proxy (false = direct/bypassed). */
  viaProxy: boolean;
  httpStatus?: number;
  elapsedMs: number;
  /**
   * 这一条的细节。**机器可读，不是一句话**（#112）—— 上一版这里是三句中文散文
   * 加一条原始错误串，而设置页把它渲染在一整屏英文里。
   */
  detail?: ProxyProbeDetail;
}

export interface ProxyTestReport {
  /** True only if every non-skipped probe returned `ok`. */
  ok: boolean;
  /**
   * True when the proxy itself is reachable. Distinguishes "your proxy is down" from
   * "your proxy is up but cannot reach this site" without the user reading each probe.
   */
  proxyReachable: boolean | null;
  probes: ProxyProbe[];
}

/**
 * One row of the download-source latency table.
 *
 * This is deliberately a SEPARATE action from the proxy test, because the two answer
 * different questions and imply different fixes. "Is my proxy working at all?" is
 * answered once, against a neutral host. "Which mirror should I pull from?" is a
 * comparison across sources where a slow-but-working row is useful information, not a
 * failure. Folding them into one button forces both answers into a single red/green
 * verdict and loses the comparison entirely.
 */
/**
 * 内置下载源的 provider id —— **措辞轴**（#112 第 17 处）。
 *
 * ## 这一处不新建枚举，因为机器可读的那一格本来就在
 *
 * 源表格与它的摘要句上一版渲染的是 `label`，而目录里那两条 label 逐字是
 * `'hf-mirror 镜像'` 与 `'ModelScope 魔搭'` —— **英文界面上的两段中文**。
 * 但这里不需要造一张 reason 表：`provider` 一直是机器可读的 id，
 * 只是从来没人拿它当措辞轴用。
 *
 * ⚠️ **这个联合就是那道闸门**：`DOWNLOAD_SOURCE_TARGETS` 被钉成"只能用这几个
 * provider"，所以加一个内置源必须先加到这里，而那会让 web 侧那张
 * `Record<DownloadSourceProvider, string>` **当场编译红** —— 加了源没写话，红。
 */
export const DOWNLOAD_SOURCE_PROVIDERS = ['hf', 'hf-mirror', 'modelscope', 'github'] as const;
export type DownloadSourceProvider = (typeof DOWNLOAD_SOURCE_PROVIDERS)[number];

/** 这个 provider 是不是我们认得的内置源（调用方可以传自定义源，那时为假）。 */
export function isDownloadSourceProvider(p: string): p is DownloadSourceProvider {
  return (DOWNLOAD_SOURCE_PROVIDERS as readonly string[]).includes(p);
}

export interface SourceLatency {
  /**
   * Provider id, e.g. "hf" / "hf-mirror" / "modelscope" / "github".
   *
   * ★ **界面上那个名字按这一格翻**（#112），不是按下面的 `label`。
   * 调用方可以传自定义源，所以这里仍是 `string`；
   * 认不认得由 {@link isDownloadSourceProvider} 判，认不出时界面如实标"原文"。
   */
  provider: string;
  /**
   * 目录里那个**原始**名字。
   *
   * ⚠️ **不是本地化文案**，别直接渲染给用户 —— 它逐字含中文
   * （`hf-mirror 镜像` / `ModelScope 魔搭`），这正是 #112 第 17 处要治的。
   * 它留着有两个用处：排障时对得上目录，以及自定义源（没有 provider 词条）时的兜底。
   */
  label: string;
  url: string;
  reachable: boolean;
  /** Time to first byte, ms. Null when unreachable. */
  latencyMs: number | null;
  viaProxy: boolean;
  httpStatus?: number;
  detail?: string;
}

export interface SourceLatencyReport {
  measuredAt: string;
  rows: SourceLatency[];
  /** Fastest reachable provider, or null when none responded. */
  fastest: string | null;
}

/** Strip credentials so a proxy URL can be logged or shown in the UI. */
export function redactProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    // Not parseable — return a placeholder rather than echoing something that may
    // contain a password in a form we failed to recognise.
    return '<invalid proxy url>';
  }
}

/**
 * Should `hostname` bypass the proxy?
 *
 * Loopback and `.local` always bypass, even if the user did not list them. The daemon
 * talks to itself, and a locally hosted LLM (Ollama on 127.0.0.1:11434, LM Studio on
 * :1234) is a first-class configuration in this app. Routing those through a remote
 * proxy cannot succeed and produces a confusing failure far from its cause.
 */
export function shouldBypassProxy(hostname: string, noProxy: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host)
  ) {
    return true;
  }

  for (const raw of noProxy) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    const bare = rule.startsWith('.') ? rule.slice(1) : rule;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** Resolve the proxy URL to use for a given target URL, or null for a direct connection. */
export function proxyUrlFor(
  cfg: ProxyConfig,
  targetUrl: string,
  env: Record<string, string | undefined> = {},
): string | null {
  if (cfg.mode === 'off') return null;

  let host: string;
  let protocol: string;
  try {
    const u = new URL(targetUrl);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    return null;
  }

  const noProxy =
    cfg.mode === 'system'
      ? (env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean)
      : cfg.noProxy;
  if (shouldBypassProxy(host, noProxy)) return null;

  if (cfg.mode === 'system') {
    const all = env.ALL_PROXY ?? env.all_proxy ?? null;
    const https = env.HTTPS_PROXY ?? env.https_proxy ?? null;
    const http = env.HTTP_PROXY ?? env.http_proxy ?? null;
    return (protocol === 'https:' ? https : http) ?? all ?? null;
  }

  // manual — SOCKS5 wins when present, see ProxyConfig.socks5.
  if (cfg.socks5) return cfg.socks5;
  return (protocol === 'https:' ? cfg.httpsProxy : cfg.httpProxy) ?? cfg.httpProxy ?? null;
}
