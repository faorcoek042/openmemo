/**
 * `http/guard.ts` —— DNS rebinding / CSRF 闸门。
 *
 * ## 为什么这个文件此前不存在，以及为什么这件事很糟
 *
 * T-137 的变异实测（§E 的 E2）：把 `checkHost` 里的域名规则整段删掉
 * （`if (!ALLOWED_HOSTS.has(h) && !isIpLiteral(h))` → `if (false)`）→ **196/196 全绿**；
 * 删掉 `checkOrigin` 的同源比较 → **全绿**；把 `checkSecFetch` 改成恒过 → **全绿**。
 * `grep` 确认：**全仓没有任何测试文件 import 过 `guard.ts`**。
 *
 * 而 daemon 测试里确实有两条以「DNS rebinding 防护」「跨源 Origin 被拒」命名的用例，
 * 它们也确实是绿的 —— **通过的理由和名字无关**：
 *
 * ```
 * PRISTINE:   rejected   Host: evil.example.com:17650      ← 真代码是对的
 * D01 MUTANT: rejected   Host: evil.example.com            ← 403 来自"端口不匹配"
 * D01 MUTANT: ACCEPTED   Host: evil.example.com:17650      ← 域名子句已删，照样进
 * ```
 *
 * 夹具用的是**不带端口**的 `Host: evil.example.com`，于是开火的是**端口子句**，
 * 域名子句从来不是那个把它拦下来的人。
 * 而真实的 DNS rebinding 一定带端口（浏览器会带上它连的那个）——
 * **唯一没被覆盖的形状，正好就是唯一会被攻击的形状。**
 *
 * ⚠️ 说清楚：**产品代码是对的**，真攻击形状被正确拒绝。坏的是护栏。
 * `guard.ts:7` 自称「`Host` 头校验是唯一可靠的拦截点」，
 * 而这个拦截点可以被整个删掉、没有一格会变红。
 *
 * ## 本文件的判据：**每一条子句都要有一个"只有它能开火"的输入**
 *
 * 光断言"恶意请求被拒"是不够的 —— 上面那三行就是反例。
 * 所以每条子句都成对写：
 *   - 一个**只违反这一条**的输入（其余字段全部合法）→ 必须拒；
 *   - 一个**只把这一个字段改回合法**的对照输入 → 必须过。
 * 两条合起来才能证明"拒绝来自这一条子句"，而不是来自旁边那条。
 *
 * 用户此前明确要求**放宽** Host 校验（接受任意 IP 字面量，不再只认回环）——
 * 所以这里同时钉住"放宽的部分必须真的放宽"，
 * 免得下一个人为了让测试变绿把它又收回去。**"放宽"不等于"删掉了也没人知道"。**
 */
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';

import { checkHost, checkOrigin, checkSecFetch, guardRequest } from './guard.js';

