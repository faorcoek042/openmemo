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
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        range: 'bytes=0-0',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      redirect: 'follow',
      signal: ac.signal,
    });
    // Drain so the socket can be reused rather than left dangling.
    await res.arrayBuffer().catch(() => undefined);

    const err = classifyStatus(res.status, res.headers);
    if (err) throw err;

    const h = res.headers;
    let size: number | null = null;

    const linked = h.get('x-linked-size');
    if (linked) size = Number(linked);

    if (size == null) {
      // 206 → parse "bytes 0-0/12345"; 200 → content-length is the whole file.
      const cr = h.get('content-range');
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) size = Number(m[1]);
      } else {
        const cl = h.get('content-length');
        if (cl) size = Number(cl);
      }
    }

    const linkedEtag = unquoteEtag(h.get('x-linked-etag'));
    const sha256 = linkedEtag && /^[a-f0-9]{64}$/.test(linkedEtag) ? linkedEtag : null;

    return {
      sizeBytes: Number.isFinite(size as number) ? (size as number) : null,
      sha256,
      etag: unquoteEtag(h.get('etag')),
      lastModified: h.get('last-modified'),
      acceptRanges: res.status === 206 || h.get('accept-ranges') === 'bytes',
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
