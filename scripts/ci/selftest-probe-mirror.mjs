#!/usr/bin/env node
/**
 * `probe-mirror.mjs` 的**变异证明**（#108）。
 *
 * ## 判据必须是**成对**的
 *
 *   ① 造一个「前 N 次失败、第 N+1 次成功」的上游 → 探测必须**成功**，且说得出它重试过；
 *   ② 造一个「一直失败」的上游                 → 必须**仍然红**，且报告里有次数与原因。
 *
 * 少了 ①，「根本不重试」也能过；少了 ②，「永远重试」也能过。
 * 所以这两条在下面是**并排**的，谁被删掉另一条都会立刻变成一句空话。
 *
 * ## 替身是**真的 HTTP 服务器**，实现的是真实契约的失败分支
 *
 * 不打真上游（GitHub 匿名 60 次/小时/IP，一次未去重扫描就吃掉 25 次 —— 实测数），
 * 也不 stub `probeUrl`：stub 掉的话，测到的只是我对 `node:http` 的想象。
 * 这里起一个 `node:http` 服务器（绑 `:0`，端口由 OS 分配，不出网）：
 *   · 503 是真的状态行；
 *   · `socket hang up` 是真的把 socket 掐掉（19:07 那条日志的形状）；
 *   · 404 是真的 404（用来钉"确定性失败一次都不重试"）。
 *
 * 退避等待在自检里被压到毫秒级（`policy` 可注入），**次数与判据一个字都不改** ——
 * 被压缩的只有 `setTimeout` 的参数。
 *
 * 用法：`node scripts/ci/selftest-probe-mirror.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';

import {
  A_LAYER_RETRY_POLICY,
  attemptTrail,
  isRetriableProbe,
  probeFollow,
  retryDelayMs,
  retryFailedProbes,
  summarizeRetryZh,
} from './probe-mirror.mjs';

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
async function check(name, fn) {
  cases += 1;
  try {
    await fn();
    say(`  ✔ ${name}`);
  } catch (e) {
    failures += 1;
    say(`  ✘ ${name}\n      ${String(e.message).split('\n')[0]}`);
  }
}

/* ───────────────────────── 桩上游（真 HTTP，端口由 OS 分配） ───────────────────────── */

/** path → { failTimes, mode, status, body }。`failTimes: Infinity` = 永远坏。 */
const plans = new Map();
/** 地面真相：服务端**真的**收到了几次请求。 */
const hits = new Map();

