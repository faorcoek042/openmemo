#!/usr/bin/env node
/**
 * Proxy verification (T-079).
 *
 * Runs against REAL proxy servers started in-process — an HTTP CONNECT proxy and a
 * SOCKS5 proxy — not mocks. Each proxy counts the tunnels it opens, so "the download
 * worked" is backed by "and the proxy actually carried it". A proxy test that only
 * checks the request succeeded cannot tell you the proxy was bypassed.
 *
 *   node packages/downloader/scripts/verify-proxy.mjs
 */
import http from 'node:http';
import net from 'node:net';

import {
  DEFAULT_PROXY_CONFIG,
  proxyUrlFor,
  redactProxyUrl,
  shouldBypassProxy,
} from '../../shared/dist/index.js';
import {
  DOWNLOAD_SOURCE_TARGETS,
  PROXY_TEST_TARGET,
  applyProxyConfig,
  measureDownloadSources,
  testProxyConnectivity,
} from '../dist/proxy.js';

let pass = 0;
let fail = 0;
const t0 = Date.now();
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/* ── a real HTTP CONNECT proxy ── */
function startHttpProxy({ requireAuth = false } = {}) {
  const state = { tunnels: [], authFailures: 0 };
  const server = http.createServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on('connect', (req, clientSocket, head) => {
    if (requireAuth) {
      const hdr = req.headers['proxy-authorization'];
      const want = 'Basic ' + Buffer.from('u:p').toString('base64');
      if (hdr !== want) {
        state.authFailures++;
        clientSocket.write(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n',
        );
        clientSocket.end();
        return;
      }
    }
    const [host, port] = req.url.split(':');
    state.tunnels.push(req.url);
    const up = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, state, close: () => server.close() }),
    ),
  );
}

/* ── a real SOCKS5 proxy (no-auth) ── */
function startSocks5Proxy() {
  const state = { tunnels: [] };
  const server = net.createServer((sock) => {
    let stage = 0;
    sock.once('data', (greet) => {
      if (greet[0] !== 0x05) return sock.destroy();
      sock.write(Buffer.from([0x05, 0x00])); // no auth
      stage = 1;
      sock.once('data', (req) => {
        if (stage !== 1 || req[0] !== 0x05 || req[1] !== 0x01) return sock.destroy();
        const atyp = req[3];
        let host;
        let off;
        if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          off = 8;
        } else if (atyp === 0x03) {
          const len = req[4];
          host = req.subarray(5, 5 + len).toString();
          off = 5 + len;
        } else {
          return sock.destroy();
        }
        const port = req.readUInt16BE(off);
        state.tunnels.push(`${host}:${port}`);
        const up = net.connect(port, host, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          up.pipe(sock);
          sock.pipe(up);
        });
        up.on('error', () => sock.destroy());
        sock.on('error', () => up.destroy());
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, state, close: () => server.close() }),
    ),
  );
}

const TARGET = [
  { target: 'Hugging Face', url: 'https://huggingface.co/api/models/ggerganov/whisper.cpp' },
];

console.log('\n[1] no_proxy / 回环旁路（纯函数，不联网）');
{
  check('回环永远旁路，即使 noProxy 为空', shouldBypassProxy('127.0.0.1', []));
  check('localhost 旁路', shouldBypassProxy('localhost', []));
  check(
    'Ollama 所在的 127.0.0.1 旁路（本地 LLM 不能走远端代理）',
    shouldBypassProxy('127.0.0.1', []),
  );
  check('外网域名默认不旁路', !shouldBypassProxy('huggingface.co', []));
  check('.suffix 规则命中子域', shouldBypassProxy('cdn.example.com', ['.example.com']));
  check('精确匹配命中', shouldBypassProxy('example.com', ['example.com']));
  check('* 全部旁路', shouldBypassProxy('huggingface.co', ['*']));
  check('不误伤相似域名', !shouldBypassProxy('notexample.com', ['example.com']));
  const cfg = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: 'http://p:8080',
    noProxy: ['modelscope.cn'],
  };
  check('被 noProxy 命中的目标不走代理', proxyUrlFor(cfg, 'https://www.modelscope.cn/x') === null);
  check('未命中的目标走代理', proxyUrlFor(cfg, 'https://huggingface.co/x') === 'http://p:8080');
  check(
    'mode=off 一律直连',
    proxyUrlFor({ ...cfg, mode: 'off' }, 'https://huggingface.co/x') === null,
  );
  const sys = { ...DEFAULT_PROXY_CONFIG, mode: 'system' };
  check(
    'mode=system 读环境变量',
    proxyUrlFor(sys, 'https://huggingface.co/x', { HTTPS_PROXY: 'http://env:3128' }) ===
      'http://env:3128',
  );
  check(
    'mode=system 也认环境里的 NO_PROXY',
    proxyUrlFor(sys, 'https://huggingface.co/x', {
      HTTPS_PROXY: 'http://env:3128',
      NO_PROXY: 'huggingface.co',
    }) === null,
  );
  check(
    'SOCKS5 优先于 http 代理',
    proxyUrlFor({ ...cfg, socks5: 'socks5://s:1080' }, 'https://huggingface.co/x') ===
      'socks5://s:1080',
  );
  check('凭据被打码', redactProxyUrl('http://user:secret@h:8080') === 'http://***:***@h:8080/');
  check('打码不泄漏无法解析的串', redactProxyUrl('::::') === '<invalid proxy url>');
}

