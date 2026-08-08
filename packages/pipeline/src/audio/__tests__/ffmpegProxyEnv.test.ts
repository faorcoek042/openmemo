/**
 * ffmpeg / ffprobe 读远端 URL 时，代理**真的进到了子进程环境里**。
 *
 * ## 为什么这条要单独用单测守
 *
 * `scripts/ci/proxy-coverage-audit.mjs` 起一个真代理逐条量出网路径，但 ffprobe 那一格
 * **在明文 http 上量不到**：`audio/ffmpeg.ts` 的
 *     REMOTE_PROTOCOLS = 'https,tls,tcp,crypto,httpproxy'
 * **不含 `http`**，所以对 `http://` 的远端输入，ffprobe 在 `-protocol_whitelist`
 * 这一关就拒了，一个包都不会发。那个"代理没看到 ffprobe"的真实含义是
 * **"ffprobe 根本没跑"**，不是"它绕过去了" —— 我第一版正是把它误报成了缺陷。
 *
 * 要在端到端层面量它就得架一个真的 https 源站（还得让 ffprobe 信任那张证书），
 * 成本远大于收益。所以改用**确定性**判据：直接问 `buildChildEnv()`
 * ——「给了 proxy，子进程环境里到底有没有 http_proxy」。
 *
 * ## 它守的是什么
 *
 * 子进程环境是**按白名单从零重建**的（`runner.ts:buildChildEnv`），
 * 目的是挡 `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` / `NODE_OPTIONS` 这类加载器变量。
 * 代价是 `http_proxy` **也不会**被继承 —— 这正是代理曾经到不了 ffmpeg 的原因。
 * 正确修法不是把白名单拆开，而是从**已校验的配置**里**具名注入**。
 * 这组用例把这两件事同时钉住：注入要生效，继承要仍然被挡住。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildChildEnv } from '../../subprocess/runner.js';
import { ffmpegProxySupport } from '../../subprocess/proxy.js';

describe('ffmpeg/ffprobe 的代理注入', () => {
  it('★ 给了 proxy，子进程环境里就有 http_proxy（这条断言就是那个修复本身）', () => {
    const env = buildChildEnv({}, { url: 'http://127.0.0.1:7890' });
    assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  });

  it('★ 不给 proxy，就一个代理变量都不该有（避免"默认走代理"这种反向意外）', () => {
    const env = buildChildEnv({}, null);
    for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy']) {
      assert.equal(env[k], undefined, `不该出现 ${k}`);
    }
  });

  it('★★ 白名单仍然挡着继承：宿主 env 里的 http_proxy 不许漏进子进程', () => {
    /*
     * 这一条是**反向**的：它守的不是代理功能，是那道安全防线没被"为了让代理过去"拆掉。
     * 直接改 process.env 再还原是有窗口的（PROTOCOL §9-bis），但这里只在本进程内、
     * 且 node:test 一个文件一个子进程 —— 退出即消失。仍然用 try/finally 收干净。
     */
    const KEY = 'http_proxy';
    const before = process.env[KEY];
    try {
      process.env[KEY] = 'http://evil.example:1';
      const env = buildChildEnv({}, null);
      assert.equal(env[KEY], undefined, '宿主环境里的 http_proxy 漏进了子进程 —— 白名单被拆开了');
    } finally {
      if (before === undefined) delete process.env[KEY];
      else process.env[KEY] = before;
    }
  });

  it('ffmpegProxySupport：http 代理受支持，socks 明确报不支持（libavformat 不认 SOCKS）', () => {
    const http = ffmpegProxySupport({ url: 'http://127.0.0.1:7890' });
    assert.equal(http.supported, true);
    assert.equal(http.env.http_proxy, 'http://127.0.0.1:7890');

    const socks = ffmpegProxySupport({ url: 'socks5://127.0.0.1:1080' });
    assert.equal(socks.supported, false);
    assert.equal(
      typeof socks.reason === 'string' && socks.reason.length > 0,
      true,
      '不支持就必须说清理由，否则调用方只能猜',
    );
  });

  it('null 配置 = 直连，不是"出错"', () => {
    const r = ffmpegProxySupport(null);
    assert.equal(r.supported, true);
    assert.deepEqual(r.env, {});
  });
});
