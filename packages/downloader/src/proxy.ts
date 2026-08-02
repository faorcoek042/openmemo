/**
 * Proxy support for every outbound request the app makes.
 *
 * ## Why a global dispatcher instead of a per-call option
 *
 * There are six `fetch()` call sites in this package alone (download, probe, manifest,
 * upstream check, redirect following, HEAD sizing) and more in the daemon. Threading a
 * `dispatcher` option through all of them means the feature is correct only while every
 * current AND future call site remembers to pass it. The failure mode of forgetting is
 * the worst kind: in the environment this feature exists for — a Chinese network with no
 * route to Hugging Face — a missed call site does not error, it *hangs* until timeout,
 * far from the code that forgot.
 *
 * So the proxy is installed with `setGlobalDispatcher` once. A call site cannot opt out
 * by accident, and `no_proxy` is honoured by routing per-origin inside the dispatcher
 * rather than by asking callers to check first.
 *
 * ## Why not the built-in `NODE_USE_ENV_PROXY`
 *
 * Node 24 can read `HTTP_PROXY` at startup, but it is fixed for the life of the process.
 * The user edits proxy settings in a settings page and presses "test connection"; making
 * that require a daemon restart would be a worse feature than not having it.
 */
import net from 'node:net';

import {
  type ProxyConfig,
  type ProxyProbe,
  type ProxyProbeResult,
  type ProxyTestReport,
  proxyUrlFor,
  redactProxyUrl,
} from '@openmemo/shared';
import { SocksClient } from 'socks';
import {
  Agent,
  Dispatcher,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  setGlobalDispatcher,
} from 'undici';

/** Targets we probe for "test connection". These are the hosts model downloads use. */
export const DEFAULT_PROBE_TARGETS: ReadonlyArray<{ target: string; url: string }> = [
  { target: 'Hugging Face', url: 'https://huggingface.co/api/models/ggerganov/whisper.cpp' },
  { target: 'GitHub', url: 'https://api.github.com/repos/ggml-org/whisper.cpp' },
  { target: 'ModelScope', url: 'https://www.modelscope.cn/api/v1/models/Qwen/Qwen3-4B-GGUF/revisions' },
];

/** Build an undici connector that tunnels through a SOCKS5 proxy. */
function socksConnector(proxyUrl: URL): buildConnector.connector {
  const base = buildConnector({});
  const port = Number(proxyUrl.port) || 1080;
  const userId = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined;
  const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined;

  return (opts, callback) => {
    const targetPort = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host: proxyUrl.hostname, port, type: 5, userId, password },
      command: 'connect',
      destination: { host: opts.hostname, port: targetPort },
    })
      .then(({ socket }) => {
        // Hand the raw tunnel to undici so it performs the TLS handshake itself when the
        // target is https — doing it here would bypass undici's own cert/ALPN handling.
        base({ ...opts, httpSocket: socket }, callback);
      })
      .catch((err: Error) => callback(tagSocksError(err), null));
  };
}

/** Mark SOCKS-layer failures so the probe can attribute them to the proxy, not the target. */
function tagSocksError(err: Error): Error {
  (err as Error & { openmemoProxyFault?: true }).openmemoProxyFault = true;
  return err;
}

function isProxyFault(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'openmemoProxyFault' in err);
}

/** Routes each request to a proxy or straight out, per `no_proxy` and mode. */
class RoutingDispatcher extends Dispatcher {
  readonly #direct = new Agent();
  readonly #byProxyUrl = new Map<string, Dispatcher>();
  readonly #cfg: ProxyConfig;
  readonly #env: Record<string, string | undefined>;

  constructor(cfg: ProxyConfig, env: Record<string, string | undefined>) {
    super();
    this.#cfg = cfg;
    this.#env = env;
  }

