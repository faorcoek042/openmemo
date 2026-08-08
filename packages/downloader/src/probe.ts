/**
 * Mirror source probing and ranking.
 *
 * ADR-004 decision 1: rather than answer "does hf-mirror.com work from inside China?"
 * (unanswerable from our US-egress machine — it 308-redirects non-CN traffic straight
 * back to huggingface.co), we make the product not need the answer. Probe every
 * configured source concurrently, rank by measured speed, fail over automatically.
 *
 * Explicitly NOT GeoIP: VPN users, overseas users, corporate proxies and IPv6 all break
 * geo-guessing, and the cost of guessing wrong is a user stuck at 0%.
 */

import { HttpError } from './http.js';

export interface ProbeTarget {
  provider: string;
  /** URL of a small, always-present file used as the probe object. */
  url: string;
  official: boolean;
}

export interface ProbeOutcome {
  provider: string;
  ok: boolean;
  ttfbMs: number | null;
  throughputKbps: number | null;
  error: string | null;
  probedAt: string;
}

/** Bytes to pull when measuring. Big enough to measure throughput, small enough to be cheap. */
export const PROBE_BYTES = 256 * 1024;
export const PROBE_TIMEOUT_MS = 5000;

export async function probeSource(
  target: ProbeTarget,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  const probedAt = new Date().toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(target.url, {
      method: 'GET',
      headers: { range: `bytes=0-${PROBE_BYTES - 1}`, 'user-agent': 'OpenMemo/0.1' },
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!res.ok && res.status !== 206) {
      return {
        provider: target.provider,
        ok: false,
        ttfbMs: null,
        throughputKbps: null,
        error: `HTTP ${res.status}`,
        probedAt,
      };
    }
    const ttfb = Date.now() - t0;
    const buf = await res.arrayBuffer();
    const elapsed = Math.max(1, Date.now() - t0);
    const kbps = Math.round((buf.byteLength / 1024 / elapsed) * 1000);
    return {
      provider: target.provider,
      ok: buf.byteLength > 0,
      ttfbMs: ttfb,
      throughputKbps: kbps,
      error: null,
      probedAt,
    };
  } catch (e) {
    const msg =
      e instanceof HttpError
        ? e.message
        : (e as Error)?.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : ((e as Error)?.message ?? String(e));
    return {
      provider: target.provider,
      ok: false,
      ttfbMs: null,
      throughputKbps: null,
      error: msg,
      probedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe all targets concurrently. One slow source must not delay the others. */
export async function probeAll(
  targets: ProbeTarget[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome[]> {
  return Promise.all(targets.map((t) => probeSource(t, timeoutMs)));
}

/**
 * Score a probe. Throughput dominates; latency is a tiebreaker.
 * Unofficial mirrors are penalised 20% so an official source wins a near-tie — content
 * is guaranteed by digest either way, but official sources are likelier to stay up.
 */
export function scoreProbe(o: ProbeOutcome, official: boolean): number {
  if (!o.ok || o.throughputKbps == null) return 0;
  const latencyPenalty = 1 + (o.ttfbMs ?? 0) / 1000;
  const base = o.throughputKbps / latencyPenalty;
  return official ? base : base * 0.8;
}

export function rankSources(targets: ProbeTarget[], outcomes: ProbeOutcome[]): ProbeTarget[] {
  const byProvider = new Map(outcomes.map((o) => [o.provider, o]));
  return [...targets]
    .map((t) => {
      const o = byProvider.get(t.provider);
      return { t, score: o ? scoreProbe(o, t.official) : 0 };
    })
    .sort((a, b) => b.score - a.score)
    .filter((x) => x.score > 0)
    .map((x) => x.t);
}

/**
 * Ordered source list for a download.
 *
 * Ranked-but-unreachable sources are appended rather than dropped: a probe is a 5-second
 * snapshot, and a source that failed the probe may still work for the real transfer.
 * Dropping it entirely could leave a user with no sources at all.
 */
export function orderSourcesForDownload(
  targets: ProbeTarget[],
  outcomes: ProbeOutcome[],
  pinned?: string | null,
): ProbeTarget[] {
  if (pinned && pinned !== 'auto') {
    const hit = targets.filter((t) => t.provider === pinned);
    const rest = targets.filter((t) => t.provider !== pinned);
    return [...hit, ...rest];
  }
  const ranked = rankSources(targets, outcomes);
  const rest = targets.filter((t) => !ranked.some((r) => r.provider === t.provider));
  return [...ranked, ...rest];
}
