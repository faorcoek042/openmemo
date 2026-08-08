/**
 * `lib/api/client.ts` 的单元测试 —— **它此前一条单测都没有**（T-137 §E 的 E8）。
 *
 * ## 为什么这个文件必须存在
 *
 * client.ts 是前端唯一的 HTTP 收口：CSRF、握手闸门、401/403 自愈、端点级记账、
 * 以及那条被项目自己称为"比报错糟糕得多"的不变量 ——
 * **写操作永不静默回落 mock**。
 *
 * 组件套件里有一条名叫「★ 写操作遇到不存在的路由必须抛错，绝不静默"成功"」的用例。
 * T-137 的变异实测把 `apiCall` 里的 `!isWrite &&` 守卫**整句删掉**，
 * 176/176 **依然全绿**。根因不是断言写得松，是**前提恒假**：
 *
 * > `mock.ts` 从未被组件测试 bundle import ⇒ `registerMockFetcher` 从不被调用
 * > ⇒ `mockFetcher` 恒为 `null` ⇒ 所有被 `mockFetcher` 守卫的分支在测试里**天然不可达**。
 *
 * 那条用例"绿"是因为**根本没有 mock 可回落**，不是因为守卫生效。
 * 同一次变异里一起存活的还有：删 CSRF 头、删 `credentials:'same-origin'`、删握手前置 ——
 * 四条不变量，零个被钉住。
 *
 * ## 所以这个文件的做法是：**先把前提做成真的**
 *
 * 每组用例都 `registerMockFetcher()` 注册一个**被调用就留痕**的假实现，
 * 并且**成对写**：读路径必须真的回落到它（证明回落机制是活的）、
 * 写路径必须**一次都不碰它**（这才是被钉的那条不变量）。
 * 少了前面那半，后面那半又会变成"断言一件不可能发生的事"。
 *
 * ## 断言的是线上的请求，不是内部状态
 *
 * CSRF 头、cookie 模式、请求先后 —— 全部从**被记录下来的 fetch 参数**里读。
 * 组件套件的 `stubApi` 连请求头都不记录（`grep -n headers host.tsx` 空），
 * 所以"头到底有没有发出去"在全套测试里此前一个字都没有断言过。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  ApiError,
  api,
  clearCsrf,
  forgetMissingEndpoints,
  hasCsrf,
  missingEndpointList,
  registerMockFetcher,
} from './client';
import type { ApiOptions } from './client';
import { resetConnection } from './connect';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: string | undefined;
}

/** 每一次真实 fetch 都留痕 —— 断言只看这里，不看模块内部变量。 */
let calls: Recorded[] = [];
/** `METHOD url` → 响应。没登记的一律 404（= "daemon 还没实现这条路由"）。 */
let routes = new Map<string, { status: number; body: unknown }>();
/** mock 回落被调用过几次 —— 这是本文件全部结论的支点。 */
let mockCalls: { path: string; method: string }[] = [];

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({ url, method, headers, credentials: init.credentials });
    const hit = routes.get(`${method} ${url}`);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          hit?.body ?? { error: { code: 'NOT_FOUND', message: `no route ${method} ${url}` } },
        ),
        { status: hit?.status ?? 404, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
}

const CSRF = 'csrf-token-from-handshake';

/**
 * 每组用例重置全部共享状态并**真的走一次握手**。
 *
 * connect.ts 的握手是单例 promise，跨用例会被复用；不显式重置的话，
 * 「握手必须排在业务请求前面」那条断言会看不到 health/session
 * （它们在第一组用例里就已经跑完了）—— 那会变成一条恒真的断言。
 */
async function freshHandshake(): Promise<void> {
  calls = [];
  mockCalls = [];
  routes = new Map([
    [
      'GET /api/health',
      {
        status: 200,
        body: { version: '0', instanceId: 'i', contractVersion: 1, port: 80, pid: 1 },
      },
    ],
    ['POST /api/auth/session', { status: 200, body: { csrf: CSRF } }],
  ]);
  clearCsrf();
  forgetMissingEndpoints();
  registerMockFetcher(async <T>(path: string, opts?: ApiOptions): Promise<T> => {
    mockCalls.push({ path, method: (opts?.method ?? 'GET').toUpperCase() });
    return { fromMock: true } as T;
  });
  await resetConnection();
}