  #agentFor(proxyUrl: string): Dispatcher {
    const cached = this.#byProxyUrl.get(proxyUrl);
    if (cached) return cached;
    let agent: Dispatcher;
    const u = new URL(proxyUrl);
    if (u.protocol === 'socks5:' || u.protocol === 'socks:' || u.protocol === 'socks5h:') {
      agent = new Agent({ connect: socksConnector(u) });
    } else {
      // ProxyAgent handles CONNECT tunnelling and Proxy-Authorization for http/https.
      agent = new ProxyAgent({ uri: proxyUrl });
    }
    this.#byProxyUrl.set(proxyUrl, agent);
    return agent;
  }

  override dispatch(
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = typeof opts.origin === 'string' ? opts.origin : (opts.origin?.href ?? '');
    const proxyUrl = origin ? proxyUrlFor(this.#cfg, origin, this.#env) : null;
    const target = proxyUrl ? this.#agentFor(proxyUrl) : this.#direct;
    return target.dispatch(opts, handler);
  }

  override async close(): Promise<void> {
    await Promise.all([this.#direct.close(), ...[...this.#byProxyUrl.values()].map((a) => a.close())]);
  }

  override async destroy(): Promise<void> {
    await Promise.all([
      this.#direct.destroy(),
      ...[...this.#byProxyUrl.values()].map((a) => a.destroy()),
    ]);
  }
}

let active: { cfg: ProxyConfig; dispatcher: RoutingDispatcher } | null = null;

/**
 * Install `cfg` process-wide. Safe to call repeatedly; the previous dispatcher is torn
 * down so sockets held open against an old proxy do not linger.
 */
export function applyProxyConfig(
  cfg: ProxyConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const previous = active?.dispatcher;
  const dispatcher = new RoutingDispatcher(cfg, env);
  setGlobalDispatcher(dispatcher);
  active = { cfg, dispatcher };
  // Destroy after swapping so in-flight requests are not cut off mid-download.
  void previous?.close().catch(() => previous.destroy().catch(() => undefined));
}

/** What is currently installed — for `/api/settings` readback and diagnostics. */
export function activeProxySummary(): { mode: string; proxy: string | null } | null {
  if (!active) return null;
  const { cfg } = active;
  const url = cfg.mode === 'manual' ? (cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy ?? null) : null;
  return { mode: cfg.mode, proxy: redactProxyUrl(url) };
}

/**
 * TCP-connect to the proxy itself.
 *
 * This is what makes "is it the proxy or the site?" answerable rather than guessed. If we
 * cannot open a socket to the proxy's host:port, nothing downstream is worth reporting —
 * every target would fail for the same reason and listing three red rows would imply the
 * sites are blocked when in fact the proxy is simply not running.
 */
async function probeProxyEndpoint(proxyUrl: string, timeoutMs: number): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    return false;
  }
  const port =
    Number(u.port) ||
    (u.protocol === 'socks5:' || u.protocol === 'socks:' || u.protocol === 'socks5h:'
      ? 1080
      : u.protocol === 'https:'
        ? 443
        : 8080);
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function classify(err: unknown, proxyLive: boolean | null, viaProxy: boolean): ProxyProbeResult {
  const e = err as { cause?: unknown; message?: string; code?: string };
  const cause = (e?.cause ?? e) as { code?: string; message?: string };
  const code = cause?.code ?? e?.code ?? '';
  const msg = `${cause?.message ?? ''} ${e?.message ?? ''}`.toLowerCase();

  if (isProxyFault(err) || isProxyFault(e?.cause)) return 'proxy_unreachable';
  if (msg.includes('407') || msg.includes('proxy authentication')) return 'proxy_auth_failed';
  if (viaProxy && proxyLive === false) return 'proxy_unreachable';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return viaProxy ? 'upstream_unreachable' : 'dns_failed';
  if (code === 'ECONNREFUSED' && viaProxy) return 'proxy_unreachable';
  return 'upstream_unreachable';
}

/**
 * Run the "test connection" probes.
 *
 * Every probe reports whether it went through the proxy, because a green row that was
 * silently bypassed by `no_proxy` proves nothing about the proxy.
 */
export async function testProxyConnectivity(
  cfg: ProxyConfig,
  opts: {
    targets?: ReadonlyArray<{ target: string; url: string }>;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ProxyTestReport> {
  const targets = opts.targets ?? DEFAULT_PROBE_TARGETS;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const env = opts.env ?? process.env;

  // Which proxy would actually be used? Check it once, before blaming any website.
  const sampleProxy = targets
    .map((t) => proxyUrlFor(cfg, t.url, env))
    .find((p): p is string => Boolean(p));
  const proxyReachable = sampleProxy ? await probeProxyEndpoint(sampleProxy, timeoutMs) : null;

  const dispatcher = new RoutingDispatcher(cfg, env);
  const probes: ProxyProbe[] = [];
  try {
    for (const t of targets) {
      const proxyUrl = proxyUrlFor(cfg, t.url, env);
      const viaProxy = Boolean(proxyUrl);
      const started = Date.now();

      if (viaProxy && proxyReachable === false) {
        probes.push({
          target: t.target,
          url: t.url,
          result: 'proxy_unreachable',
          viaProxy,
          elapsedMs: Date.now() - started,
          detail: `连不上代理 ${redactProxyUrl(proxyUrl)} —— 未向 ${t.target} 发出请求`,
        });
        continue;
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        // undici's own fetch, not the global one: it takes `dispatcher` natively, so the
        // probe is guaranteed to use the config under test rather than whatever is
        // currently installed globally.
        const res = await undiciFetch(t.url, {
          method: 'GET',
          headers: { 'user-agent': 'openmemo-proxy-probe' },
          signal: ac.signal,
          dispatcher,
        });
        await res.arrayBuffer().catch(() => undefined);
        probes.push({
          target: t.target,
          url: t.url,
          result: res.status === 407 ? 'proxy_auth_failed' : res.ok ? 'ok' : 'upstream_error',
          viaProxy,
          httpStatus: res.status,
          elapsedMs: Date.now() - started,
        });
      } catch (err) {
        probes.push({
          target: t.target,
          url: t.url,
          result: classify(err, proxyReachable, viaProxy),
          viaProxy,
          elapsedMs: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    void dispatcher.close().catch(() => undefined);
  }

  return {
    ok: probes.every((p) => p.result === 'ok' || p.result === 'skipped'),
    proxyReachable,
    probes,
  };
}