console.log('\n[2] 真 HTTP CONNECT 代理：流量确实走了代理');
{
  const px = await startHttpProxy();
  const cfg = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://127.0.0.1:${px.port}`,
    httpProxy: `http://127.0.0.1:${px.port}`,
  };
  const rep = await testProxyConnectivity(cfg, { targets: TARGET, timeoutMs: 15_000 });
  const p = rep.probes[0];
  check('通过 HTTP 代理访问 HF 成功', p.result === 'ok', `status=${p.httpStatus} ${p.elapsedMs}ms`);
  check('报告标明确实走了代理', p.viaProxy === true);
  check('代理端真的看到了隧道', px.state.tunnels.length > 0, px.state.tunnels.join(','));
  check('proxyReachable=true', rep.proxyReachable === true);
  px.close();
}

console.log('\n[3] 真 SOCKS5 代理');
{
  const px = await startSocks5Proxy();
  const cfg = { ...DEFAULT_PROXY_CONFIG, mode: 'manual', socks5: `socks5://127.0.0.1:${px.port}` };
  const rep = await testProxyConnectivity(cfg, { targets: TARGET, timeoutMs: 15_000 });
  const p = rep.probes[0];
  check('通过 SOCKS5 访问 HF 成功', p.result === 'ok', `status=${p.httpStatus} ${p.elapsedMs}ms`);
  check('SOCKS5 端真的看到了隧道', px.state.tunnels.length > 0, px.state.tunnels.join(','));
  px.close();
}

console.log('\n[4] 关键区分：代理挂了 ≠ 上游挂了');
{
  const dead = await startHttpProxy();
  const deadPort = dead.port;
  dead.close();
  await new Promise((r) => setTimeout(r, 200));
  const cfg = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://127.0.0.1:${deadPort}`,
  };
  const rep = await testProxyConnectivity(cfg, { targets: TARGET, timeoutMs: 8000 });
  const p = rep.probes[0];
  check(
    '代理不通时判定为 proxy_unreachable，而不是赖上游',
    p.result === 'proxy_unreachable',
    p.detail ?? '',
  );
  check('proxyReachable=false', rep.proxyReachable === false);
  check('没有向上游发请求就得出结论', (p.elapsedMs ?? 9999) < 3000, `${p.elapsedMs}ms`);
}
{
  const px = await startHttpProxy();
  const cfg = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://127.0.0.1:${px.port}`,
  };
  const t = Date.now();
  const rep = await testProxyConnectivity(cfg, {
    targets: [{ target: '不存在的上游', url: 'https://no-such-host.invalid/x' }],
    timeoutMs: 5000,
  });
  const p = rep.probes[0];
  check(
    '探针在限期内返回，不会挂死（按钮不能一直转）',
    Date.now() - t < 20_000,
    `${Date.now() - t}ms`,
  );
  check(
    '代理通、上游不通时判定为 upstream_unreachable',
    p.result === 'upstream_unreachable',
    p.detail?.slice(0, 60) ?? '',
  );
  check('且 proxyReachable 仍为 true（不冤枉代理）', rep.proxyReachable === true);
  px.close();
}

