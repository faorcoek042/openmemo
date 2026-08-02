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

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: 'off',
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
export function proxyUrlFor(cfg: ProxyConfig, targetUrl: string, env: Record<string, string | undefined> = {}): string | null {
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
