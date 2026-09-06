#!/usr/bin/env node
/**
 * proxy-coverage-audit.mjs — 「设置页说代理已生效」到底覆盖了哪几条出网路径？
 *
 * ## 为什么要有这个脚本
 *
 * `e2e-import` 那一轮查出：用户在设置页配的代理**永远到不了 yt-dlp**。
 * 而模型下载**是**走代理的 —— 于是设置页报 `appliedImmediately: true`，
 * 链接导入却仍然直连。**对中文用户，这接近于「F1 不可用」，而界面还在说「已生效」。**
 *
 * 判据不是"把 proxy 传下去就行"，是：
 *
 *   **设置页说已生效的东西，必须真的对它声称覆盖的每一条出网路径生效。**
 *
 * ## 怎么测：让"不走代理"变成**结构上不可能成功**
 *
 * 这里不读代码推断，而是起一个**真的本地正向代理**，把每条路径真跑一遍，
 * 看代理有没有收到请求。关键在探针主机名的选法：
 *
 *   `<probe-host>` 是一个**在本机解析不出来**的名字（`.test` TLD，且不写 hosts）。
 *
 * · 走代理 → 客户端只需把 `GET http://<probe-host>/x` 发给代理，**主机名由代理去解**
 *   → 代理收到请求 → 成功
 * · 不走代理 → 客户端自己解 DNS → NXDOMAIN → **失败**
 *
 * 所以"成功"本身就是"走了代理"的证据，不需要额外推断。
 * （产品的 `assertHostNotPrivate` 在 DNS 失败时**放行**
 *   —— `argGuard.ts:252-255`「Resolution failure is not a security failure」——
 *   所以解不出来这件事不会在到达代理之前就把请求拦掉。）
 *
 * https 那几条（模型下载、LLM API）走的是 CONNECT：代理**照实隧道到真站点**，
 * 只把 CONNECT 记下来当证据 —— 这样下载还是真的能成，测的不是一个残废环境。
 *
 * ## 安全边界（PROTOCOL §9 / §9-bis）
 *
 * 数据目录 `mkdtemp`、`OPENMEMO_POINTER_FILE` 重定向，**绝不写**全局指针；
 * 不改 hosts、不加 IP 别名、不用 `pkill`。端口用 199xx 段。
 */
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readdirSync,
  accessSync,
  constants as fsC,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const PORT = Number(arg('--port', '19900'));
const PROXY_PORT = Number(arg('--proxy-port', '19901'));
/** 刻意选一个**解析不出来**的名字：能通就只可能是走了代理。 */
const PROBE_HOST = arg('--probe-host', 'openmemo-proxy-probe.test');
const BUNDLE = arg('--bundle', null);
const ROOT = mkdtempSync(join(arg('--tmp-root', tmpdir()), 'openmemo-proxy-audit-'));
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const BASE = `http://127.0.0.1:${PORT}`;
const IS_WIN = process.platform === 'win32';

mkdirSync(DATA_DIR, { recursive: true });

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

/* ═════════ 本地正向代理：记录一切，并照实转发 ═════════ */

/** 代理收到的每一条请求。这就是"走没走代理"的**唯一**证据来源。 */
const hits = [];
let MP4 = Buffer.alloc(0);

/**
 * 探针主机的"源站"。**独立于代理端口**，因为它要同时服务两种到达方式：
 *   ① 明文代理：`GET http://<probe-host>/x`（绝对形式）直接进 `proxy` 的 handler
 *   ② CONNECT 隧道：见下面那段说明
 * 用 origin-form 的普通 http.Server 来服务，socket 由 CONNECT 处理器交进来。
 */
const originServer = createServer((req, res) => {
  const path = String(req.url ?? '');
  hits.push({
    kind: 'tunneled',
    method: req.method,
    url: `http://${PROBE_HOST}${path}`,
    host: PROBE_HOST,
    ua: String(req.headers['user-agent'] ?? ''),
  });
  say(
    `   [origin] ${req.method} ${path}  UA=${String(req.headers['user-agent'] ?? '(none)').slice(0, 60)}`,
  );
  serveProbe(req, res, path);
});