/** 业务请求（滤掉握手自己发的那两条）。 */
function businessCalls(): Recorded[] {
  return calls.filter((c) => c.url !== '/api/health' && c.url !== '/api/auth/session');
}

/*
 * connect.ts 在握手里读 `window.location.port` 做端口漂移检测（Node 里没有 window）。
 * client.ts 也在模块加载时读 `window.location.hash` 取交接 token —— 那一处
 * 有 `typeof window === 'undefined'` 的早退，所以 import 时不需要它就位；
 * 握手那一处没有早退，所以必须在第一次 resetConnection() 之前装好。
 */
(globalThis as unknown as { window: unknown }).window = {
  location: { hash: '', pathname: '/', search: '', port: '' },
  history: { replaceState: () => undefined },
};
installFetch();

describe('client —— 写操作永不静默回落 mock（T-137 §E E3：这条不变量此前零覆盖）', () => {
  beforeEach(async () => {
    installFetch();
    await freshHandshake();
  });

  it('前提自检：mock 回落机制是活的 —— 读操作打到不存在的路由必须真的落到 mock', async () => {
    /*
     * ★ 这条是**对照组，不是凑数**。
     * T-137 变异实测里那条写操作用例之所以"绿"，正是因为 `mockFetcher` 恒为 null、
     * 整条回落分支不可达。所以下面每一条"写没回落"的断言，
     * 都必须先由这一条证明"回落本来是会发生的"，
     * 否则它们又是在断言一件不可能发生的事。
     */
    const out = await api<{ fromMock?: boolean }>('notes', '/nonexistent-read');
    assert.equal(
      out.fromMock,
      true,
      'GET 打到 404 没有回落 mock —— 回落机制已经死了，本文件下面的断言全部失去意义',
    );
    assert.equal(mockCalls.length, 1);
    assert.equal(mockCalls[0]?.method, 'GET');
  });

  it('★ POST 打到不存在的路由：必须抛错，且 mock 一次都不能被调用', async () => {
    await assert.rejects(
      () => api('notes', '/nonexistent-write', { method: 'POST', body: { a: 1 } }),
      (err: unknown) => err instanceof ApiError && err.status === 404,
      '写操作吞掉 404 = 用户以为保存了、实际什么都没发生',
    );
    assert.equal(
      mockCalls.length,
      0,
      `写操作回落到了 mock：${JSON.stringify(mockCalls)} —— 这正是「比报错糟糕得多」的那件事`,
    );
  });

  it('★ PATCH / PUT / DELETE 与 POST 同一条判据（别只守住一个动词）', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      await assert.rejects(
        () => api('notes', '/nonexistent-write', { method }),
        (err: unknown) => err instanceof ApiError,
        `${method} 没有抛错`,
      );
    }
    assert.equal(mockCalls.length, 0, JSON.stringify(mockCalls));
  });

  it('★ 端点已被记成"缺失"之后，写请求仍然必须**发出去**，不许抄近路回 mock', async () => {
    /*
     * `apiCall` 开头那条 `if (!isWrite && missingEndpoints.has(key))` 是**第二个**
     * `!isWrite` 守卫（T-137 变异里两处一起被删都没红）。
     * 它守的是"这条路由我们已经知道不存在了"之后的**下一次**调用：
     * 读可以抄近路直接回 mock，写必须再去问一次服务端 ——
     * daemon 可能刚补上这条路由，本地缓存的判断不能替服务端做决定。
     * 记账键含 method，所以必须**同一个动词连打两次**才测得到这条守卫。
     */
    // 读：第一次真发、落 mock；第二次直接抄近路
    await api('notes', '/maybe-later').catch(() => undefined);
    assert.equal(
      missingEndpointList().includes('GET /maybe-later'),
      true,
      '前提：GET 已被记成缺失',
    );
    calls = [];
    mockCalls = [];
    await api('notes', '/maybe-later').catch(() => undefined);
    assert.equal(mockCalls.length, 1, '读操作第二次应该走 mock 快路径');
    assert.equal(businessCalls().length, 0, '读操作走了快路径就不该再发网络请求');

    // 写：第一次抛错并记账；第二次**必须仍然发出去**
    await api('notes', '/maybe-later', { method: 'POST' }).catch(() => undefined);
    assert.equal(
      missingEndpointList().includes('POST /maybe-later'),
      true,
      '前提：POST 已被记成缺失',
    );
    calls = [];
    mockCalls = [];
    await api('notes', '/maybe-later', { method: 'POST' }).catch(() => undefined);
    assert.equal(mockCalls.length, 0, '写操作抄了近路回落 mock');
    assert.equal(
      businessCalls().length,
      1,
      '写操作没有真的发出去 —— daemon 补上路由之后用户会永远保存失败',
    );
  });

  it('★ 网络层整个不可达时，写操作同样不许回落 mock（TypeError 分支）', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> =>
      Promise.reject(new TypeError('Failed to fetch'));
    await assert.rejects(
      () => api('notes', '/anything', { method: 'POST' }),
      (err: unknown) => err instanceof ApiError && err.status === 503,
      'daemon 没起时写操作必须报 503，不能假装成功',
    );
    assert.equal(mockCalls.length, 0, '离线时写操作回落了 mock');
  });

  it('对照：网络层不可达时，读操作**应该**回落 mock（不然界面整片空白）', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> =>
      Promise.reject(new TypeError('Failed to fetch'));
    const out = await api<{ fromMock?: boolean }>('notes', '/anything');
    assert.equal(out.fromMock, true);
    assert.equal(mockCalls.length, 1);
  });
});

