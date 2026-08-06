/**
 * Outbound proxy configuration for subprocesses.
 *
 * WHY THIS IS A HARD REQUIREMENT, NOT A CONVENIENCE:
 * every network hop in the import path is a child process we spawn — yt-dlp fetching a
 * page, ffmpeg pulling an HLS playlist, and (on the downloader side) model weights from
 * Hugging Face or GitHub. For users behind a restrictive network, HF and GitHub are
 * simply unreachable without a proxy, so "no proxy support" means "the product cannot be
 * installed or used at all", not "downloads are slower".
 *
 * WHY IT NEEDS ITS OWN MODULE RATHER THAN JUST FORWARDING env:
 * `buildChildEnv()` deliberately REBUILDS the child environment from a small allowlist
 * instead of filtering `process.env` (D-01 §8.4 L5) — precisely so an unknown variable
 * cannot ride along into a subprocess. That is the right default, and it is also why
 * `HTTP_PROXY` never reached ffmpeg: it was never on the list. Adding proxy support means
 * adding it deliberately, with the same scrutiny as any other value we hand a child.
 *
 * SECURITY: a proxy URL is user input that ends up in a subprocess argument
 * (`yt-dlp --proxy <url>`) and in the child's environment. It gets the same treatment as
 * a pasted media URL — scheme allowlist, no control characters, no leading dash, length
 * cap. A proxy URL MAY point at a private address (that is the normal case for a local
 * proxy such as 127.0.0.1:7890), so the SSRF check that applies to media URLs is
 * deliberately NOT applied here; the user is configuring their own egress, not naming a
 * resource to fetch.
 */

export const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks5h', 'socks4', 'socks4a'] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

export const MAX_PROXY_URL_BYTES = 1024;

export interface ProxyConfig {
  /** e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`. */
  url: string;
  /**
   * Hosts that bypass the proxy, comma-separated, `NO_PROXY` syntax.
   * Loopback is always prepended — our own daemon must never be proxied.
   */
  noProxy?: string;
}

export type ProxyValidation =
  | { ok: true; url: string; scheme: ProxyScheme; hostname: string }
  | { ok: false; code: 'empty' | 'too_long' | 'control_characters' | 'leading_dash' | 'unparseable' | 'bad_scheme'; message: string };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate a user-supplied proxy URL.
 *
 * Note what is NOT checked: whether the host is private. A proxy at 127.0.0.1 is the
 * common case (Clash, v2ray, SSH tunnel), so rejecting private addresses here would
 * reject the main use case. The SSRF concern that motivates that check for media URLs
 * does not apply — the user is declaring their own egress path.
 */
export function validateProxyUrl(input: unknown): ProxyValidation {
  if (typeof input !== 'string') return { ok: false, code: 'empty', message: 'proxy URL must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, code: 'empty', message: 'proxy URL is empty' };
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_PROXY_URL_BYTES) {
    return { ok: false, code: 'too_long', message: `proxy URL exceeds ${MAX_PROXY_URL_BYTES} bytes` };
  }
  // Checked before parsing: `new URL()` silently strips tabs and newlines, so parsing
  // first would launder a hostile string into a clean-looking one.
  if (CONTROL_CHARS.test(trimmed)) {
    return { ok: false, code: 'control_characters', message: 'proxy URL contains control characters' };
  }
  // It becomes an argv element for `yt-dlp --proxy`; a leading dash would be read as a flag.
  if (trimmed.startsWith('-')) {
    return { ok: false, code: 'leading_dash', message: 'proxy URL may not begin with "-"' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: 'unparseable', message: 'proxy URL could not be parsed' };
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!(PROXY_SCHEMES as readonly string[]).includes(scheme)) {
    return {
      ok: false,
      code: 'bad_scheme',
      message: `proxy scheme "${scheme}" is not supported (use ${PROXY_SCHEMES.join(' / ')})`,
    };
  }

  return { ok: true, url: url.href.replace(/\/$/, ''), scheme: scheme as ProxyScheme, hostname: url.hostname };
}

/** Loopback must never be proxied — that would route our own API through the proxy. */
const ALWAYS_BYPASS = 'localhost,127.0.0.1,::1';

/**
 * Environment variables for proxy-aware children.
 *
 * Both cases are set because the two tools disagree: curl-style consumers read the
 * lowercase names, while many others read the uppercase ones. Setting only one is a
 * frequent cause of "the proxy is configured but this particular tool ignores it".
 */