function serveProbe(req, res, pathname) {
  if (pathname.startsWith('/clip.mp4')) return serveMp4(req, res);
  if (pathname.startsWith('/watch')) {
    const html =
      `<!doctype html><html><head>` +
      `<meta property="og:video" content="http://${PROBE_HOST}/clip.mp4">` +
      `<meta property="og:title" content="proxy probe clip">` +
      `</head><body><video src="http://${PROBE_HOST}/clip.mp4"></video></body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(html)),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }
  res.writeHead(404).end('not found');
}

const proxy = createServer((req, res) => {
  const raw = String(req.url ?? '');
  let u;
  try {
    u = new URL(raw.startsWith('http') ? raw : `http://${req.headers.host}${raw}`);
  } catch {
    res.writeHead(400).end('bad target');
    return;
  }
  // 自连保护：转发给自己会变成无限循环。
  if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === PROXY_PORT) {
    res.writeHead(400).end('refusing to proxy to myself');
    return;
  }
  hits.push({
    kind: 'http',
    method: req.method,
    url: u.href,
    host: u.hostname,
    ua: String(req.headers['user-agent'] ?? ''),
  });
  say(
    `   [proxy] ${req.method} ${u.href}  UA=${String(req.headers['user-agent'] ?? '(none)').slice(0, 60)}`,
  );

  if (u.hostname === PROBE_HOST) return serveProbe(req, res, u.pathname + u.search);

  const up = httpRequest(
    {
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: req.method,
      headers: req.headers,
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
  });
  req.pipe(up);
});

/**
 * CONNECT。两种处置，分界线是"这个主机存不存在于真实世界"。
 *
 * ★★ `[实测]` 这里有一个**必须写下来**的坑，它把第一版的测量结果整个作废了：
 *
 *   **undici 的 `ProxyAgent` 对明文 http 目标也发 CONNECT**（不是只有 https 才隧道）。
 *   于是探针主机的请求以 `CONNECT openmemo-proxy-probe.test:80` 的形式到达，
 *   而我第一版无脑去 `netConnect` 那个**根本解析不出来的**主机 → 失败 → 断开
 *   → 客户端立刻重试 → **死循环**。实测一轮收到 306,685 次 CONNECT，
 *   把 89k/209k 这种荒唐的"证据"写进了报告，三条路径的结论全不可信。
 *
 *   教训与本仓那条「空集必须出声」是同一形状：**一个数量级不对的证据，
 *   比没有证据更危险** —— 它看起来像是测到了。
 *
 * 所以探针主机的 CONNECT **在本地终结隧道**：回 200，然后把这条 socket 直接交给
 * `originServer` 当普通 HTTP 连接来服务。别的主机才真的隧道出去。
 */
proxy.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = String(req.url ?? '').split(':');
  hits.push({ kind: 'connect', method: 'CONNECT', url: `connect://${host}`, host, ua: '' });
  say(`   [proxy] CONNECT ${req.url}`);

  if (host === PROBE_HOST) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) clientSocket.unshift(head);
    originServer.emit('connection', clientSocket);
    return;
  }
  if ((host === '127.0.0.1' || host === 'localhost') && Number(portStr) === PROXY_PORT) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const upstream = netConnect(Number(portStr ?? 443), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

function serveMp4(req, res) {
  const total = MP4.length;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m) {
    const start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
    const end =
      m[1] === '' ? total - 1 : m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    if (start >= total || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
      return;
    }
    const slice = MP4.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    });
    res.end(req.method === 'HEAD' ? undefined : slice);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
  });
  res.end(req.method === 'HEAD' ? undefined : MP4);
}

/* ═════════ daemon ═════════ */

const DAEMON = BUNDLE
  ? join(BUNDLE, 'app', 'daemon', 'dist', 'main.js')
  : join(REPO, 'apps', 'daemon', 'dist', 'main.js');
const NODE_BIN = BUNDLE ? join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node') : process.execPath;
if (!existsSync(DAEMON)) {
  console.error(`✘ 找不到 ${DAEMON} —— 先跑 pnpm build:safe`);
  process.exit(2);
}

const childEnv = {
  ...process.env,
  OPENMEMO_AUTH: 'none',
  OPENMEMO_DATA_DIR: DATA_DIR,
  OPENMEMO_POINTER_FILE: POINTER, // PROTOCOL §9
};

let proc = null;
const daemonLogs = [];
async function startDaemon() {
  proc = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => daemonLogs.push(String(d)));
  proc.stderr.on('data', (d) => daemonLogs.push(String(d)));
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const b = await res.json().catch(() => ({}));
        // 「端口上有东西应答」≠「我起的那个」—— 见 e2e-import-audit.mjs 里的同一条。
        if (b?.ready !== false && (b?.pid === undefined || b.pid === proc.pid)) return;
        if (b?.pid !== undefined && b.pid !== proc.pid) {
          throw new Error(`端口 ${PORT} 上是别人的 daemon（pid=${b.pid}）`);
        }
      }
    } catch (e) {
      if (String(e.message).includes('别人的 daemon')) throw e;
    }
    if (proc.exitCode !== null) break;
  }
  say('   ✘ daemon 没起来：');
  say(
    daemonLogs
      .join('')
      .split('\n')
      .slice(-40)
      .map((l) => `      ${l}`)
      .join('\n'),
  );
  throw new Error('daemon did not start');
}
async function stopDaemon() {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  if (proc.exitCode === null) proc.kill('SIGKILL');
  proc = null;
}

