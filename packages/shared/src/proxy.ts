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

export interface ProxyProbe {
  /** Human label, e.g. "Hugging Face". */
  target: string;
  url: string;
  result: ProxyProbeResult;
  /** Whether this request actually went through the proxy (false = direct/bypassed). */
  viaProxy: boolean;
  httpStatus?: number;
  elapsedMs: number;
  /** Raw error text, for the details expander. Never the only thing shown. */
  detail?: string;
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
export interface SourceLatency {
  /** Provider id, e.g. "hf" / "hf-mirror" / "modelscope" / "github". */
  provider: string;
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
