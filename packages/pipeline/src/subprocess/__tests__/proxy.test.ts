/**
 * Proxy configuration.
 *
 * Run: node --test packages/pipeline/dist/subprocess/__tests__/proxy.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ⚠️ `redactProxyUrl` **刻意从包的公开出口 index.js 取**，不从 `../proxy.js` 取：
// 它现在是转发 `@openmemo/shared` 的那一份，本包内已无实现。
// 从 index 取才能钉住"外面 import @openmemo/pipeline 拿到的是权威那份"。
import { redactProxyUrl } from '../../index.js';
import { ffmpegProxySupport, proxyEnv, validateProxyUrl, ytDlpProxyArgs } from '../proxy.js';

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

describe('redactProxyUrl —— 现在转发的是 @openmemo/shared 那份', () => {
  /*
   * ⚠️ **旧断言钉住的是一份分叉的副本**（HANDOFF ⑤A-15 同族）。
   * 本包此前有一份自己的 `redactProxyUrl`，与 shared 那份输出不同，
   * 而三个真消费方（daemon rest/proxy、daemon selfcheck、downloader proxy）
   * import 的**全都是 shared 那份** —— 也就是说这条测试一直在钉一段
   * 生产里没人跑的代码，同时让"有两份实现"这件事看起来是被测试覆盖的。
   *
   * 旧断言写的是：redactProxyUrl('http://user:secret@127.0.0.1:7890')
   *                 === 'http://***@127.0.0.1:7890'
   * 权威那份给的是 'http://***:***@127.0.0.1:7890/'（密码位也打码、保留末尾斜杠）。
   * 这里改成断言权威值，并补上当初两份分叉得最厉害的那两个输入。
   */
  it('凭据在进日志之前被抹掉（值取自 @openmemo/shared 的权威实现）', () => {
    assert.equal(
      redactProxyUrl('http://user:secret@127.0.0.1:7890'),
      'http://***:***@127.0.0.1:7890/',
    );
  });

  it('★ 只有密码没有用户名时，端口不许丢 —— 旧的本地副本会丢', () => {
    // 旧副本：'http://***@h'（:80 被 URL 规范化吃掉，且看起来像"只有用户名"）
    assert.equal(redactProxyUrl('http://:pass@h:80'), 'http://:***@h/');
  });

  it('★ 空值返回 null，不返回 "<invalid proxy url>" —— 没配代理不是配错了代理', () => {
    // 旧副本对 '' / null 一律给 '<invalid proxy url>'，那会让"未配置"显示成"配错了"。
    assert.equal(redactProxyUrl(''), null);
    assert.equal(redactProxyUrl(null), null);
    // 真的写错了才给占位符
    assert.equal(redactProxyUrl('not a url'), '<invalid proxy url>');
  });
});