const server = createServer((req, res) => {
  const path = req.url ?? '';
  const n = (hits.get(path) ?? 0) + 1;
  hits.set(path, n);
  const plan = plans.get(path);
  if (!plan) {
    res.writeHead(404).end();
    return;
  }
  if (n <= plan.failTimes) {
    if (plan.mode === 'hangup') {
      req.socket.destroy(); // 连响应行都不给：这就是 `socket hang up`
      return;
    }
    res.writeHead(plan.status ?? 503, { 'content-type': 'text/plain' }).end('upstream is down');
    return;
  }
  const body = plan.body ?? Buffer.from('OK-BYTES');
  res.writeHead(206, {
    'content-length': String(body.length),
    'content-range': `bytes 0-${body.length - 1}/${body.length}`,
  });
  res.end(body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let seq = 0;
function route(plan) {
  seq += 1;
  const path = `/m${seq}.bin`;
  plans.set(path, { mode: 'status', ...plan });
  return `${ORIGIN}${path}`;
}
const hitsOf = (url) => hits.get(new URL(url).pathname) ?? 0;

/** 自检用策略：只压缩等待，次数与判据不变。 */
const FAST = { maxAttempts: 4, baseMs: 5, factor: 2, capMs: 20, budgetMs: 10_000 };

/** 造一批 target（第一轮已经失败过一次）。 */
async function firstPass(urls) {
  const targets = [];
  for (const url of urls) {
    const first = await probeFollow(url);
    targets.push({ key: `k${targets.length}`, label: url, url, first });
  }
  return targets;
}

/* ───────────────────────────────── 策略与分类 ───────────────────────────────── */

say('── 出厂策略：两个上限都必须显式、有限');
await check('★ 次数与总预算都有限 —— "重试到成功为止"不是可接受的实现', () => {
  const P = A_LAYER_RETRY_POLICY;
  assert.ok(
    Number.isFinite(P.maxAttempts) && P.maxAttempts >= 2 && P.maxAttempts <= 8,
    'maxAttempts 必须有限且在 [2,8]',
  );
  assert.ok(Number.isFinite(P.budgetMs) && P.budgetMs > 0, 'budgetMs 必须有限');
  // 累计等待必须装得进总预算，否则最后一轮永远轮不到，那个次数上限就是假的
  const waits = Array.from({ length: P.maxAttempts - 1 }, (_, i) => retryDelayMs(i + 1, P));
  const sum = waits.reduce((a, b) => a + b, 0);
  assert.ok(sum < P.budgetMs, `累计退避 ${sum}ms ≥ 总预算 ${P.budgetMs}ms：最后几轮永远跑不到`);
});
await check('退避指数增长且被 capMs 夹住', () => {
  const P = { baseMs: 1000, factor: 3, capMs: 5000, maxAttempts: 9, budgetMs: 10 ** 6 };
  assert.equal(retryDelayMs(1, P), 1000);
  assert.equal(retryDelayMs(2, P), 3000);
  assert.equal(retryDelayMs(3, P), 5000, '9000 应当被 capMs 夹到 5000');
  assert.equal(retryDelayMs(9, P), 5000);
});
await check('★ 什么该重试、什么不该 —— 反面才是这条改动的重点', () => {
  assert.equal(isRetriableProbe({ ok: false, status: 503 }), true);
  assert.equal(isRetriableProbe({ ok: false, status: 500 }), true);
  assert.equal(isRetriableProbe({ ok: false, status: 429 }), true);
  assert.equal(isRetriableProbe({ ok: false, reason: 'socket hang up' }), true, '传输层错误要重试');
  // ↓ 这四条是"别把真的不可达重试成绿"
  assert.equal(isRetriableProbe({ ok: false, status: 404 }), false);
  assert.equal(isRetriableProbe({ ok: false, status: 403 }), false);
  assert.equal(isRetriableProbe({ ok: false, deterministic: true, reason: 'URL 不合法' }), false);
  assert.equal(isRetriableProbe({ ok: true, status: 206 }), false, '成功的不该被重试');
});

/* ─────────────────── ① 前 N 次失败、第 N+1 次成功 → 必须成功 ─────────────────── */

say('');
say('── ① 抖一下的上游：重试之后必须成功，并且说得出它重试过');
await check('★★ 前 2 次 503、第 3 次好了 → 恢复，且尝试史里写着"第 3 次才成"', async () => {
  const url = route({ failTimes: 2, status: 503 });
  const targets = await firstPass([url]);
  assert.equal(targets[0].first.ok, false, '前提：第一轮必须真的失败，否则下面恒真');

  const o = await retryFailedProbes(targets, { probe: probeFollow, policy: FAST });
  assert.equal(o.recovered.length, 1, `应当恢复 1 个，实际 ${o.recovered.length}`);
  assert.equal(o.stillFailing.length, 0);
  assert.equal(o.recovered[0].attempts.length, 3);
  assert.equal(o.rounds, 2, '正好两轮重试');
  assert.equal(hitsOf(url), 3, '地面真相：服务端应当收到 3 次请求');
  const trail = attemptTrail(o.recovered[0].attempts);
  assert.match(trail, /第1次 HTTP 503/, `尝试史没说第一次为什么失败：${trail}`);
  assert.match(trail, /等 \d+ms 后第2次/, `尝试史没说等了多久：${trail}`);
  assert.match(summarizeRetryZh(o), /救回 1 个/);
});
await check('★ `socket hang up`（真的掐 socket）同样能被吸收', async () => {
  const url = route({ failTimes: 1, mode: 'hangup' });
  const targets = await firstPass([url]);
  assert.equal(targets[0].first.ok, false);
  assert.equal(isRetriableProbe(targets[0].first), true, '传输层失败必须被判为可重试');
  const o = await retryFailedProbes(targets, { probe: probeFollow, policy: FAST });
  assert.equal(o.recovered.length, 1);
  assert.equal(hitsOf(url), 2);
});
await check('多个失败镜像共用同一轮等待（总时长不随失败个数放大）', async () => {
  const urls = [
    route({ failTimes: 1, status: 503 }),
    route({ failTimes: 1, status: 502 }),
    route({ failTimes: 1, mode: 'hangup' }),
  ];
  const targets = await firstPass(urls);
  let slept = 0;
  const o = await retryFailedProbes(targets, {
    probe: probeFollow,
    policy: FAST,
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(o.recovered.length, 3);
  assert.equal(o.rounds, 1);
  assert.equal(slept, retryDelayMs(1, FAST), '3 个失败镜像只该等 1 次，不是 3 次');
});

/* ──────────────── ② 一直失败 → 必须仍然红，且说清次数与原因 ──────────────── */

say('');
say('── ② 一直失败的上游：必须仍然红，且报告里有次数、间隔、每次的原因');
await check('★★ 一直 503 → 仍然失败，次数用尽即止（不多不少）', async () => {
  const url = route({ failTimes: Infinity, status: 503 });
  const targets = await firstPass([url]);
  const o = await retryFailedProbes(targets, { probe: probeFollow, policy: FAST });

  assert.equal(o.recovered.length, 0, '一直失败的上游**不许**被判成恢复');
  assert.equal(o.stillFailing.length, 1);
  assert.equal(o.budgetExhausted, false, '这是次数用尽，不是预算用尽');
  assert.equal(o.stillFailing[0].attempts.length, FAST.maxAttempts);
  assert.equal(hitsOf(url), FAST.maxAttempts, '地面真相：正好试满 maxAttempts 次');
  const trail = attemptTrail(o.stillFailing[0].attempts);
  assert.equal(
    (trail.match(/HTTP 503/g) ?? []).length,
    FAST.maxAttempts,
    `每次的原因都要在：${trail}`,
  );
  assert.match(summarizeRetryZh(o), /仍然失败 1 个/);
});
await check('★★ 404 一次都不重试 —— 确定性失败重试三次仍是 404', async () => {
  const url = route({ failTimes: Infinity, status: 404 });
  const targets = await firstPass([url]);
  const o = await retryFailedProbes(targets, { probe: probeFollow, policy: FAST });

  assert.equal(o.stillFailing.length, 1);
  assert.equal(o.neverRetried.length, 1);
  assert.equal(o.ran, false, '没有任何值得重试的东西时不该开轮次');
  assert.equal(hitsOf(url), 1, '404 被重试了 —— 那正是"把真的不可达重试成绿"的第一步');
});
await check('★ 一半抖一半死：抖的救回来，死的照样红（同一轮里两种结局分得开）', async () => {
  const flaky = route({ failTimes: 1, status: 503 });
  const dead = route({ failTimes: Infinity, status: 503 });
  const targets = await firstPass([flaky, dead]);
  const o = await retryFailedProbes(targets, { probe: probeFollow, policy: FAST });

  assert.deepEqual(
    o.recovered.map((s) => s.target.url),
    [flaky],
  );
  assert.deepEqual(
    o.stillFailing.map((s) => s.target.url),
    [dead],
  );
  assert.equal(hitsOf(flaky), 2, '恢复之后不该继续重试它');
  assert.equal(hitsOf(dead), FAST.maxAttempts);
});
await check('★ 总预算先到 → 停下、判红，并明说是预算而不是次数', async () => {
  const url = route({ failTimes: Infinity, status: 503 });
  const targets = await firstPass([url]);
  // 第一轮就要等 5000ms，而总预算只有 10ms ⇒ 一轮都跑不了
  const o = await retryFailedProbes(targets, {
    probe: probeFollow,
    policy: { maxAttempts: 4, baseMs: 5000, factor: 3, capMs: 60_000, budgetMs: 10 },
  });

  assert.equal(o.budgetExhausted, true);
  assert.equal(o.ran, false);
  assert.equal(o.stillFailing.length, 1);
  assert.equal(hitsOf(url), 1, '预算不够时不该偷偷再发请求');
  const sum = summarizeRetryZh(o);
  assert.match(sum, /总预算先用尽/, `预算用尽必须说出来：${sum}`);
});

/* ─────────────────────── 空集：不许读成"全都恢复了" ─────────────────────── */

say('');
say('── 前提自检：空集不许被读成"全都好"');
await check('★ 一个失败镜像都没有时，结论是"没有触发重试"，**不是**"全部恢复"', async () => {
  const o = await retryFailedProbes([], { probe: probeFollow, policy: FAST });
  assert.equal(o.considered, 0);
  assert.equal(o.ran, false);
  assert.equal(o.recovered.length, 0);
  const sum = summarizeRetryZh(o);
  assert.match(sum, /没有触发重试/, sum);
  assert.doesNotMatch(sum, /救回/, `空集说出了"救回" —— 那是把"没测"读成"都好"：${sum}`);
  assert.match(summarizeRetryZh(null), /没有触发重试/);
});
await check('没有 probe 就当场抛，不许静默什么都不做', async () => {
  await assert.rejects(async () =>
    retryFailedProbes([{ key: 'a', url: 'x', first: { ok: false } }], {}),
  );
});

server.close();

say('');
say(`${failures === 0 ? '✔' : '✘'} selftest-probe-mirror：${cases - failures}/${cases} 通过`);
process.exit(failures === 0 ? 0 : 1);
