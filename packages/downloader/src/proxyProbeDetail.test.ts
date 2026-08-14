/**
 * `ProxyProbeDetail` 的守卫 —— **代理面板上那一行细节里不许出现中文**（#112 第 16 处）。
 *
 * ## 缺陷原状（英文界面，逐字）
 *
 * ```
 * ✗ proxy unreachable   YouTube  12ms  via proxy  · 连不上代理 http://127.0.0.1:7890/ —— 未向 YouTube 发出请求
 * ```
 *
 * 这一格上一版是**三句写死的中文散文**（外加一条原样抛回来的 `err.message`），
 * 而 `ProxySettingsSection.tsx` 把它渲染在一整屏英文词条中间。
 * 它符合「CJK 只出现在数据里」的表面判据 —— `en.json` 里一个汉字都没有 ——
 * **但对英文用户就是半句中文**。措辞现在归 `apps/web` 的两份 locale，
 * 这一侧只说**是哪一格**。
 *
 * ## ★ 为什么样本是**跑出来的**，不是在这里手写几个字面量
 *
 * 手写 `const cases: ProxyProbeDetail[] = [{kind:'proxy_refused_tunnel', proxyUrl:'…'}]`
 * 再断言它们不含中文，测的是**我在这份用例里打的字**，不是 `proxy.ts` 真的发什么
 *（本轮反复点名的第 ③ 类：量错了对象）。所以这里把 `testProxyConnectivity()` 真的跑起来，
 * 用**回环上的假代理**逼出那四格里的三格，第四格用一个关掉的端口逼出真实的 fetch 报错。
 * 全程不出网：三个短路分支在 CONNECT 握手之后就 `continue` 了，一个请求都不会发出去。
 *
 * 照 `rateLimitReason.test.ts` 第 ④ 组的形状，**包括它那条前提检查**：
 * 正则抓不到汉字的话，整组断言都是空转。
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { ProxyConfig, ProxyProbeDetail } from '@openmemo/shared';

import { testProxyConnectivity } from './proxy.js';

/**
 * CJK 表意文字 + CJK 标点（、。——）+ 全角形式（（），）。
 *
 * ⚠️ **写 `\u` 转义，不写字面量**：范围首字符是 U+3000 全角空格，
 * 直接写进正则会被 eslint 的 `no-irregular-whitespace` 判红，
 * 而且在 diff 里根本看不出来。（`rateLimitReason.test.ts` 与
 * `components.test.tsx` 里也各记着一条。）
 */
const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

/**
 * 契约里那四格，一格一行。
 *
 * ⚠️ 这是**总表**：契约里加一格 ⇒ 这个对象少一个键 ⇒ `tsc` 当场红。
 * 下面那条前提自检再要求"跑出来的样本恰好盖满这四格"，
 * 于是「悄悄加一格而没人给它写用例」在结构上做不到。
 */
const KIND_COVERAGE: Readonly<Record<ProxyProbeDetail['kind'], true>> = {
  proxy_unreachable_not_sent: true,
  proxy_rejected_credentials: true,
  proxy_refused_tunnel: true,
  probe_error_text: true,
};

/** 目标站的标签**刻意全 ASCII**：否则"没有中文"判不出是产品的字还是夹具的字。 */
const TARGETS = [{ target: 'YouTube', url: 'https://www.youtube.com/generate_204' }];

const manual = (proxyUrl: string): ProxyConfig => ({
  mode: 'manual',
  httpProxy: proxyUrl,
  httpsProxy: proxyUrl,
  socks5: null,
  noProxy: [],
});

interface FakeProxy {
  port: number;
  close: () => Promise<void>;
}

/**
 * 回环上的假代理：对 CONNECT 回一条**固定的状态行**。
 *
 * `probeProxy()` 读的就是这条状态行（407 ⇒ 凭据被拒；其它非 2xx ⇒ 拒绝建隧道），
 * 所以两格分支各起一个就能逼出来，且**不需要任何外网**。
 */