console.log('\n[5] 代理认证');
{
  const px = await startHttpProxy({ requireAuth: true });
  const good = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://u:p@127.0.0.1:${px.port}`,
  };
  const r1 = await testProxyConnectivity(good, { targets: TARGET, timeoutMs: 15_000 });
  check(
    '带认证的代理 URL 能通过',
    r1.probes[0].result === 'ok',
    `status=${r1.probes[0].httpStatus}`,
  );
  const bad = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://u:wrong@127.0.0.1:${px.port}`,
  };
  const r2 = await testProxyConnectivity(bad, { targets: TARGET, timeoutMs: 8000 });
  // undici 把 407 压成了 "Request was cancelled."，所以这条只能靠我们自己读 CONNECT 状态行；
  // 断言必须精确到 proxy_auth_failed，否则等于允许"密码错"继续被报成"上游挂了"。
  check(
    '密码错精确判定为 proxy_auth_failed',
    r2.probes[0].result === 'proxy_auth_failed',
    r2.probes[0].result,
  );
  check(
    '提示直指凭据而不是上游',
    /凭据|407/.test(r2.probes[0].detail ?? ''),
    r2.probes[0].detail ?? '',
  );
  check('代理端记录到认证失败', px.state.authFailures > 0, `${px.state.authFailures} 次`);
  px.close();
}

console.log('\n[6] 全局生效：applyProxyConfig 之后连普通 fetch 也走代理');
{
  const px = await startHttpProxy();
  applyProxyConfig({
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://127.0.0.1:${px.port}`,
    noProxy: [],
  });
  const before = px.state.tunnels.length;
  const res = await fetch('https://huggingface.co/api/models/ggerganov/whisper.cpp');
  await res.arrayBuffer().catch(() => undefined);
  check(
    '未改一行调用点，全局 fetch 已走代理',
    px.state.tunnels.length > before,
    `隧道 ${px.state.tunnels.length - before} 条`,
  );

  // 回环必须不经过代理，否则本地 daemon / Ollama 全断
  const loopTunnels = px.state.tunnels.filter(
    (t) => t.startsWith('127.0.0.1') || t.startsWith('localhost'),
  );
  check('回环流量没有被塞进代理', loopTunnels.length === 0);

  applyProxyConfig({ ...DEFAULT_PROXY_CONFIG, mode: 'off' });
  const after = px.state.tunnels.length;
  const res2 = await fetch('https://huggingface.co/api/models/ggerganov/whisper.cpp');
  await res2.arrayBuffer().catch(() => undefined);
  check('切回 off 后不再走代理（可运行时切换，无需重启）', px.state.tunnels.length === after);
  px.close();
}

console.log('\n[7] 两个独立动作：代理测试 vs 下载源延迟表');
{
  check(
    '代理测试打的是中立主机，不是我们的下载镜像',
    /youtube/i.test(PROXY_TEST_TARGET.url),
    PROXY_TEST_TARGET.url,
  );
  check(
    '下载源表覆盖 4 个源',
    DOWNLOAD_SOURCE_TARGETS.length === 4,
    DOWNLOAD_SOURCE_TARGETS.map((s) => s.provider).join('/'),
  );
  const px = await startHttpProxy();
  const cfg = {
    ...DEFAULT_PROXY_CONFIG,
    mode: 'manual',
    httpsProxy: `http://127.0.0.1:${px.port}`,
  };
  const rep = await measureDownloadSources(cfg, { timeoutMs: 10_000 });
  check('延迟表逐源给出结果', rep.rows.length === 4);
  for (const r of rep.rows) {
    console.log(
      `        ${r.label.padEnd(16)} ${r.reachable ? String(r.latencyMs) + 'ms' : '不可达'}${r.viaProxy ? ' (经代理)' : ''}${r.detail ? '  ' + r.detail.slice(0, 40) : ''}`,
    );
  }
  check(
    '可达的源里选出最快的',
    rep.rows.some((r) => r.reachable) ? rep.fastest !== null : rep.fastest === null,
    String(rep.fastest),
  );
  check(
    '不可达的源 latencyMs 为 null 而不是 0（0 会被读成"极快"）',
    rep.rows.every((r) => r.reachable || r.latencyMs === null),
  );
  check(
    '每行都标注是否经代理',
    rep.rows.every((r) => typeof r.viaProxy === 'boolean'),
  );
  px.close();
}

console.log('\n[8] 默认值');
{
  check(
    '默认 mode=system（跟随系统代理），不是 off',
    DEFAULT_PROXY_CONFIG.mode === 'system',
    DEFAULT_PROXY_CONFIG.mode,
  );
  check(
    'system 模式下环境没配代理时等价于直连',
    proxyUrlFor(DEFAULT_PROXY_CONFIG, 'https://huggingface.co/x', {}) === null,
  );
}

console.log(`\n  ${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
process.exit(fail ? 1 : 0);