/** daemon 实际监听的端口集合（形状与 server.ts 传进来的一致）。 */
const PORTS = [17650] as const;

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('checkHost —— 域名一律拒（DNS rebinding 的唯一拦截点）', () => {
  it('★ 域名 + **正确端口** 必须被拒 —— 这才是真实 rebinding 的形状', () => {
    /*
     * 端口给对，是为了让**端口子句无法开火**：
     * 这样"被拒"就只可能来自域名子句。
     * 旧夹具漏的正是这一格 —— 它不带端口，于是拒绝来自端口子句。
     */
    const r = checkHost(req({ host: `evil.example.com:${PORTS[0]}` }), PORTS);
    assert.equal(r.ok, false, 'DNS rebinding 防护已经形同虚设');
  });

  it('★ 对照：同一个端口换成 IP 字面量必须**通过** —— 证明上一条的拒绝来自域名而非端口', () => {
    const r = checkHost(req({ host: `127.0.0.1:${PORTS[0]}` }), PORTS);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  it('★ `localhost` 也是域名，同样必须拒（它一样经过 DNS，一样能被重绑）', () => {
    const r = checkHost(req({ host: `localhost:${PORTS[0]}` }), PORTS);
    assert.equal(r.ok, false, 'localhost 被放行 —— 它是域名，rebinding 照打不误');
  });

  it('★ 长得像 IP 的域名必须拒（`1.2.3.4.evil.com` / 段位越界的 `999.1.1.1`）', () => {
    for (const h of [`1.2.3.4.evil.com:${PORTS[0]}`, `999.1.1.1:${PORTS[0]}`]) {
      assert.equal(checkHost(req({ host: h }), PORTS).ok, false, `${h} 被当成 IP 放行了`);
    }
  });

  it('放宽的那一半也要钉住：任意公网 IP 字面量必须放行（NAT / 反代场景）', () => {
    /*
     * 这条不是"顺手加的"：用户明确要求把 Host 校验放宽到接受任意 IP 字面量
     * （`guard.ts:21-29` 写清了理由 —— rebinding 必须有 DNS 参与，裸 IP 不经过 DNS）。
     * 没有人钉住它的话，下一个人"为了安全"把它收回只认回环，
     * demo 从 NAT 外就整个访问不了，而且不会有任何测试变色。
     */
    for (const h of [`100.64.135.105:${PORTS[0]}`, `[::1]:${PORTS[0]}`]) {
      assert.equal(checkHost(req({ host: h }), PORTS).ok, true, `${h} 被拒了`);
    }
  });

  it('未加方括号的 IPv6（`::1:17650`）**应当**被拒 —— RFC 7230 要求 Host 里的 IPv6 加方括号', () => {
    /*
     * 我第一版把这条写成"必须放行"，跑出来红了。**追下去是我的测试错了，不是产品错了**：
     * `Host: ::1:17650` 无法区分"主机 ::1 端口 17650"和"主机 ::1:17650 无端口"，
     * RFC 7230 §5.4 正是为此要求方括号。拒绝它是对的。
     *
     * 顺带查实的一件事（**不改，只记**）：`ALLOWED_HOSTS` 里的 `'::1'`（不带方括号）
     * **永远匹配不到** —— 拆 host 的正则 `^(\[[^\]]+\]|[^:]+)(?::(\d+))?$`
     * 对任何裸 IPv6 都直接 no-match，先一步返回 `unparsable Host`。
     * 有效的那一条是 `'[::1]'`。这不是 bug（行为正确），是一条到不了的分支。
     */
    assert.equal(checkHost(req({ host: `::1:${PORTS[0]}` }), PORTS).ok, false);
  });

  it('缺 Host 头必须拒（不能当成"没意见"放过去）', () => {
    assert.equal(checkHost(req({}), PORTS).ok, false);
  });

  it('端口子句独立成立：IP 字面量 + 错端口必须拒', () => {
    // hostname 合法 ⇒ 只有端口子句能开火
    assert.equal(checkHost(req({ host: '127.0.0.1:1234' }), PORTS).ok, false);
  });

  it('`allowedPorts` 为空 = 不校验端口（这是它的语义，别顺手改成"全拒"）', () => {
    assert.equal(checkHost(req({ host: '127.0.0.1:1234' }), []).ok, true);
  });
});

describe('checkOrigin —— 必须与本次请求严格同源', () => {
  const HOST = `127.0.0.1:${PORTS[0]}`;

  it('★ 跨源 Origin + **正确端口** 必须拒 —— 同上，端口给对才测得到同源子句', () => {
    const r = checkOrigin(
      req({ host: HOST, origin: `http://evil.example.com:${PORTS[0]}` }),
      PORTS,
    );
    assert.equal(r.ok, false, '跨源 Origin 被放行 —— CSRF 直接开门');
  });

  it('★ Origin 是**另一个裸 IP** 也必须拒（不许照搬 Host 那条"允许 IP 字面量"）', () => {
    /*
     * `guard.ts:91-94` 点名了这个陷阱：Host 放宽的是"这个 daemon 能从哪些地址被访问"，
     * Origin 管的是"这个请求是不是从我们自己那一页发出来的"。
     * 把 Host 的宽松规则搬到 Origin 上，攻击者只要把页面挂在任意裸 IP 上就带着"合法" Origin 打进来。
     * 这条是那段注释唯一的执行者。
     */
    const r = checkOrigin(req({ host: HOST, origin: `http://100.64.135.105:${PORTS[0]}` }), PORTS);
    assert.equal(r.ok, false, 'Origin 用了 Host 的宽松规则 —— 任意裸 IP 页面都能打进来');
  });

  it('★ 对照：同源 Origin 必须通过 —— 证明上面两条拒的是"不同源"，不是"有 Origin"', () => {
    const r = checkOrigin(req({ host: HOST, origin: `http://${HOST}` }), PORTS);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  it('Origin 端口不匹配必须拒（hostname 同源 ⇒ 只有端口子句能开火）', () => {
    assert.equal(
      checkOrigin(req({ host: HOST, origin: 'http://127.0.0.1:1234' }), PORTS).ok,
      false,
    );
  });

  it('无 Origin：默认放行（curl/CLI 不发它），`required:true` 时必须拒（WS 那条路径）', () => {
    assert.equal(checkOrigin(req({ host: HOST }), PORTS).ok, true);
    assert.equal(checkOrigin(req({ host: HOST }), PORTS, { required: true }).ok, false);
  });

  it('不可解析的 Origin 必须拒（不是"解析不了就当没有"）', () => {
    assert.equal(checkOrigin(req({ host: HOST, origin: 'not a url' }), PORTS).ok, false);
  });

  it('★ 同源的 IPv6 请求必须通过（T-142 修好的那个 bug 的回归）', () => {
    /*
     * ## 这条曾经是红的，红得对 —— 它抓到的是真 bug
     *
     * `guard.ts` 原来的注释写着「URL.hostname 会剥掉 IPv6 的方括号」，
     * 于是在 hostname 含 `:` 时**再包一层**。`[实测]` Node 24：
     * `new URL('http://[::1]:17650').hostname === '[::1]'` —— **方括号还在**
     * （WHATWG 的 host 序列化器规定要带）。origin 侧成了 `[[::1]]`，永不相等。
     *
     * 后果不是"IPv6 支持不完整"，是**整页全死**：`checkHost` 放行 `[::1]`、
     * `checkOrigin` 恒拒 ⇒ 用 `http://[::1]:port` 打开界面，
     * 页面发出的每一个带 Origin 的请求都 403。
     *
     * 修法是"两边各自剥方括号"，不是"两边各自包" —— 剥法不依赖
     * `URL.hostname` 到底带不带，也就不会再被同一个假设坑第二次。
     */
    const h = `[::1]:${PORTS[0]}`;
    const r = checkOrigin(req({ host: h, origin: `http://${h}` }), PORTS);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  it('★ IPv6 修好之后，IPv4 必须**仍然**通过 —— 两个方向都验', () => {
    /*
     * `AUTH_MODE` 单向门那次的教训：只验"改的那个方向变好了"，
     * 没验"另一个方向还在" —— 于是把开关焊死在一边，且没有一格变红。
     * 归一化函数最容易出的错正是这种：为了让 IPv6 对上，
     * 顺手把 IPv4 也剥/包了一层，`127.0.0.1` 从此不同源。
     */
    const h = `127.0.0.1:${PORTS[0]}`;
    const r = checkOrigin(req({ host: h, origin: `http://${h}` }), PORTS);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  it('★ 归一化不许把不同的 IPv6 地址弄成同源（剥方括号 ≠ 放松判据）', () => {
    /*
     * "两边都剥方括号"这个修法，最坏的写法是剥完就不比了。
     * 这条钉住：剥的是**包装**，不是**判据** —— 两个不同的 IPv6 地址仍然必须被拒。
     */
    const r = checkOrigin(
      req({ host: `[::1]:${PORTS[0]}`, origin: `http://[2001:db8::1]:${PORTS[0]}` }),
      PORTS,
    );
    assert.equal(r.ok, false, 'IPv6 跨源被放行了 —— 归一化把判据一起放松掉了');
  });

  it('IPv6 与 IPv4 之间不算同源（两种地址族不能互相顶替）', () => {
    assert.equal(
      checkOrigin(req({ host: `[::1]:${PORTS[0]}`, origin: `http://127.0.0.1:${PORTS[0]}` }), PORTS)
        .ok,
      false,
    );
  });
});

describe('checkSecFetch —— 浏览器强制附加、页面伪造不了的那一层', () => {
  it('★ `cross-site` 必须拒', () => {
    assert.equal(checkSecFetch(req({ 'sec-fetch-site': 'cross-site' })).ok, false);
  });

  it('same-origin / same-site / none 放行；头缺失时放行（非浏览器客户端不发它）', () => {
    for (const v of ['same-origin', 'same-site', 'none']) {
      assert.equal(checkSecFetch(req({ 'sec-fetch-site': v })).ok, true, v);
    }
    assert.equal(checkSecFetch(req({})).ok, true);
  });
});

describe('guardRequest —— 三条子句任一不过即拒，且每一条都真的接在链上', () => {
  const OK = {
    host: `127.0.0.1:${PORTS[0]}`,
    origin: `http://127.0.0.1:${PORTS[0]}`,
    'sec-fetch-site': 'same-origin',
  };

  it('完全合法的请求必须通过（对照组 —— 没有它，下面三条可能只是"什么都拒"）', () => {
    const r = guardRequest(req(OK), PORTS);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  it('★ 只把 Host 换成域名（其余不动）→ 拒', () => {
    assert.equal(
      guardRequest(req({ ...OK, host: `evil.example.com:${PORTS[0]}` }), PORTS).ok,
      false,
    );
  });

  it('★ 只把 Origin 换成跨源（其余不动）→ 拒', () => {
    assert.equal(
      guardRequest(req({ ...OK, origin: `http://evil.example.com:${PORTS[0]}` }), PORTS).ok,
      false,
    );
  });

  it('★ 只把 Sec-Fetch-Site 换成 cross-site（其余不动）→ 拒', () => {
    assert.equal(guardRequest(req({ ...OK, 'sec-fetch-site': 'cross-site' }), PORTS).ok, false);
  });

  it('`requireOrigin:true` 时缺 Origin 必须拒（WebSocket 升级走的是这一档）', () => {
    const { origin: _drop, ...noOrigin } = OK;
    assert.equal(guardRequest(req(noOrigin), PORTS).ok, true);
    assert.equal(guardRequest(req(noOrigin), PORTS, { requireOrigin: true }).ok, false);
  });
});
