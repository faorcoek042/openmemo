/**
 * Proxy configuration.
 *
 * Run: node --test packages/pipeline/dist/subprocess/__tests__/proxy.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ffmpegProxySupport,
  proxyEnv,
  redactProxyUrl,
  validateProxyUrl,
  ytDlpProxyArgs,
} from '../proxy.js';

describe('validateProxyUrl', () => {
  it('accepts http and every SOCKS flavour', () => {
    for (const u of [
      'http://127.0.0.1:7890',
      'https://proxy.corp:8080',
      'socks5://127.0.0.1:1080',
      'socks5h://127.0.0.1:1080',
      'socks4://10.0.0.1:1080',
    ]) {
      assert.equal(validateProxyUrl(u).ok, true, u);
    }
  });

  it('ALLOWS a private address — a local proxy is the normal case', () => {
    // Deliberately unlike media URLs: the user is declaring their own egress path, not
    // naming a resource to fetch, so the SSRF check must not apply here.
    assert.equal(validateProxyUrl('http://127.0.0.1:7890').ok, true);
    assert.equal(validateProxyUrl('socks5://192.168.1.1:1080').ok, true);
  });

  it('rejects an option-shaped value — it becomes argv for yt-dlp --proxy', () => {
    const r = validateProxyUrl('--proxy=http://evil');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'leading_dash');
  });

  it('rejects control characters BEFORE parsing', () => {
    // new URL() strips \n silently; checking after would launder the string.
    const r = validateProxyUrl('http://a\nb:80');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'control_characters');
  });

  it('rejects unsupported schemes', () => {
    for (const u of ['ftp://x:21', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const r = validateProxyUrl(u);
      assert.equal(r.ok, false, u);
      if (!r.ok) assert.ok(['bad_scheme', 'unparseable'].includes(r.code));
    }
  });
});

describe('proxyEnv', () => {
  it('always bypasses loopback — our own API must not be proxied', () => {
    const env = proxyEnv({ url: 'http://127.0.0.1:7890' });
    assert.match(env.no_proxy!, /127\.0\.0\.1/);
    assert.match(env.NO_PROXY!, /localhost/);
    assert.match(env.no_proxy!, /::1/);
  });

  it('sets both cases — tools disagree about which they read', () => {
    const env = proxyEnv({ url: 'http://127.0.0.1:7890' });
    assert.equal(env.http_proxy, env.HTTP_PROXY);
    assert.equal(env.https_proxy, env.HTTPS_PROXY);
  });

  it('adds ALL_PROXY only for SOCKS', () => {
    assert.equal(proxyEnv({ url: 'http://127.0.0.1:7890' }).ALL_PROXY, undefined);
    assert.equal(proxyEnv({ url: 'socks5://127.0.0.1:1080' }).ALL_PROXY, 'socks5://127.0.0.1:1080');
  });

  it('appends the user bypass list to the mandatory one', () => {
    const env = proxyEnv({ url: 'http://p:1', noProxy: 'internal.corp' });
    assert.match(env.no_proxy!, /127\.0\.0\.1/);
    assert.match(env.no_proxy!, /internal\.corp/);
  });

  it('yields nothing for an invalid config rather than a broken env', () => {
    assert.deepEqual(proxyEnv({ url: 'ftp://nope' }), {});
    assert.deepEqual(proxyEnv(null), {});
  });
});

describe('ffmpegProxySupport — states the SOCKS limitation instead of hiding it', () => {
  it('reports SOCKS as unsupported with a reason', () => {
    const r = ffmpegProxySupport({ url: 'socks5://127.0.0.1:1080' });
    assert.equal(r.supported, false);
    assert.deepEqual(r.env, {}, 'must not set env that ffmpeg will ignore');
    assert.match(r.reason ?? '', /SOCKS/);
  });

  it('supports http/https and returns the env', () => {
    const r = ffmpegProxySupport({ url: 'http://127.0.0.1:7890' });
    assert.equal(r.supported, true);
    assert.equal(r.env.http_proxy, 'http://127.0.0.1:7890');
  });
});

describe('ytDlpProxyArgs', () => {
  it('passes the flag explicitly', () => {
    assert.deepEqual(ytDlpProxyArgs({ url: 'socks5://127.0.0.1:1080' }), [
      '--proxy',
      'socks5://127.0.0.1:1080',
    ]);
  });

  it('degrades to no-proxy on a bad config instead of breaking the invocation', () => {
    assert.deepEqual(ytDlpProxyArgs({ url: 'not a url' }), []);
    assert.deepEqual(ytDlpProxyArgs(null), []);
  });
});

describe('redactProxyUrl', () => {
  it('strips credentials before they reach a log', () => {
    assert.equal(redactProxyUrl('http://user:secret@127.0.0.1:7890'), 'http://***@127.0.0.1:7890');
  });
});
