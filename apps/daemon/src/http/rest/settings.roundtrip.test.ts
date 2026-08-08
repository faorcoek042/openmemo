/**
 * **写进去 = 读回来** 的通用回归断言。
 *
 * 这个形状今天已经是第四次了：`textRaw`、`words`、`installPath`、`settings` ——
 * 全都是「写得进 / 声明了，但读不回 / 不执行」，而且**全都不会让任何测试变红**，
 * 只会让功能安静地不工作。所以这里不是只测 `settings` 这一个 bug，
 * 而是把「PATCH 什么，GET 就必须原样读到什么」这条性质本身钉成断言。
 *
 * 覆盖两种请求形状是刻意的：`GET` 回的是信封 `{settings:{…}}`，
 * 把它原样 `PATCH` 回去是最自然的用法，**必须能往返**，
 * 否则就会造出一个字面叫 `settings` 的键（正是这次的 bug）。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pinAuthMode } from '../authMode.testkit.js';
import { startDaemon } from '../../main.js';

let base = '';
let token = '';
let stop: (() => Promise<void>) | undefined;

before(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'om-settings-rt-'));
  /*
   * ★ 高位端口（19xxx）—— 这是本仓库自己立的规矩，本文件此前是**唯一一个没遵守的**。
   *
   * `daemon.test.ts` 的文件头原话：「用高位端口（19xxx）跑测试，避免与真实实例的 17650 打架」，
   * 另外四个 daemon 测试文件都照做了（19340 / 19510 / 19610 / 19860）。
   * 这里原来是 `17_600 + rand(300)`，配 `maxPort: port + 40` ⇒ 实际可达 **17600–17939**，
   * **区间里就包含 `DEFAULT_PORT = 17650`**（`bootstrap/single-instance.ts:18`）。
   *
   * 后果分两种，都不算致命但都真实：用户的 daemon 在跑 → 测试拿到
   * `StartupConflictError`，红一格（假红灯，会让人去查一个不存在的 bug）；
   * 用户的 daemon 没跑而此刻要起 → 它漂到 17651，
   * **浏览器的麦克风授权按 origin 隔离，端口一变就得重新授权**（`daemon.test.ts:145`）。
   *
   * 按 PROTOCOL §9-bis 的判据，端口占用**不是** kill -9 会留下的持久状态
   * （socket 随进程消失），所以它的严重性远低于指针那条 —— 但它是**跑的时候**
   * 就可能撞上用户的实例，而修它只要改一个数字。
   */
  const port = 19_940 + Math.floor(Math.random() * 40);
  const d = await startDaemon({ port, dataDir: dir, maxPort: port + 20 });
  base = `http://127.0.0.1:${d.port}`;
  token = d.token;
  stop = d.stop;
});
after(async () => {
  await stop?.();
});