describe('client —— CSRF 头与 cookie 真的上了线（此前全套测试一个字没断言）', () => {
  beforeEach(async () => {
    installFetch();
    await freshHandshake();
    routes.set('POST /api/thing', { status: 200, body: { ok: true } });
    routes.set('GET /api/thing', { status: 200, body: { ok: true } });
  });

  it('★ 写请求必须带 X-OpenMemo-CSRF，值就是握手拿回来的那个', async () => {
    await api('notes', '/thing', { method: 'POST', body: { a: 1 } });
    const req = businessCalls().at(-1);
    assert.equal(req?.method, 'POST');
    assert.equal(
      req?.headers['x-openmemo-csrf'],
      CSRF,
      '不带 CSRF 头的写请求会被 daemon 403 —— 现象是"界面一切正常、所有保存静默失败"',
    );
  });

  it('GET 不带 CSRF 头（双提交只对非幂等方法有意义）', async () => {
    await api('notes', '/thing');
    const req = businessCalls().at(-1);
    assert.equal(req?.method, 'GET');
    assert.equal('x-openmemo-csrf' in (req?.headers ?? {}), false);
  });

  it('★ 每一个请求都必须 credentials:"same-origin" —— 少了它 cookie 不上线，写全 403', async () => {
    await api('notes', '/thing');
    await api('notes', '/thing', { method: 'POST', body: {} });
    const bad = calls.filter((c) => c.credentials !== 'same-origin');
    assert.equal(
      bad.length,
      0,
      `这些请求没带 same-origin：${JSON.stringify(bad.map((c) => `${c.method} ${c.url}`))}`,
    );
  });

  it('★ 读请求也必须等握手完成再发 —— 判据是时间线，不是"gate 被调用过"', async () => {
    /*
     * 这条守的是 `apiCall` 里那句 `await gate()`。
     * 删掉它不会有任何测试变红（T-137 实测），而线上后果是**首屏每个 query 都比握手快**
     * ⇒ 一片 401 ⇒ 用户看到满屏"未认证，请重新打开应用"。
     *
     * ## 为什么这条必须用 **GET** 写（我第一版写成 POST，变异照样全绿）
     *
     * 写路径上还有第二个机制：`if (isWrite && !hasCsrf()) await reHandshake()`。
     * 它出于另一个理由（第二个标签页没有令牌）也会把握手排到业务请求前面 ——
     * 于是**把 `await gate()` 整句删掉，用 POST 写的那条断言依然通过**。
     * 那不是断言写松了，是**被另一条路径顶住了**：`gate()` 真正独占守护的只有读请求。
     * 判据得选在"只有被测行为能让它成立"的地方，这正是 HANDOFF #18 那条规矩的具体形态。
     */
    calls = [];
    const pending = resetConnection(); // 故意不 await —— gate() 必须自己等它
    const out = await api<{ ok?: boolean }>('notes', '/thing');
    await pending;
    assert.equal(out.ok, true);
    const order = calls.map((c) => `${c.method} ${c.url}`);
    const sessionIdx = order.indexOf('POST /api/auth/session');
    const bizIdx = order.indexOf('GET /api/thing');
    assert.equal(sessionIdx >= 0, true, `握手根本没发生：${JSON.stringify(order)}`);
    assert.equal(bizIdx >= 0, true, `业务请求没发出去：${JSON.stringify(order)}`);
    assert.equal(
      sessionIdx < bizIdx,
      true,
      `业务请求跑在握手前面了（首屏就是这么一片 401 的）：${JSON.stringify(order)}`,
    );
  });

  it('★ 写请求在令牌不在手上时必须先补一次握手（与上一条不同的机制，分开钉）', async () => {
    /*
     * 上一条守 `await gate()`，这一条守 `if (isWrite && !hasCsrf()) await reHandshake()`。
     * 两者线上后果不同：前者是首屏 401 一片，
     * 后者是**开第二个标签页时"读全通、写全 403"**（cookie per-origin，CSRF 令牌 per-tab）。
     * 合成一条会让删掉其中任意一个都不变色 —— 那正是上一条第一版踩到的坑。
     */
    clearCsrf();
    calls = [];
    assert.equal(hasCsrf(), false, '前提：令牌不在手上');
    const out = await api<{ ok?: boolean }>('notes', '/thing', { method: 'POST', body: {} });
    assert.equal(out.ok, true);
    assert.equal(hasCsrf(), true, '写请求前没有补握手 —— 第二个标签页会"写全 403"');
    const order = calls.map((c) => `${c.method} ${c.url}`);
    const sessionIdx = order.indexOf('POST /api/auth/session');
    const bizIdx = order.indexOf('POST /api/thing');
    assert.equal(sessionIdx >= 0 && sessionIdx < bizIdx, true, JSON.stringify(order));
    assert.equal(
      calls[bizIdx]?.headers['x-openmemo-csrf'],
      CSRF,
      '补了握手却没把新令牌带上，等于没补',
    );
  });
});

