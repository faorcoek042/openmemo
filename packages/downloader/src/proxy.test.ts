/**
 * `classify()` — zero test coverage since the day it was written.
 *
 * ## Why this exists
 *
 * `grep -rn "classify(" packages/ apps/` used to return exactly two hits: the function's
 * own definition and its one call site inside `testProxyConnectivity()`'s catch block.
 * That function decides which of several very different user-facing verdicts a failed
 * probe gets — "your proxy is down" vs "the target is unreachable, not your proxy" vs
 * "we don't know" — entirely from pattern-matching a thrown error's `code`/`message`/
 * `cause`. Untested pattern-matching against loosely-typed error shapes is exactly the
 * kind of code that silently drifts wrong when a dependency (undici, the socks lib)
 * changes how it shapes an error.
 *
 * The fallback branch is the one this file cares about most: it used to return
 * `'upstream_unreachable'` for literally anything unmatched, which is a specific claim
 * ("the problem is not your proxy") made with no evidence. It now returns `'unclassified'`
 * — see `proxy.ts`'s comment on that branch for the full reasoning, including why
 * TLS-chain errors (the shape a corporate MITM proxy produces) are deliberately routed
 * here too rather than getting their own dedicated state.
 *
 * ## Synthetic error shapes
 *
 * These mirror what undici's `fetch()` actually throws, not idealised errors: a
 * `TypeError('fetch failed', { cause })` where the interesting `code`/`message` live on
 * `.cause`, because that is the shape `classify()`'s `e?.cause ?? e` line exists to unwrap.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classify } from './proxy.js';

/** Undici's real shape: the informative error is nested one level down in `.cause`. */
function fetchFailed(cause: { code?: string; message?: string }): Error {
  const c = Object.assign(new Error(cause.message ?? ''), cause.code ? { code: cause.code } : {});
  return new TypeError('fetch failed', { cause: c });
}

/** What `tagSocksError()` produces — a SOCKS-layer failure tagged so it is never mistaken
 *  for a target-side problem, regardless of what its message says. */
function socksFault(message: string): Error {
  return Object.assign(new Error(message), { openmemoProxyFault: true as const });
}

describe('classify()', () => {
  it('SOCKS proxy fault (tagged by tagSocksError) → proxy_unreachable, no matter the message', () => {
    // The message here deliberately looks like a DNS failure — the tag must win over any
    // string-matching heuristic, because it is ground truth from the SOCKS layer itself.
    assert.equal(classify(socksFault('getaddrinfo ENOTFOUND'), null, true), 'proxy_unreachable');
  });

  it('SOCKS fault nested in .cause is also caught (isProxyFault checks e?.cause too)', () => {
    const wrapped = new TypeError('fetch failed', { cause: socksFault('connect refused') });
    assert.equal(classify(wrapped, null, true), 'proxy_unreachable');
  });

  it('407 mentioned in the message → proxy_auth_failed (belt-and-braces alongside probeProxy)', () => {
    assert.equal(
      classify(fetchFailed({ message: 'Proxy responded with 407' }), null, true),
      'proxy_auth_failed',
    );
  });

  it('"proxy authentication" phrase alone (no literal 407) also → proxy_auth_failed', () => {
    assert.equal(
      classify(fetchFailed({ message: 'Proxy Authentication Required' }), null, true),
      'proxy_auth_failed',
    );
  });

  it('viaProxy + proxyLive===false → proxy_unreachable, even for an otherwise-blank error', () => {
    // proxyLive is the CONNECT-probe's own verdict, passed in from testProxyConnectivity.
    // When it already says the proxy is down, an unrelated fetch error should not
    // override that with a different, wrong attribution.
    assert.equal(classify(new Error('socket hang up'), false, true), 'proxy_unreachable');
  });

  it('proxyLive===false but viaProxy===false (direct connection) does NOT blame the proxy', () => {
    // proxyLive only means something for requests that actually went through it.
    assert.equal(classify(fetchFailed({ code: 'ENOTFOUND' }), false, false), 'dns_failed');
  });

  it('ENOTFOUND via proxy → upstream_unreachable (the target host, not the tunnel, failed to resolve)', () => {
    assert.equal(classify(fetchFailed({ code: 'ENOTFOUND' }), true, true), 'upstream_unreachable');
  });

  it('ENOTFOUND direct (no proxy) → dns_failed', () => {
    assert.equal(classify(fetchFailed({ code: 'ENOTFOUND' }), null, false), 'dns_failed');
  });

  it('EAI_AGAIN direct → dns_failed (same bucket as ENOTFOUND, different libc errno)', () => {
    assert.equal(classify(fetchFailed({ code: 'EAI_AGAIN' }), null, false), 'dns_failed');
  });

  it('ECONNREFUSED via proxy → proxy_unreachable (nothing is listening at the proxy address)', () => {
    assert.equal(classify(fetchFailed({ code: 'ECONNREFUSED' }), null, true), 'proxy_unreachable');
  });

  it('ECONNREFUSED direct (no proxy) → falls through to unclassified, NOT proxy_unreachable', () => {
    // The ECONNREFUSED branch is explicitly gated on viaProxy — refusing to guess which
    // side refused the connection when there was no proxy in the path at all.
    assert.equal(classify(fetchFailed({ code: 'ECONNREFUSED' }), null, false), 'unclassified');
  });

  it('★ unmatched error → unclassified, not a specific-but-guessed verdict (the fix this file exists for)', () => {
    assert.equal(classify(fetchFailed({ code: 'ECONNRESET' }), null, true), 'unclassified');
  });

  it('★ TLS chain errors (MITM-proxy shape) fall into unclassified — no dedicated tls_intercepted state', () => {
    // Deliberate, not an oversight: see the long comment on classify()'s fallback branch.
    // No "trust this CA" feature exists in the product yet, and this single error code has
    // several unrelated real causes (enterprise CA, a genuinely broken target cert, clock
    // skew, an expired root store) — naming it would manufacture a different
    // specific-but-possibly-wrong verdict, the exact failure mode being fixed here.
    for (const code of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
    ]) {
      assert.equal(classify(fetchFailed({ code }), null, true), 'unclassified');
    }
  });

  it('a bare Error with no code and no cause → unclassified', () => {
    assert.equal(classify(new Error('something odd'), null, true), 'unclassified');
  });
});