const H = (): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function patch(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: H(),
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function getSettings(): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/api/settings`, { headers: H() });
  const body = (await r.json()) as { settings: Record<string, unknown> };
  return body.settings;
}

describe('PATCH /api/settings —— 写什么读回来必须是什么', () => {
  it('扁平形状：键名逐字相同，值原样', async () => {
    const res = await patch({
      'llm.defaultProviderId': 'deepseek',
      'llm.defaultModelId': 'deepseek-chat',
    });
    assert.equal(res.status, 200);
    const got = await getSettings();
    assert.equal(got['llm.defaultProviderId'], 'deepseek');
    assert.equal(got['llm.defaultModelId'], 'deepseek-chat');
  });

  it('★ 信封形状（把 GET 的结果原样 PATCH 回去）必须往返，且**不产生嵌套**', async () => {
    const res = await patch({ settings: { 'llm.baseUrl.deepseek': 'https://api.deepseek.com' } });
    assert.equal(res.status, 200);
    const got = await getSettings();
    assert.equal(got['llm.baseUrl.deepseek'], 'https://api.deepseek.com');
    // 这一条才是真正的回归点：曾经这里会多出一个字面叫 settings 的键
    assert.ok(!('settings' in got), '产生了嵌套的 settings 键');
  });

  it('★ 双层信封必须**明确报错**，而不是静默存成坏数据', async () => {
    const res = await patch({ settings: { settings: { 'a.b': 1 } } });
    assert.equal(res.status, 400);
    assert.equal((res.json['error'] as { code: string }).code, 'BAD_SETTING_KEY');
  });

  it('GET 的输出可以直接喂回 PATCH（往返幂等）', async () => {
    const before = await getSettings();
    const res = await patch({ settings: before });
    assert.equal(res.status, 200);
    const after = await getSettings();
    assert.deepEqual(after, before);
  });

  it('null 是合法值（清空），不能被当成 undefined 拒掉', async () => {
    await patch({ 'llm.defaultModelId': null });
    const got = await getSettings();
    assert.ok('llm.defaultModelId' in got);
    assert.equal(got['llm.defaultModelId'], null);
  });
});

describe('PUT /api/secrets/:key —— 密钥写入链路', () => {
  it('写入后 GET 能看到该键（值永远只回掩码）', async () => {
    const r = await fetch(`${base}/api/secrets/llm.deepseek.apiKey`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ value: 'sk-abcdef123456' }),
    });
    assert.equal(r.status, 200);
    const list = (await (await fetch(`${base}/api/secrets`, { headers: H() })).json()) as {
      secrets: Array<{ key: string; masked: string }>;
    };
    const hit = list.secrets.find((s) => s.key === 'llm.deepseek.apiKey');
    assert.ok(hit, '写进去的密钥读不回来');
    // 明文绝不能出现在响应里
    assert.ok(!hit.masked.includes('abcdef'), '掩码泄漏了明文');
  });
});

/**
 * CSRF 同源兜底（ADR 裁决）的**边界**测试。
 *
 * 兜底本身能过很容易测；真正要钉住的是**它不该救哪些情况** ——
 * 否则日后有人"顺手放宽一点"，兜底就悄悄变成了"CSRF 形同虚设"。
 */
describe('CSRF 同源兜底 —— 放行一种，拒绝四种', () => {
  /*
   * ★ 这一组必须在 `OPENMEMO_AUTH=token` 下跑。
   * 默认档（none）连鉴权带 CSRF 一起跳过，这些边界根本不存在 ——
   * 若不显式切档，用例会"通过"得毫无意义，或像这次一样变红却让人误以为是回归。
   * 显式切档同时也验证了**开关的另一半仍然work**（别把开关做成单向门）。
   *
   * T-135：原来这里是就地写的 before/after 一段。**这段话是对的，做法也是对的** ——
   * 只是隔壁那一组（下面的"仅凭 cookie 续签"）没有照做，于是它红了几小时没人看见。
   * 现在换成共用的 `pinAuthMode()`，钉完会**回读一次确认真的生效**
   * （env 曾经改不动 —— `AUTH_MODE` 做成过模块加载时求值的常量）。
   */
  pinAuthMode('token');

  let cookie = '';
  let csrf = '';
  const origin = (): string => base;
  const host = (): string => base.replace('http://', '');

  before(async () => {
    const r = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    csrf = ((await r.json()) as { csrf: string }).csrf;
  });

  const write = async (h: Record<string, string>): Promise<number> => {
    const r = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ 'ui.probe': Date.now() }),
    });
    return r.status;
  };

  it('无 CSRF 头 + 严格同源 + Sec-Fetch-Site:same-origin → 放行', async () => {
    assert.equal(await write({ Origin: origin(), 'Sec-Fetch-Site': 'same-origin' }), 200);
  });

  it('★ 带了**错的** CSRF 头 → 仍然拒绝（兜底不救它）', async () => {
    assert.equal(
      await write({
        Origin: origin(),
        'Sec-Fetch-Site': 'same-origin',
        'x-openmemo-csrf': 'WRONG',
      }),
      403,
    );
  });

  it('★ Sec-Fetch-Site: cross-site → 拒绝', async () => {
    assert.equal(await write({ Origin: origin(), 'Sec-Fetch-Site': 'cross-site' }), 403);
  });

  it('★ Origin 与 Host 不同源 → 拒绝', async () => {
    assert.equal(await write({ Origin: 'http://evil.example' }), 403);
  });

  it('★ 完全没有 Origin（无从证明同源）→ 拒绝', async () => {
    assert.equal(await write({}), 403);
  });

  it('带正确 CSRF 头 → 放行（正常路径不受影响）', async () => {
    assert.equal(await write({ 'x-openmemo-csrf': csrf, Origin: origin() }), 200);
    assert.ok(host().length > 0);
  });
});

/**
 * **仅凭 cookie 续签会话** —— 新标签页自愈的最后一环。
 *
 * 机制：cookie 是 per-origin（跨标签共享），CSRF 令牌是 per-tab。
 * 第二个标签页（地址里没有 `#t=`）带得动 cookie、带不动 CSRF 令牌，
 * 于是**读全通、界面正常、写全 403、库里 0 行** —— 不需要任何存储故障。
 * 没有这条续签，新标签就无法自愈：它既没有 token 可重新握手，
 * 又拿不到 CSRF 令牌，而原始链接早被前端从地址栏抹掉了（防截图泄露）。
 */
describe('POST /api/auth/session —— 仅凭 cookie 续签', () => {
  /*
   * ★ T-135：这一组也必须钉 `token` 档 —— 它整组测的都是**续签的边界**
   * （伪造 cookie 要 401、两者都无要 401、同一会话要复用同一个 CSRF 令牌），
   * 而这些边界在 `none` 档下**根本不存在**：那时握手对谁都回 200。
   *
   * 它原来靠"鉴权默认开着"。默认值翻成 `none` 之后这 4 条一直是红的，
   * 而上面那一组因为写了显式切档所以一直是绿的 —— **同一个文件里，
   * 一组做对了、隔壁一组没做，红了也没人看见**（当时的 test 脚本扫不到这个文件）。
   *
   * `none` 档那一半的覆盖在 `daemon.test.ts` 的「鉴权关闭档」一组。
   */
  pinAuthMode('token');

  it('★ 只带 cookie（无 Bearer）必须 200，且返回**可用的** CSRF 令牌', async () => {
    // 标签页 1：正常握手拿 cookie
    const first = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(cookie, '首次握手没有下发 cookie');

    // 标签页 2：只有 cookie，没有 Bearer
    const second = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { cookie } });
    assert.equal(second.status, 200, '仅 cookie 续签被拒 —— 新标签页无法自愈');
    const body = (await second.json()) as { csrf: string; renewed?: boolean };
    assert.ok(body.csrf, '续签没有返回 CSRF 令牌');
    assert.equal(body.renewed, true);

    // 关键：拿到的令牌必须真的能写，否则"200"毫无意义
    const w = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json', 'x-openmemo-csrf': body.csrf },
      body: JSON.stringify({ 'ui.renewProbe': 1 }),
    });
    assert.equal(w.status, 200, '续签返回的 CSRF 令牌不可用');
  });

  it('续签**复用同一个会话**（同一个 CSRF 令牌），不是每个标签新建一个', async () => {
    const first = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const csrf1 = ((await first.json()) as { csrf: string }).csrf;
    const again = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { cookie } });
    const csrf2 = ((await again.json()) as { csrf: string }).csrf;
    assert.equal(csrf2, csrf1);
  });

  it('两者都无 → 仍 401，且带可执行的 remediation', async () => {
    const r = await fetch(`${base}/api/auth/session`, { method: 'POST' });
    assert.equal(r.status, 401);
    const b = (await r.json()) as { error: { remediation?: { action: string } } };
    assert.equal(b.error.remediation?.action, 'openHandoffUrl');
  });

  it('★ 伪造/失效的 cookie → 必须 401（续签不等于放行任何 cookie）', async () => {
    const r = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { cookie: 'openmemo_sid=bogus-not-a-real-sid' },
    });
    assert.equal(r.status, 401);
  });
});