describe('client —— 端点级记账不许牵连同面的其它端点（真实事故的回归）', () => {
  beforeEach(async () => {
    installFetch();
    await freshHandshake();
    routes.set('GET /api/notes/ok', { status: 200, body: { ok: true } });
  });

  it('★ 一条 404 只毒化它自己，同面的另一条端点必须照常走真接口', async () => {
    /*
     * 事故形态：`PATCH /notes/:uid/mindmap` 不存在 → 一个 404 →
     * 整个 `notes` 面被标成 mock → 星标/标签/段落编辑全部改走内存实现，
     * "渲染是绿的，点了没用，抓包一个非 GET 请求都没有"。
     */
    await api('notes', '/notes/missing').catch(() => undefined);
    calls = [];
    mockCalls = [];
    const out = await api<{ ok?: boolean }>('notes', '/notes/ok');
    assert.equal(out.ok, true, '同面的另一条端点被上一条的 404 带走了');
    assert.equal(mockCalls.length, 0, '同面的另一条端点走了 mock');
    assert.equal(businessCalls().length, 1, '同面的另一条端点没有真的发请求');
  });

  it('ULID 与数字段位在记账键里被归一化（否则每个 uid 各记一条，判断永远攒不起来）', async () => {
    await api('notes', '/notes/01ARZ3NDEKTSV4RRFFQ69G5FAV/segments/3').catch(() => undefined);
    assert.deepEqual(missingEndpointList(), ['GET /notes/:uid/segments/:n']);
  });
});