export function proxyEnv(config: ProxyConfig | null): Record<string, string> {
  if (config === null) return {};
  const v = validateProxyUrl(config.url);
  if (!v.ok) return {};

  const noProxy = [ALWAYS_BYPASS, config.noProxy ?? ''].filter((s) => s.length > 0).join(',');

  const env: Record<string, string> = {
    http_proxy: v.url,
    HTTP_PROXY: v.url,
    https_proxy: v.url,
    HTTPS_PROXY: v.url,
    no_proxy: noProxy,
    NO_PROXY: noProxy,
  };

  // ALL_PROXY is how curl/yt-dlp pick up a SOCKS proxy; ffmpeg does not read it.
  if (v.scheme.startsWith('socks')) {
    env.all_proxy = v.url;
    env.ALL_PROXY = v.url;
  }

  return env;
}

/**
 * `yt-dlp --proxy` arguments.
 *
 * Passed explicitly rather than relying on the environment: yt-dlp documents `--proxy`,
 * and an explicit flag is unambiguous where env-var precedence is not. Returns `[]` for
 * an invalid or absent config so a bad setting degrades to "no proxy" rather than
 * breaking the invocation.
 */
export function ytDlpProxyArgs(config: ProxyConfig | null): string[] {
  if (config === null) return [];
  const v = validateProxyUrl(config.url);
  if (!v.ok) return [];
  return ['--proxy', v.url];
}

/**
 * ffmpeg proxy support — and its real limitation, stated rather than hidden.
 *
 * ffmpeg's HTTP protocol reads `http_proxy` from the environment and CONNECTs through it
 * for both http and https URLs. It does **not** implement SOCKS: there is no
 * `socks_proxy` handling in libavformat's http protocol, and `ALL_PROXY` is ignored.
 *
 * So a SOCKS-only user can download models and use yt-dlp (both honour SOCKS) but cannot
 * pull an HLS stream directly through ffmpeg. Returning the applicability flag lets the
 * caller warn accurately instead of silently making a direct connection the user
 * believed was proxied.
 */
export function ffmpegProxySupport(config: ProxyConfig | null): {
  env: Record<string, string>;
  supported: boolean;
  reason: string | null;
} {
  if (config === null) return { env: {}, supported: true, reason: null };
  const v = validateProxyUrl(config.url);
  if (!v.ok) return { env: {}, supported: false, reason: v.message };

  if (v.scheme.startsWith('socks')) {
    return {
      env: {},
      supported: false,
      reason:
        'ffmpeg 不支持 SOCKS 代理（libavformat 的 http 协议只读 http_proxy）。' +
        '直接拉流（HLS）将不走代理；模型下载与站点解析不受影响。',
    };
  }

  return { env: proxyEnv(config), supported: true, reason: null };
}

/*
 * `redactProxyUrl` 此前**在这里有一份本地实现**，与 `@openmemo/shared` 那份
 * （`packages/shared/src/proxy.ts`）输出不同。`[实测]` 7 个输入里 6 个不一样：
 *
 *   http://user:pass@proxy:3128  → 这份 `http://***@proxy:3128`
 *                                  shared `http://***:***@proxy:3128/`
 *   http://:pass@h:80            → 这份 `http://***@h`   ← 端口没了，且看起来像"只有用户名"
 *                                  shared `http://:***@h/`
 *   ''                           → 这份 `<invalid proxy url>` / shared `null`
 *
 * `[实测]` 这份**没有任何生产调用方** —— 三个真消费方
 * （`apps/daemon/src/http/rest/proxy.ts`、`.../selfcheck.ts`、
 * `packages/downloader/src/proxy.ts`）**全部** import 的是 shared 那份，
 * 只有本包的测试在用它。所以这里是直接删掉、由 `index.ts` 转发 shared 的那份，
 * 而不是去挑"哪份对"——挑哪份对是个产品决定，而这里根本没有第二个答案在生产里跑。
 *
 * ⚠️ 顺带记下**没动**的一处：本文件还导出一个 `ProxyConfig`（`{url, noProxy?}`），
 * 与 shared 的 `ProxyConfig`（`{mode, httpProxy?, httpsProxy?, socks5?, noProxy?}`）
 * 同名不同形状。那个是真在用的（`proxyEnv`/`ytDlpProxyArgs` 的入参），
 * 改名要动 daemon，不在本轮范围内 —— 已在 inbox 报出。
 */