async function fakeProxy(statusLine: string): Promise<FakeProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => undefined);
    sock.on('close', () => sockets.delete(sock));
    sock.on('data', () => sock.write(`HTTP/1.1 ${statusLine}\r\n\r\n`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 一个**确定关着**的回环端口：开一个再立刻关掉，比随手挑一个数字可靠。 */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function detailOf(
  cfg: ProxyConfig,
  targets: ReadonlyArray<{ target: string; url: string }> = TARGETS,
): Promise<ProxyProbeDetail> {
  const report = await testProxyConnectivity(cfg, { targets, timeoutMs: 3000 });
  const probe = report.probes[0];
  const detail = probe?.detail;
  if (!detail) {
    // 空转防线：拿不到样本时**当场红**，而不是让下面的循环跑零次然后报绿。
    assert.fail(`这条探针没有 detail（result=${probe?.result ?? '(一条探针都没有)'}）`);
  }
  return detail;
}

describe('#112 ⑯ ProxyProbeDetail —— 这一格里不许出现中文', () => {
  /** kind → 那一格真的被 `proxy.ts` 发出来的样本。 */
  const produced = new Map<string, ProxyProbeDetail>();
  const servers: FakeProxy[] = [];

  before(async () => {
    const dead = await closedPort();

    // ① 连不上代理本身 —— 一个请求都没往目标站发。凭据故意写进 URL，见下面的脱敏用例。
    produced.set(
      'proxy_unreachable_not_sent',
      await detailOf(manual(`http://probeuser:s3cr3tpw@127.0.0.1:${dead}`)),
    );

    // ② 代理答了 407：拒绝凭据。
    const auth = await fakeProxy('407 Proxy Authentication Required');
    servers.push(auth);
    produced.set(
      'proxy_rejected_credentials',
      await detailOf(manual(`http://probeuser:s3cr3tpw@127.0.0.1:${auth.port}`)),
    );

    // ③ 代理答了 403：拒绝建立到目标的隧道（企业代理按策略拒绝的形状）。
    const refuse = await fakeProxy('403 Forbidden');
    servers.push(refuse);
    produced.set('proxy_refused_tunnel', await detailOf(manual(`http://127.0.0.1:${refuse.port}`)));

    // ④ 直连一个关着的端口 ⇒ fetch 原样抛回来的串（这一格刻意不枚举）。
    produced.set(
      'probe_error_text',
      await detailOf(
        { mode: 'off', httpProxy: null, httpsProxy: null, socks5: null, noProxy: [] },
        [{ target: 'DeadLoopback', url: `http://127.0.0.1:${dead}/` }],
      ),
    );
  });

  after(async () => {
    for (const s of servers) await s.close();
  });

  it('前提检查：这条正则真的抓得到汉字与全角标点（否则本组全是空转）', () => {
    assert.equal(CJK.test('连不上代理 —— 未向 YouTube 发出请求'), true);
    assert.equal(CJK.test('代理拒绝了凭据（407）'), true);
    assert.equal(CJK.test('could not reach the proxy - no request was sent'), false);
  });

  it('★ 前提自检：跑出来的样本恰好盖满契约那四格', () => {
    const kinds = [...produced.values()].map((d) => d.kind).sort();
    assert.equal(kinds.length, 4, `样本只有 ${kinds.length} 格 —— 下面那组会漏掉其余分支`);
    assert.deepEqual(
      kinds,
      Object.keys(KIND_COVERAGE).sort(),
      '契约里增/改了一格细节，而这里没有样本跑到它 —— 那一格里可以再混进中文而无人发现',
    );
  });

  it('★★ 四格全部：`proxy.ts` 发出来的那一格，序列化之后不含 CJK', () => {
    const all = [...produced.values()];
    assert.equal(all.length, 4, '样本集缩水了 —— 这条会变成空转');
    for (const d of all) {
      const json = JSON.stringify(d);
      assert.equal(CJK.test(json), false, `细节里混进了中文（${d.kind}）：${json}`);
    }
  });

  it('★ 每一格都落在它该落的那一格上 —— 不是"随便发点什么但没中文"', () => {
    /*
     * 只判"没有中文"是不够的：把三个分支全改成 `{kind:'probe_error_text', text:''}`
     * 也能让上面那条全绿，而那是把三种指向完全不同修法的成因塌成一种。
     */
    const unreachable = produced.get('proxy_unreachable_not_sent');
    assert.equal(unreachable?.kind, 'proxy_unreachable_not_sent');
    assert.equal(
      unreachable?.kind === 'proxy_unreachable_not_sent' ? unreachable.target : null,
      'YouTube',
      '没说清"没往哪个目标站发请求" —— 用户会以为目标站也测过了',
    );

    const rejected = produced.get('proxy_rejected_credentials');
    assert.equal(rejected?.kind, 'proxy_rejected_credentials');

    const refused = produced.get('proxy_refused_tunnel');
    assert.equal(
      refused?.kind,
      'proxy_refused_tunnel',
      'CONNECT 收到非 2xx 非 407 时，必须如实说"判断不下去"，不许塌进别的成因',
    );

    const raw = produced.get('probe_error_text');
    assert.equal(raw?.kind, 'probe_error_text');
    assert.ok(
      raw?.kind === 'probe_error_text' && raw.text.length > 0,
      '原始错误串被吃掉了 —— 那是这一格唯一的内容',
    );
  });

  it('★ 凭据必须在产出的那一刻就脱掉 —— 这一格会进 HTTP 响应体', () => {
    /*
     * 反向鉴别：`detail` 是发给浏览器的。上一版用 `redactProxyUrl()` 是对的，
     * 换成结构化之后**很容易顺手把原始 URL 塞进 `proxyUrl` 字段** ——
     * 那就是把用户的代理密码写进一个 GET 得到的 JSON 里。
     */
    for (const kind of ['proxy_unreachable_not_sent', 'proxy_rejected_credentials']) {
      const d = produced.get(kind);
      const json = JSON.stringify(d);
      assert.ok(json.includes('***'), `「${kind}」没有脱敏痕迹：${json}`);
      assert.equal(json.includes('s3cr3tpw'), false, `★ 代理密码原样进了响应体：${json}`);
      assert.equal(json.includes('probeuser'), false, `★ 代理用户名原样进了响应体：${json}`);
    }
  });
});