/*
 * ★ 带重试：Node 全局 fetch 的 keep-alive socket 被对端回收后复用会报 `fetch failed`，
 *   而 daemon 是活着的（`cold-start-audit.mjs:326-331` 记着同一现象）。
 *   重试的是**客户端的脆弱**，连续 5 次都失败仍然抛出去。
 */
const j = async (path, init) => {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, init);
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? 'fetch failed'}（已重试 5 次）`);
};
async function waitForJob(jobId, timeoutSec = 600) {
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const jr = await j(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (jr.status !== 200) return `HTTP ${jr.status}`;
    const job = jr.body?.job ?? jr.body;
    if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(job?.state)) {
      return `${job.state}${job.error ? ` — ${JSON.stringify(job.error).slice(0, 200)}` : ''}`;
    }
  }
  return 'TIMEOUT';
}

/* ═════════ 测量 ═════════ */

const results = [];
/** 记一条测量结果。`proxied` 三态：true / false / null(=没测成，说明原因)。 */
const record = (
  path,
  proxied,
  evidence,
  coveredBy = null,
  okLabel = '✅ 走代理',
  badLabel = '❌ **绕过代理**',
) => {
  results.push({ path, proxied, evidence, coveredBy, okLabel, badLabel });
  const mark =
    proxied === null ? (coveredBy ? '◐ 本轮测不到' : '⓵ 没测成') : proxied ? okLabel : badLabel;
  say(`   ${String(path).padEnd(34)} ${mark}  ${evidence}`);
};
/** 到达过这个主机的**全部**记录（含 CONNECT）—— 回答"有没有走代理"。 */
const sawHost = (host) => hits.filter((h) => h.host === host);
/**
 * 带 User-Agent 的记录 —— 回答"是**谁**去的"。
 *
 * ★ CONNECT 记录没有 UA，必须排掉：否则 `!/OpenMemo/.test('')` 恒真，
 *   一条 CONNECT 就会被算成"yt-dlp 来过"。（第一版就是这么误判的。）
 */
/**
 * yt-dlp 的 UA。**不能写成"不是 OpenMemo 就算 yt-dlp"** ——
 * `[实测]` direct-http 的 ranged-GET 兜底那一发**不带 UA**，
 * 于是"非 OpenMemo"把它算成了 yt-dlp，凭空报出一条"走代理"。
 * yt-dlp 默认伪装浏览器，认这个特征串才是准的（版本号每次都换，所以不比版本）。
 */
const isYtDlpUA = (ua) => /Mozilla\/5\.0/.test(ua) && /Chrome|Safari/.test(ua);

const sawUA = (host, pred) =>
  hits.filter((h) => h.host === host && typeof h.ua === 'string' && h.ua.length > 0 && pred(h.ua));

let exitCode = 0;
try {
  hdr('0. 起本地正向代理');
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  say(`   代理：http://127.0.0.1:${PROXY_PORT}`);
  say(`   探针主机：${PROBE_HOST}（**本机解析不出来** —— 能通就只可能是走了代理）`);

  hdr('1. 起 daemon（全新临时数据目录）');
  say(`   数据目录：${DATA_DIR}`);
  await startDaemon();

  hdr('2. 装 media-tools + yt-dlp + whisper（ASR 不能省，理由见下）');
  /*
   * ★ `[实测]` 第一版刻意不装 ASR「省时间」，结果 ⑥ 的 job 停在 **blocked**
   *   —— 缺组件时 job 根本不会跑，**yt-dlp 的 fetch 一次都没发生**，
   *   而我的脚本把"代理没看到请求"读成了"绕过代理"。
   *   那是一条**凭空捏造的缺陷**。没跑的东西不能报成跑了并失败了。
   */
  const cat = await j('/api/backends/catalog');
  const packs = (cat.body?.packs ?? []).filter((p) => p.applicable === true);
  for (const p of packs.filter((x) => /^(media-tools|ytdlp|whispercpp-cpu)-/.test(String(x.id)))) {
    const r = await j('/api/backends/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    const jid = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    say(`   ${String(p.id).padEnd(28)} ${jid ? await waitForJob(jid) : `HTTP ${r.status}`}`);
  }

  // ASR/VAD 权重：没有它们 transcribe job 会 blocked，⑥ 就测不到真东西。
  {
    const mc = await j('/api/models/catalog');
    const ms = (mc.body?.groups ?? []).flatMap((g) =>
      (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role })),
    );
    const size = (m) => (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
    const want = [];
    const vad = ms
      .filter((m) => m.role === 'vad' && size(m) > 0)
      .sort((a, b) => size(a) - size(b))[0];
    const asr = ms
      .filter(
        (m) =>
          m.role === 'asr' &&
          ((m.engines ?? []).includes('whisper.cpp') || /^asr\/whisper-/.test(String(m.id))) &&
          size(m) > 0,
      )
      .sort((a, b) => size(a) - size(b))[0];
    if (vad) want.push(vad);
    if (asr) want.push(asr);
    for (const m of want) {
      const r = await j('/api/models/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: m.id }),
      });
      const jid = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
      say(`   ${String(m.id).padEnd(28)} ${jid ? await waitForJob(jid) : `HTTP ${r.status}`}`);
    }
  }

  // 造一个 2 秒的 mp4 当 fixture（用产品自己的 ffmpeg，不依赖 submodule）。
  const STORE_ROOT = join(DATA_DIR, 'models');
  const findUnder = (root, name) => {
    const want = IS_WIN ? `${name}.exe` : name;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let es;
      try {
        es = readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of es) {
        const f = join(d, e.name);
        if (e.isDirectory()) stack.push(f);
        else if (e.name === want) {
          try {
            accessSync(f, fsC.X_OK);
            return f;
          } catch {
            /* 不可执行 */
          }
        }
      }
    }
    return null;
  };
  const FFMPEG = findUnder(STORE_ROOT, 'ffmpeg');
  say(`   ffmpeg: ${FFMPEG ?? '(没找到)'}`);
  if (!FFMPEG) throw new Error('storeRoot 里没有 ffmpeg —— 造不出 fixture');
  const out = join(ROOT, 'clip.mp4');

  /*
   * ── 🔴 这一段此前把自己的失败吞掉了（2026-08-23 修）────────────────────────────
   *
   * `[实测 run 31424996163]` 首跑死在这里，而现场看到的是：
   *
   *     ✘ 中断：ENOENT: no such file or directory, open '/tmp/…/clip.mp4'
   *
   * 一个**离成因很远**的 ENOENT。三处叠加造成的：
   *   ① `stdio: 'ignore'` —— ffmpeg 把原因写在 stderr 上，而那句话被丢了；
   *   ② `p.on('close', r)` —— resolve 不带退出码，**任何退出码都当成功**；
   *   ③ 紧接着盲读 `readFileSync(out)` —— 于是失败以"文件不存在"现形。
   *
   * ⚠️ 这**不是**在"改断言让它绿"（本 workflow 文件头写死的禁令）。方向正好相反：
   *    它把一个**静默的**失败改成**大声的**失败。修完这一段，这一步该红照样红，
   *    只是红的那句话会指着真正的成因，而不是指着一个空文件名。
   *
   * ── ★ 那条写了 13 天的推断：**实测之后一半是错的**（run 32655294063）───────────
   *
   * 此前记的成因是「产品自带的 media-tools ffmpeg 是**面向解码**的构建，
   * `libx264` / `aac` 编码器不在里面」。加上编码器探测之后，实测结果是：
   *
   *     无 libx264 **有 libopenh264** **有 mpeg4** **有 aac** 有 libmp3lame 有 pcm_s16le
   *     ffmpeg stderr: `Unknown encoder 'libx264'` / `Encoder not found`
   *
   * 也就是说：**编码器好好地在**，缺的只有 `libx264` 一个 —— 而它缺的原因是
   * **许可证**，不是"面向解码"：那个包的路径里就写着 `…-linux64-**lgpl**-8.1`，
   * 而 libx264 是 GPL，LGPL 构建里本来就不会有它（同仓 `ffmpeg-lgpl-verify.yml`
   * 量的就是这件事）。
   *
   * ⚠️ 这条订正值得单独记一笔，因为**旧推断会把下一个人带向错误的修法**：
   *    照着"编码器不在"去做，结论是"换一条不依赖编码器的 fixture 路径"
   *    （往仓库里塞一个二进制夹具之类）。而真实的修法是**换一个编码器名字**。
   *    `stdio:'ignore'` 吞掉的那一行 stderr，值 13 天。
   */

  /*
   * 按偏好挑一个**这台机器上真的有**的视频编码器，而不是写死一个。
   * 顺序理由：libopenh264 与 libx264 同为 H.264（产物形态最接近原来的意图）；
   * mpeg4 是最后的兜底，任何 ffmpeg 都有。
   * ⚠️ 挑中的那个会打印出来 —— fixture 用什么编的，不许靠猜。
   */
  const encoderList = await new Promise((resolve) => {
    let o = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    p.stdout.on('data', (b) => (o += b.toString()));
    p.on('close', () => resolve(o));
    p.on('error', () => resolve(''));
  });
  const hasEncoder = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(encoderList);
  const VCODEC = ['libx264', 'libopenh264', 'mpeg4'].find(hasEncoder);
  const ACODEC = ['aac', 'libmp3lame', 'pcm_s16le'].find(hasEncoder);
  if (!VCODEC || !ACODEC) {
    throw new Error(
      `这个 ffmpeg 一个可用的${!VCODEC ? '视频' : '音频'}编码器都没有（${FFMPEG}）。\n` +
        `  探到的：libx264=${hasEncoder('libx264')} libopenh264=${hasEncoder('libopenh264')} ` +
        `mpeg4=${hasEncoder('mpeg4')} aac=${hasEncoder('aac')} pcm_s16le=${hasEncoder('pcm_s16le')}`,
    );
  }
  say(`   fixture 编码器：${VCODEC} / ${ACODEC}（按这台机器实际有的挑，不是写死的）`);

  const ffmpegArgs = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x120:rate=10:duration=2',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '2',
    '-c:v',
    VCODEC,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    ACODEC,
    '-shortest',
    out,
  ];
  const enc = await new Promise((resolve) => {
    let err = '';
    const p = spawn(FFMPEG, ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (b) => {
      err += b.toString();
    });
    p.on('close', (code) => resolve({ code, err }));
    p.on('error', (e) => resolve({ code: null, err: `spawn 失败：${e.message}` }));
  });
  if (enc.code !== 0) {
    const probed = ['libx264', 'libopenh264', 'mpeg4', 'aac', 'libmp3lame', 'pcm_s16le']
      .map((n) => `${hasEncoder(n) ? '有' : '无'} ${n}`)
      .join('  ');
    throw new Error(
      `造 fixture 的 ffmpeg 退出码 ${enc.code}（${FFMPEG}，用的是 ${VCODEC}/${ACODEC}）。\n` +
        `  ffmpeg stderr（末 800 字）：\n${enc.err.slice(-800)}\n` +
        `  ★ 该 ffmpeg 的编码器实况：${probed}\n` +
        `  ★ 挑编码器这一步已经按实况挑过了，所以这里的红**不再是"缺 libx264"那一类**。\n` +
        `    先读上面那段 stderr，别照抄文件头里任何一条旧推断。`,
    );
  }
  const { readFileSync } = await import('node:fs');
  MP4 = readFileSync(out);
  if (MP4.length === 0) {
    /* ffmpeg 退 0 却写出空文件也发生过（磁盘满 / 管道断）。空 fixture 会让后面
       每一条"代理看见了请求"都变成看见一个 0 字节的请求 —— 那是假绿，不是通过。 */
    throw new Error(`fixture clip.mp4 是 0 字节 —— ffmpeg 退了 0 但什么都没写出来`);
  }
  say(`   fixture clip.mp4：${MP4.length} B`);

  hdr('3. 通过产品自己的设置接口打开代理');
  const patch = await j('/api/settings/proxy', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'manual',
      httpProxy: `http://127.0.0.1:${PROXY_PORT}`,
      httpsProxy: `http://127.0.0.1:${PROXY_PORT}`,
      noProxy: [],
    }),
  });
  say(
    `   PATCH /api/settings/proxy → HTTP ${patch.status} ${JSON.stringify(patch.body).slice(0, 400)}`,
  );
  const claimsImmediate = patch.body?.appliedImmediately === true;
  say(`   ★ 接口声称 appliedImmediately = ${patch.body?.appliedImmediately}`);

  hdr('4. 逐条出网路径实测');

  // ── ① 模型/组件下载（in-process fetch → 全局 dispatcher）──────────────────
  hits.length = 0;
  const mcat = await j('/api/models/catalog');
  const models = (mcat.body?.groups ?? []).flatMap((g) =>
    (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role })),
  );
  const small = models
    .filter((m) => m.role === 'vad')
    .map((m) => ({ m, b: (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0) }))
    .filter((x) => x.b > 0)
    .sort((a, b) => a.b - b.b)[0];
  if (!small) {
    record('模型下载', null, '目录里挑不出小模型');
  } else {
    const r = await j('/api/models/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: small.m.id }),
    });
    const jid = r.body?.jobId ?? r.body?.uid ?? r.body?.id;
    const st = jid ? await waitForJob(jid) : `HTTP ${r.status}`;
    const ev = hits.filter((h) => h.host !== PROBE_HOST);
    record(
      '① 模型下载',
      ev.length > 0,
      `${st}；代理看到 ${ev.length} 条（如 ${ev[0]?.url ?? '-'}）`,
    );
  }

  // ── ② LLM API（in-process fetch）───────────────────────────────────────────
  hits.length = 0;
  /*
   * ★ 得挑一家**真的有模型列表接口**的：`canRefreshModelList()` 只对
   *   `official-api` / `local-api` 为真（openrouter / siliconcloud / ollama / lmstudio）。
   *   其余 20 家是 `official-doc`（人工转录），路由会在**发请求之前** 400
   *   —— 拿那种 400 当"绕过代理"就是凭空捏造缺陷。ollama/lmstudio 是本机地址，
   *   本来就不该走代理，所以只用前两家。
   */
  let lm = { status: 0, body: {} };
  let lmProvider = null;
  for (const pid of ['openrouter', 'siliconcloud']) {
    lm = await j('/api/llm/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: pid }),
    });
    lmProvider = pid;
    if (lm.status === 200 || hits.some((h) => h.host !== PROBE_HOST)) break;
  }
  {
    const ev = hits.filter((h) => h.host !== PROBE_HOST);
    /*
     * ★ 400 有两种完全不同的含义，**不能都算成"绕过代理"**：
     *   · 请求真的发出去了、对端拒了  → 这条路径**测到了**
     *   · 路由层在发请求**之前**就拒了 → 这条路径**根本没跑**，只能标 UNKNOWN
     * 报一条没跑过的路径为"缺陷"，与产品谎称已生效是同一种病。
     */
    const code = lm.body?.error?.code ?? '';
    const neverAttempted =
      ev.length === 0 &&
      /BAD_REQUEST|PROVIDER_UNKNOWN|PROVIDER_NOT_ENUMERABLE|MISSING_API_KEY/i.test(String(code));
    record(
      '② LLM API 调用',
      neverAttempted ? null : ev.length > 0,
      neverAttempted
        ? `provider=${lmProvider} HTTP ${lm.status} code=${code} —— 请求在发出**之前**就被拒了，本轮没跑到`
        : `provider=${lmProvider} HTTP ${lm.status}；代理看到 ${ev.length} 条（如 ${ev[0]?.url ?? '-'}）`,
    );
  }
  // ── ③ direct-http 适配器（in-process fetch：HEAD + resumableFetch）─────────
  hits.length = 0;
  const p1 = await j('/api/notes/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: `http://${PROBE_HOST}/clip.mp4` }),
  });
  {
    // direct-http 的 HEAD 带的是我们自己的 UA：`OpenMemo/0.1 (+local)`。
    const ev = sawUA(PROBE_HOST, (ua) => /OpenMemo/i.test(ua));
    record(
      '③ direct-http probe',
      ev.length > 0,
      `HTTP ${p1.status} adapterId=${p1.body?.adapterId ?? '-'}；` +
        `代理看到 OpenMemo-UA 请求 ${ev.length} 条（该主机总命中 ${sawHost(PROBE_HOST).length}）`,
    );
  }

  // ── ④ ffprobe 远端读（子进程！`probeMedia(remote:true)`）───────────────────
  /*
   * ★★ `[实测]` 这一格**在明文 http 上结构性地测不了**，而我第一版把它报成了"绕过代理"。
   *
   *   `packages/pipeline/src/audio/ffmpeg.ts:45`：
   *       const REMOTE_PROTOCOLS = 'https,tls,tcp,crypto,httpproxy';
   *   —— **没有 `http`**。所以对一个 `http://` 的远端 URL，ffprobe 在
   *   `-protocol_whitelist` 这一关就拒了，**一个包都不会发**。
   *   "代理没看到 ffprobe" 的真实含义是"ffprobe 根本没跑"，不是"它绕过去了"。
   *
   *   把没跑过的路径报成缺陷，与产品谎称"已生效"是同一种病 —— 都是让一句话
   *   听起来比证据更确定。所以这里如实标 UNKNOWN，并说清为什么取不到。
   *
   *   这条路径的代理注入改由**单元测试**守（`ffmpegProxyEnv.test.ts`）：
   *   断言 `remote:true` + proxy 时，ffprobe/ffmpeg 的子进程环境里真的有 http_proxy。
   *   那是确定性的，不需要一个 https 源站。
   */
  {
    const ff = sawUA(PROBE_HOST, (ua) => /Lavf|ffmpeg|ffprobe/i.test(ua));
    record(
      '④ ffprobe 远端读（子进程）',
      ff.length > 0 ? true : null,
      ff.length > 0
        ? `UA=${ff[0].ua.slice(0, 40)}`
        : 'UNKNOWN：探针是 http://，而 REMOTE_PROTOCOLS 只允许 https —— ffprobe 不会发包，本轮测不到。',
      ff.length > 0 ? null : 'packages/pipeline/src/audio/__tests__/ffmpegProxyEnv.test.ts',
    );
  }

  // ── ⑤ yt-dlp probe（子进程）────────────────────────────────────────────────
  hits.length = 0;
  const p2 = await j('/api/notes/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: `http://${PROBE_HOST}/watch` }),
  });
  {
    // direct-http 会先试 /watch（HTML，不像媒体）→ 拒绝 → 落到 yt-dlp。
    // yt-dlp 默认伪装 Chrome UA，所以按"不是我们自己那个 UA"来认。
    const ev = sawUA(PROBE_HOST, isYtDlpUA);
    record(
      '⑤ yt-dlp probe（子进程）',
      ev.length > 0,
      `HTTP ${p2.status} adapterId=${p2.body?.adapterId ?? '-'}；` +
        `代理看到非 OpenMemo-UA 请求 ${ev.length} 条`,
    );
  }

  // ── ⑥ yt-dlp fetch（子进程）────────────────────────────────────────────────
  // 判据是**代理有没有收到下载请求**，不是 job 最终成不成（本轮没装 ASR，
  // 转写那一步必然 blocked/failed —— 那不影响这一条测的东西）。
  hits.length = 0;
  const imp = await j('/api/notes/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: `http://${PROBE_HOST}/watch`, title: 'proxy probe' }),
  });
  if (imp.status !== 202) {
    record('⑥ yt-dlp fetch（子进程）', null, `导入没排上队：HTTP ${imp.status}`);
  } else {
    const st = await waitForJob(imp.body.jobUid, 180);
    const ev = sawUA(PROBE_HOST, isYtDlpUA);
    record(
      '⑥ yt-dlp fetch（子进程）',
      ev.length > 0,
      `job=${st.slice(0, 60)}；代理看到非 OpenMemo-UA 请求 ${ev.length} 条`,
    );
  }

  // ── ⑦ `appliedImmediately` 到底诚不诚实（不重启就能改，两个方向都要成立）──────
  /*
   * `PATCH /api/settings/proxy` 回的是 `appliedImmediately: true`。这句话对**进程内**
   * 那几条一直是真的（`setGlobalDispatcher` 当场换掉）；对**子进程**此前是假的
   * —— 它们压根拿不到代理，谈不上"立即生效"。
   *
   * 现在子进程侧读的是 `activeProxyConfig()`，**每次 spawn 现取**，所以：
   *   · 上面 ⑤⑥ 已经证明了「开」这个方向：registry 是 daemon **启动时**建的，
   *     而代理是启动**之后**才 PATCH 进去的 —— 它照样生效了，没有重启。
   *   · 这里再证「关」这个方向：把 mode 改成 off，下一次 yt-dlp 必须**不再**经过代理。
   *     只验一个方向的话，"配置被读到了"和"值被写死成了代理"分不开。
   */
  hits.length = 0;
  const off = await j('/api/settings/proxy', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'off' }),
  });
  const p3 = await j('/api/notes/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: `http://${PROBE_HOST}/watch` }),
  });
  {
    const ev = sawHost(PROBE_HOST);
    /*
     * ★ 这一格的 PASS 是一个**裸的否定**（"代理一条都没看到"），而"根本没发生"
     *   长得和"发生了但没走代理"一模一样。所以必须先证明**这一发真的跑了**。
     *
     *   本脚本对 ② 和 ④ 早就坚持这条区分（"请求在发出**之前**就被拒了 ⇒ 标 UNKNOWN，
     *   不当成结论"），只有 ⑦ 漏了 —— 这里照它自己的做法补上，不另起一套。
     *
     *   `/api/notes/probe` 的错误码（`apps/daemon/src/http/rest/notes.ts:191-256`）：
     *     · `BAD_REQUEST`(400)      —— 路由层预检就拒了，**一个包都没发**
     *     · `NO_MEDIA_SOURCE`(422)  —— 每个适配器都真的试过了，都够不着
     *     · `PROBE_FAILED`(502) / `PROBE_TIMEOUT`(504) —— 试过了，失败/超时
     *   后三种才算"跑到了"。
     *
     *   还有一种环境性的假绿要挡住：探针主机**居然解析得开**（通配符 DNS 的自建
     *   runner）。那时 probe 可能直连成功，代理照样看到 0 条 ⇒ 这一格会绿得毫无意义，
     *   而整轮的判据前提（"通了就只可能是走了代理"）已经不成立了。
     */
    const code7 = String(p3.body?.error?.code ?? '');
    const attempted = /^(NO_MEDIA_SOURCE|PROBE_FAILED|PROBE_TIMEOUT)$/.test(code7);
    const base = `PATCH mode=off → HTTP ${off.status}；随后 probe HTTP ${p3.status} code=${code7 || '(无)'}；代理看到 ${ev.length} 条`;
    if (p3.status === 200) {
      record(
        '⑦ 改回 off 后立即生效',
        null,
        `${base} —— ⚠️ 代理关掉之后 probe **居然成功了**：` +
          `说明 ${PROBE_HOST} 在这台机器上解析得开。整轮判据的前提` +
          `（"能通就只可能是走了代理"）不成立，这一格的 0 条**不能**读成"已关掉"。`,
      );
    } else if (!attempted) {
      record(
        '⑦ 改回 off 后立即生效',
        null,
        `${base} —— 这一发在**发出之前**就被拒了（code=${code7 || '(无)'}），` +
          `没跑到。0 条不是"关掉了"的证据，只是"什么都没发生"。` +
          `（对照：⑤ 同一个请求在代理开着时是 HTTP ${p2.status}。）`,
      );
    } else {
      record(
        '⑦ 改回 off 后立即生效',
        ev.length === 0,
        `${base}（期望 0 —— 不重启就该立刻不走代理了）；` +
          `这一发确实跑到了：code=${code7} 属"试过但够不着"，正是关掉代理后该有的样子。` +
          `（对照：⑤ 同一个请求在代理开着时是 HTTP ${p2.status}。）`,
        null,
        '✅ 立即生效',
        '❌ **改了不生效（appliedImmediately 是谎话）**',
      );
    }
  }

  /* ═════════ 5. 结论 ═════════ */

  hdr('5. 结论');
  const bypass = results.filter((r) => r.proxied === false);
  /*
   * ★ UNKNOWN 分两种，**只有第二种该让门禁红**：
   *   · 有明确的替代守卫（`coveredBy`）→ 打印出来，但不算洞。
   *   · 没有                          → 算洞。
   * 本仓刚吃过的亏：**一条永远红的守卫等于一条被删掉的守卫** —— 它训练所有人忽略它。
   * ④ 在明文 http 上结构性地测不到，如果让它一直红，这个脚本活不过两周。
   */
  const coveredElsewhere = results.filter((r) => r.proxied === null && r.coveredBy);
  const untested = results.filter((r) => r.proxied === null && !r.coveredBy);
  say('   路径                                走不走代理');
  say('   ' + '-'.repeat(78));
  for (const r of results) {
    const v =
      r.proxied === null
        ? r.coveredBy
          ? 'UNKNOWN（另有守卫）'
          : 'UNKNOWN'
        : r.proxied
          ? r.okLabel
          : r.badLabel;
    say(`   ${String(r.path).padEnd(34)} ${v}`);
  }
  say('');
  for (const r of coveredElsewhere) {
    say(`   ◐ ${r.path}：本轮测不到，改由 ${r.coveredBy} 守。`);
    say(`      理由：${r.evidence}`);
  }
  if (untested.length > 0) {
    say(`   ⓵ ${untested.length} 条没测成（标 UNKNOWN，不当成通过）：`);
    for (const r of untested) say(`      · ${r.path} —— ${r.evidence}`);
  }
  /*
   * ★ 先判**声称那一半**。本脚本量的是「设置页说已生效的东西，是否真的对每一条
   *   出网路径生效」—— 那是一个**两半**的句子，而 `claimsImmediate` 此前只在
   *   失败分支里被打印，**从不参与退出码**。也就是说声称那一半从来没被读过：
   *   接口哪天改回 `appliedImmediately:false`，脚本照样打印
   *   「与设置页的声称一致」并 exit 0 —— 那时这句话就不准了。
   *   摆设就是摆设，要么判要么删。这里判。
   */
  if (claimsImmediate !== true) {
    say(
      `   ✘ 前提变了：PATCH /api/settings/proxy 回的是 appliedImmediately=${patch.body?.appliedImmediately}（不是 true）。`,
    );
    say('     本脚本量的是"设置页说已生效的东西是否真的生效"。**声称那一半变了，判据要重读**，');
    say('     不能默认沿用 —— 所以这里红，红的意思是"来个人确认这个脚本还在量对的东西"。');
    exitCode = 1;
  }
  if (bypass.length > 0) {
    say(`   ✘ ${bypass.length} 条**绕过代理**：${bypass.map((r) => r.path).join('、')}`);
    say('');
    say(`   而 PATCH /api/settings/proxy 回的是 appliedImmediately=${claimsImmediate}。`);
    say('   → 设置页声称的覆盖面与实际不符。**一句自信的错话比不说更糟。**');
    exitCode = 1;
  } else if (untested.length > 0) {
    say('   ⓵ 没有发现绕过，但有 UNKNOWN —— 不报绿。');
    exitCode = 1;
  } else if (exitCode === 0) {
    say('   ✔ 每一条出网路径都走代理，与设置页的声称一致。');
  }
} catch (e) {
  say('');
  say(`✘ 中断：${e.message}`);
  say(e.stack ?? '');
  if (daemonLogs.length) {
    say('   daemon 最后 40 行：');
    say(
      daemonLogs
        .join('')
        .split('\n')
        .slice(-40)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  exitCode = 1;
} finally {
  await stopDaemon();
  await new Promise((r) => proxy.close(r));
  say('');
  say(`   指针文件用的是 ${POINTER}（不是全局的那个）—— PROTOCOL §9。`);
  say(`   临时根目录 ${ROOT}。`);
}

process.exit(exitCode);
