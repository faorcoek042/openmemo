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
  type SourceLatency,
  type SourceLatencyReport,
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

/**
 * Target for the proxy test proper.
 *
 * A neutral host that is blocked without a proxy on the networks this feature exists for.
 * Deliberately NOT one of our download mirrors: if the proxy test used Hugging Face and
 * it failed, the user could not tell whether their proxy is broken or Hugging Face is
 * having a bad day. A separate host makes "is the proxy working" a question with one
 * cause.
 */
export const PROXY_TEST_TARGET = { target: 'YouTube', url: 'https://www.youtube.com/generate_204' };

/** Download sources, measured as a comparison table — a separate action from the above. */
export const DOWNLOAD_SOURCE_TARGETS: ReadonlyArray<{
  provider: string;
  label: string;
  url: string;
}> = [
  {
    provider: 'hf',
    label: 'Hugging Face',
    url: 'https://huggingface.co/api/models/ggerganov/whisper.cpp',
  },
  {
    provider: 'hf-mirror',
    label: 'hf-mirror 镜像',
    url: 'https://hf-mirror.com/api/models/ggerganov/whisper.cpp',
  },
  {
    provider: 'modelscope',
    label: 'ModelScope 魔搭',
    url: 'https://www.modelscope.cn/api/v1/models/Qwen/Qwen3-4B-GGUF/revisions',
  },
  { provider: 'github', label: 'GitHub', url: 'https://api.github.com/repos/ggml-org/whisper.cpp' },
];

/** @deprecated Use `PROXY_TEST_TARGET` / `DOWNLOAD_SOURCE_TARGETS`. */
export const DEFAULT_PROBE_TARGETS: ReadonlyArray<{ target: string; url: string }> = [
  PROXY_TEST_TARGET,
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
    await Promise.all([
      this.#direct.close(),
      ...[...this.#byProxyUrl.values()].map((a) => a.close()),
    ]);
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

/**
 * The proxy config **currently in effect for this process**, unredacted.
 *
 * Why this exists (and why it is not `activeProxySummary`): subprocesses — yt-dlp,
 * ffmpeg — cannot use `setGlobalDispatcher`. They need the real URL so it can be handed
 * to them as an argv flag / named env var. `activeProxySummary()` deliberately redacts
 * credentials because it feeds an HTTP response; this one is for in-process wiring only
 * and must never be serialised into a response body.
 *
 * Reading it at request time (rather than snapshotting at startup) is what makes
 * `PATCH /api/settings/proxy`'s `appliedImmediately: true` true for the subprocess paths
 * as well: `applyProxyConfig` updates `active` on every PATCH, so the next spawn picks
 * up the new value without a restart.
 */
export function activeProxyConfig(): ProxyConfig | null {
  return active?.cfg ?? null;
}

/** What is currently installed — for `/api/settings` readback and diagnostics. */
export function activeProxySummary(): { mode: string; proxy: string | null } | null {
  if (!active) return null;
  const { cfg } = active;
  const url =
    cfg.mode === 'manual' ? (cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy ?? null) : null;
  return { mode: cfg.mode, proxy: redactProxyUrl(url) };
}

type ProxyHealth = 'ok' | 'unreachable' | 'auth_failed';

const isSocks = (p: string) => p === 'socks5:' || p === 'socks:' || p === 'socks5h:';

/**
 * Talk to the proxy itself and find out whether it will actually carry traffic for us.
 *
 * This does a real CONNECT handshake rather than a bare TCP connect, because undici
 * destroys the evidence we need: when a proxy answers `407 Proxy Authentication
 * Required`, the error that reaches the caller is `TypeError: fetch failed` /
 * `cause.message = "Request was cancelled."` / `cause.code = 0`. The status code is gone,
 * so no amount of error-string matching can distinguish a wrong proxy password from an
 * unreachable website — and those two send the user to completely different fixes.
 * Reading the CONNECT status line ourselves is the only reliable source of that answer.
 */
async function probeProxy(
  proxyUrl: string,
  timeoutMs: number,
  sampleHost: string,
): Promise<ProxyHealth> {
  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    return 'unreachable';
  }

  if (isSocks(u.protocol)) {
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: u.hostname,
          port: Number(u.port) || 1080,
          type: 5,
          userId: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
        },
        command: 'connect',
        destination: { host: sampleHost, port: 443 },
        timeout: timeoutMs,
      });
      socket.destroy();
      return 'ok';
    } catch (err) {
      const m = (err instanceof Error ? err.message : '').toLowerCase();
      // The socks library reports a failed method negotiation / bad credentials distinctly
      // from a refused connection.
      if (m.includes('authentication') || m.includes('auth')) return 'auth_failed';
      return 'unreachable';
    }
  }

  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 8080);
  return new Promise<ProxyHealth>((resolve) => {
    const sock = net.connect({ host: u.hostname, port });
    let buf = '';
    let settled = false;
    /*
     * Once the TCP connection is established, the proxy is PROVEN to be up, and no later
     * failure may be attributed to it.
     *
     * This flag exists because of a bug this very test caught: the probe used to CONNECT
     * to the caller's target host, so probing an unresolvable target made a perfectly
     * healthy proxy get reported as "proxy unreachable" — sending the user to debug the
     * one component that was working. Proxy liveness and tunnel success are two different
     * questions and only the first one belongs to the proxy.
     */
    let connected = false;
    const done = (r: ProxyHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      sock.destroy();
      resolve(r);
    };
    const giveUp = () => done(connected ? 'ok' : 'unreachable');
    /*
     * Hard deadline, on top of the socket's idle timeout. A proxy that accepts the
     * connection then hangs up without a status line fires neither 'error' nor 'timeout',
     * only 'close'. Without this the promise never settles and the "test connection"
     * button spins forever — worse than any failure it could report.
     */
    const deadline = setTimeout(giveUp, timeoutMs);
    sock.setTimeout(timeoutMs, giveUp);
    sock.once('error', giveUp);
    sock.once('close', giveUp);
    sock.once('connect', () => {
      connected = true;
      const auth =
        u.username || u.password
          ? 'Proxy-Authorization: Basic ' +
            Buffer.from(
              `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
            ).toString('base64') +
            '\r\n'
          : '';
      sock.write(`CONNECT ${sampleHost}:443 HTTP/1.1\r\nHost: ${sampleHost}:443\r\n${auth}\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n')) return;
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(buf)?.[1] ?? 0);
      if (status === 407) return done('auth_failed');
      if (status >= 200 && status < 300) return done('ok');
      // Any other status means the proxy answered but refused this tunnel; the proxy is
      // up, so the fault lies beyond it.
      return done('ok');
    });
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
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return viaProxy ? 'upstream_unreachable' : 'dns_failed';
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
  const targets = opts.targets ?? [PROXY_TEST_TARGET];
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const env = opts.env ?? process.env;

  // Which proxy would actually be used? Check it once, before blaming any website.
  const sampleIdx = targets.findIndex((t) => proxyUrlFor(cfg, t.url, env));
  const sampleProxy = sampleIdx >= 0 ? proxyUrlFor(cfg, targets[sampleIdx]!.url, env) : null;
  const sampleHost = sampleIdx >= 0 ? new URL(targets[sampleIdx]!.url).hostname : 'example.com';
  const health: ProxyHealth | null = sampleProxy
    ? await probeProxy(sampleProxy, timeoutMs, sampleHost)
    : null;
  const proxyReachable = health === null ? null : health !== 'unreachable';

  const dispatcher = new RoutingDispatcher(cfg, env);
  const probes: ProxyProbe[] = [];
  try {
    for (const t of targets) {
      const proxyUrl = proxyUrlFor(cfg, t.url, env);
      const viaProxy = Boolean(proxyUrl);
      const started = Date.now();

      // Both short-circuits come from the CONNECT handshake, which is the only place the
      // 407 still exists — by the time undici reports back, it has been flattened into a
      // generic "Request was cancelled."
      if (viaProxy && health === 'unreachable') {
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
      if (viaProxy && health === 'auth_failed') {
        probes.push({
          target: t.target,
          url: t.url,
          result: 'proxy_auth_failed',
          viaProxy,
          elapsedMs: Date.now() - started,
          detail: `代理 ${redactProxyUrl(proxyUrl)} 拒绝了凭据（407）—— 请检查用户名/密码，不是上游的问题`,
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

/**
 * Measure latency to each download source — the second, separate action.
 *
 * Sources are probed CONCURRENTLY and reported as a table rather than a verdict. This is
 * the piece that answers "which mirror should I use", and it is why ADR-004's multi-source
 * probing and the proxy are orthogonal rather than competing: a proxied Hugging Face can
 * genuinely beat a direct hf-mirror, and the only way to know on this user's network is to
 * measure both under the proxy config that is actually in force. Ranking by measurement
 * keeps working no matter which combination wins.
 */
export async function measureDownloadSources(
  cfg: ProxyConfig,
  opts: {
    sources?: ReadonlyArray<{ provider: string; label: string; url: string }>;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<SourceLatencyReport> {
  const sources = opts.sources ?? DOWNLOAD_SOURCE_TARGETS;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const env = opts.env ?? process.env;
  const dispatcher = new RoutingDispatcher(cfg, env);

  try {
    const rows = await Promise.all(
      sources.map(async (s): Promise<SourceLatency> => {
        const viaProxy = Boolean(proxyUrlFor(cfg, s.url, env));
        const started = Date.now();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await undiciFetch(s.url, {
            method: 'GET',
            headers: { 'user-agent': 'openmemo-source-probe' },
            signal: ac.signal,
            dispatcher,
          });
          // Time to first byte, not full body: we are ranking reachability and round-trip,
          // and the payloads differ in size across these APIs, so total time would compare
          // the endpoints rather than the network path.
          const latencyMs = Date.now() - started;
          await res.arrayBuffer().catch(() => undefined);
          return {
            provider: s.provider,
            label: s.label,
            url: s.url,
            reachable: res.ok,
            latencyMs: res.ok ? latencyMs : null,
            viaProxy,
            httpStatus: res.status,
            ...(res.ok ? {} : { detail: `HTTP ${res.status}` }),
          };
        } catch (err) {
          return {
            provider: s.provider,
            label: s.label,
            url: s.url,
            reachable: false,
            latencyMs: null,
            viaProxy,
            detail: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    const best = rows
      .filter((r) => r.reachable && r.latencyMs !== null)
      .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))[0];

    return { measuredAt: new Date().toISOString(), rows, fastest: best?.provider ?? null };
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}
