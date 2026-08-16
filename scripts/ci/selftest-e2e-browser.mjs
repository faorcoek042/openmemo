#!/usr/bin/env node
/**
 * `e2e-browser-assertions.mjs` 的**变异证明** —— 本机能跑，不需要浏览器、不需要包、
 * 不需要 GitHub。几十毫秒。
 *
 * ## 这份文件为什么存在
 *
 * 因为 browser 那条腿的**证伪腿自己**烂了三夜，而没有任何东西能在几十分钟之内告诉我们。
 *
 * `[CI 实测]` 同一条变异证明的四次判决：
 *
 * | run | 平台 | 变异体在场 | 窗内观测 | 老判据 |
 * |---|---|---|---|---|
 * | 31736237514 | win32 | 是 | DOM 自己变了、`/api` 0 条 | **MUT-BAD**（变异存活） |
 * | 31833084492 | win32 | 是 | DOM 自己变了、`/api` 0 条 | **MUT-BAD** |
 * | 31902320145 | win32 | 是 | DOM 自己变了、`/api` 0 条 | **MUT-BAD** |
 * | 31902320145 | darwin | 是 | DOM 自己变了、`/api` 4 条（catalog/storage/jobs×2） | **MUT-BAD** |
 * | 31902320145 | linux | 是 | 全静止 | MUT-OK（**只是恰好静止**） |
 *
 * 判据在于「**这一次点击**导致了什么」，而老判据量的是「**窗里发生过什么**」。
 * 两者只在页面静止时才相等，于是判决变成了掷硬币。
 *
 * ## 每条判据过五关
 *
 *   ① **真形状（三夜那四格的原始数字）必须判"死"** —— 挡"恒不触发"；
 *   ② **每一个健康形状都不许判"死"** —— 挡"恒触发"（把 B1 弄成恒红也能骗过 ①）；
 *   ③ **抽掉修法它会绿吗** —— 把老判据原样写在这里，喂同样的输入，
 *      必须判"活"。它绿了，才证明新判据抓到的是真东西，不是运气；
 *   ④ **未捕获异常凑不出"活着"**，也凑不出"如期变红" ——
 *      「断言判红」和「腿炸了」必须分得开（v0.7.3 抓到过反方向的一条）；
 *   ⑤ **契约漂移守卫**：`PROBE_EFFECT` 那条 `方法 + 路径` 必须真的还在
 *      `packages/shared/src/api.ts` 的 `ENDPOINTS` 里。端点改名而这里没跟，
 *      判据会退化成**恒不命中 ⇒ 恒红**，而恒红的门等于没有门。
 *
 * 用法：`node scripts/ci/selftest-e2e-browser.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROBE_EFFECT,
  apiKeys,
  judgeDeadButton,
  judgeExpectedEffect,
  judgeReaction,
  requestKey,
} from './e2e-browser-assertions.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
const ok = (name) => {
  cases += 1;
  say(`  ✔ ${name}`);
};
const bad = (name, why) => {
  cases += 1;
  failures += 1;
  say(`  ✘ ${name}\n      ${why}`);
};
function expect(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, String(e.message ?? e));
  }
}

const BASE = 'http://127.0.0.1:19980';
const req = (m, p) => `${m} ${BASE}${p}`;

/**
 * ★ 老判据，**逐字照抄修复前的那四行**（`clickAndObserve()` 里的 `reacted:`）。
 * 留在这里只有一个用途：证明新判据抓到的东西，老判据**放过了**。
 * 它一旦对下面那些真形状也判"没反应"，说明我抄错了 —— 那这份证明就什么都没证明。
 */
const legacyReacted = (obs) =>
  obs.urlChanged === true ||
  obs.domChanged === true ||
  (obs.apiRequests ?? []).length > 0 ||
  (obs.newPageErrors ?? []).length > 0;

/* ══════════════════════════════════════════════════════════════════════════ */
/* 真形状：三夜那四格，数字逐格照抄 CI 日志                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * `[CI 实测 run 31902320145, darwin-arm64]`：
 *
 * ```
 * 变异体装上了=true（按钮就绪=true，等了 337 ms）
 * ── 「立即测速」（已被变异成死按钮）
 *    存在=true 可见=true 禁用=false 文案="立即测速"
 *    点击成功=true
 *    URL 变了=false  DOM 变了=true  /api 请求 4 条
 *      → GET  /api/models/catalog?role=all&lang=zh
 *      → GET  /api/models/storage
 *      → GET  /api/jobs
 *      → GET  /api/jobs
 *    **有反应 = true**
 * ```
 *
 * 四条一条都不是点击导致的：catalog / storage 是这一页首屏查询迟到落地，
 * `/api/jobs` 是任务列表 5 秒兜底轮询（`apps/web/src/lib/api/jobs.ts` 的 `JOBS_POLL_MS`）。
 * 空转对照窗照同样的现场构造：那一段里页面也在发同一批、也在自己改 DOM。
 */
const DEAD_DARWIN = {
  clicked: true,
  urlChanged: false,
  domChanged: true,
  apiRequests: [
    req('GET', '/api/models/catalog?role=all&lang=zh'),
    req('GET', '/api/models/storage'),
    req('GET', '/api/jobs'),
    req('GET', '/api/jobs'),
  ],
  newPageErrors: [],
  ambient: {
    domChanged: true,
    apiRequests: [
      req('GET', '/api/models/catalog?role=all&lang=en'),
      req('GET', '/api/models/storage'),
      req('GET', '/api/jobs'),
    ],
  },
  expectApi: PROBE_EFFECT,
};

/**
 * `[CI 实测 run 31736237514 / 31833084492 / 31902320145, win32-x64]`（三夜逐字相同）：
 *
 * ```
 *    URL 变了=false  DOM 变了=true  /api 请求 0 条
 *    **有反应 = true**
 * ```
 *
 * 一条请求都没有 —— **唯一**的"反应"是 DOM 指纹自己变了。
 */
const DEAD_WIN32 = {
  clicked: true,
  urlChanged: false,
  domChanged: true,
  apiRequests: [],
  newPageErrors: [],
  ambient: { domChanged: true, apiRequests: [] },
  expectApi: PROBE_EFFECT,
};

/**
 * `[CI 实测 run 31902320145, linux-x64]`：恰好全静止，老判据也抓住了。
 * 留着它是为了证明新判据**没有把已经能抓的那一格弄丢**。
 */
const DEAD_LINUX = {
  clicked: true,
  urlChanged: false,
  domChanged: false,
  apiRequests: [],
  newPageErrors: [],
  ambient: { domChanged: false, apiRequests: [] },
  expectApi: PROBE_EFFECT,
};

/**
 * 健康形状：变异体**不在场**，按钮是活的。
 * `[CI 实测 run 31902320145, darwin-arm64 / linux-x64]` 基线轮里那一条请求
 * 正是 `POST /api/models/sources/probe`（win32 那格是它 + `GET /api/models/sources`）。
 */
const ALIVE = {
  clicked: true,
  urlChanged: false,
  domChanged: true,
  apiRequests: [req('POST', '/api/models/sources/probe'), req('GET', '/api/models/sources')],
  newPageErrors: [],
  ambient: { domChanged: false, apiRequests: [] },
  expectApi: PROBE_EFFECT,
};

/** 活按钮 + **极度嘈杂**的页面。判"活"不许因为噪声而丢。 */
const ALIVE_NOISY = {
  ...ALIVE,
  ambient: {
    domChanged: true,
    apiRequests: [req('GET', '/api/jobs'), req('GET', '/api/models/storage')],
  },
  apiRequests: [
    req('GET', '/api/jobs'),
    req('POST', '/api/models/sources/probe'),
    req('GET', '/api/models/storage'),
  ],
};

say('── ① 真形状（变异体在场）必须判"死" ──────────────────────────────────────');

for (const [label, obs] of [
  ['run 31902320145 darwin：后台 4 条轮询 + DOM 自己在变', DEAD_DARWIN],
  ['run 31736237514/31833084492/31902320145 win32：0 条请求，只有 DOM 自己在变', DEAD_WIN32],
  ['run 31902320145 linux：全静止（老判据也抓得住，不许丢）', DEAD_LINUX],
]) {
  expect(`${label} ⇒ 死`, () => {
    const v = judgeDeadButton(obs);
    assert.equal(v.verdict, 'dead', `判成了 ${v.verdict}：${v.why}`);
  });
}

say('');
say('── ② 健康形状不许判"死"（挡"把 B1 弄成恒红"）─────────────────────────────');

for (const [label, obs] of [
  ['基线轮：POST probe 发出去了', ALIVE],
  ['基线轮 + 页面同时在轰轰响（后台轮询 + DOM 自己在变）', ALIVE_NOISY],
]) {
  expect(`${label} ⇒ 活`, () => {
    const v = judgeDeadButton(obs);
    assert.equal(v.verdict, 'alive', `判成了 ${v.verdict}：${v.why}`);
  });
}

say('');
say('── ③ 抽掉修法它会绿吗（这一节才是这份文件的意义）────────────────────────');

expect('老判据对 darwin 那格判"有反应" —— 即当年变异存活的那一格', () => {
  assert.equal(legacyReacted(DEAD_DARWIN), true, '老判据没放过它？那我把老判据抄错了');
});
expect('老判据对 win32 那格判"有反应" —— 三夜都是它', () => {
  assert.equal(legacyReacted(DEAD_WIN32), true, '老判据没放过它？那我把老判据抄错了');
});
expect('老判据对 linux 那格判"没反应" —— 当年唯一抓住的那格', () => {
  assert.equal(legacyReacted(DEAD_LINUX), false);
});

/*
 * ★ 把两条修法**逐条**抽掉，各自单独复现"变异存活"。
 *   两条都抽 = 老判据；只抽一条也要看得见谁在扛。
 */
expect('只抽掉「空转对照窗」（ambient=null）⇒ darwin/win32 两格重新判"活"', () => {
  for (const [name, obs] of [
    ['darwin', DEAD_DARWIN],
    ['win32', DEAD_WIN32],
  ]) {
    // 没有对照窗时，`该发生的那件事` 仍在 ⇒ 判据只靠 ② 扛着。
    const noAmbient = judgeReaction({ ...obs, ambient: null });
    assert.equal(noAmbient.reacted, true, `${name}：没了对照窗，"有反应"应当重新恒真`);
  }
});
expect('只抽掉「该发生的那件事」（expectApi=null）⇒ darwin/win32 仍然判"死"，靠对照窗扛着', () => {
  for (const [name, obs] of [
    ['darwin', DEAD_DARWIN],
    ['win32', DEAD_WIN32],
  ]) {
    const v = judgeDeadButton({ ...obs, expectApi: null });
    assert.equal(v.verdict, 'dead', `${name}：判成了 ${v.verdict}`);
  }
});
expect('两条一起抽掉 ⇒ 三夜那两格重新判"活"（= 复现 MUT-BAD 本身）', () => {
  for (const [name, obs] of [
    ['darwin', DEAD_DARWIN],
    ['win32', DEAD_WIN32],
  ]) {
    const v = judgeDeadButton({ ...obs, ambient: null, expectApi: null });
    assert.equal(v.verdict, 'alive', `${name}：判成了 ${v.verdict} —— 没能复现出当年那个假绿`);
  }
});

say('');
say('── ④ 「腿炸了」凑不出「活着」，也凑不出「如期变红」──────────────────────');

expect('死按钮 + 一条未捕获异常 ⇒ 仍然判"死"（异常凑不出"该发生的事"）', () => {
  const v = judgeDeadButton({ ...DEAD_WIN32, newPageErrors: ['boom'] });
  assert.equal(v.verdict, 'dead', `判成了 ${v.verdict}：${v.why}`);
});
expect('活按钮 + 一条未捕获异常 ⇒ 仍然判"活"（异常不改判决，只是多一格证据）', () => {
  const v = judgeDeadButton({ ...ALIVE, newPageErrors: ['boom'] });
  assert.equal(v.verdict, 'alive', `判成了 ${v.verdict}：${v.why}`);
});
expect('①空转：压根没点到（存在=false / 点不动）⇒ "有反应"必须是 false', () => {
  /*
   * `[CI 实测 run 31902320145]` 三个平台**绿的那些轮**里都躺着这一句：
   *   ── 「去安装模型」（asr.goInstall）
   *      存在=false 可见=- 禁用=- 文案=""
   *      点击成功=false
   *      URL 变了=false  DOM 变了=true  /api 请求 1 条
   *      **有反应 = true**
   * 一个不存在、压根没被点过的按钮，被量成了"点下去有反应"。
   */
  const notClicked = {
    clicked: false,
    urlChanged: false,
    domChanged: true,
    apiRequests: [req('GET', '/api/models/sources')],
    newPageErrors: [],
    ambient: null,
  };
  assert.equal(legacyReacted(notClicked), true, '老判据应当把它判成"有反应"（那正是缺陷）');
  assert.equal(judgeReaction(notClicked).reacted, false);
});
expect('页面自己就在发那条 expectApi ⇒ 第三态 undecidable，不许记成通过、也不许记成变红', () => {
  const v = judgeDeadButton({
    ...ALIVE,
    ambient: { domChanged: false, apiRequests: [req('POST', '/api/models/sources/probe')] },
  });
  assert.equal(v.verdict, 'undecidable', `判成了 ${v.verdict}：${v.why}`);
});

say('');
say('── ⑤ 归一化 & 契约漂移守卫 ──────────────────────────────────────────────');

expect('requestKey 砍掉 query（后台轮询每轮 query 不同，带着它对照窗就白测了）', () => {
  assert.equal(
    requestKey(req('GET', '/api/models/catalog?role=all&lang=zh')),
    'GET /api/models/catalog',
  );
  assert.equal(requestKey(req('POST', '/api/models/sources/probe')), PROBE_EFFECT);
});
expect('apiKeys 只留 /api/、去重、保序', () => {
  assert.deepEqual(
    apiKeys([req('GET', '/api/jobs'), 'GET http://x/assets/app.js', req('GET', '/api/jobs')]),
    ['GET /api/jobs'],
  );
});
expect('judgeExpectedEffect：没写明"该发生什么"时是 none，不是 miss（横扫那 40 个按钮）', () => {
  assert.equal(judgeExpectedEffect({ apiRequests: [] }).verdict, 'none');
});

expect('契约漂移：PROBE_EFFECT 必须真的还在 packages/shared/src/api.ts 的 ENDPOINTS 里', () => {
  const src = readFileSync(join(REPO, 'packages', 'shared', 'src', 'api.ts'), 'utf8');
  const [method, path] = PROBE_EFFECT.split(' ');
  const re = new RegExp(
    `\\{\\s*method:\\s*'${method}',\\s*path:\\s*'${path.replace(/\//g, '\\/')}'`,
  );
  assert.ok(
    re.test(src),
    `ENDPOINTS 里找不到 ${PROBE_EFFECT} —— 端点改了而 PROBE_EFFECT 没跟。` +
      '不改的话 B1 会退化成**恒不命中 ⇒ 恒红**，而恒红的门等于没有门。',
  );
});

say('');
say(`── ${cases} 条，失败 ${failures} 条 ──`);
if (failures > 0) {
  say('');
  say('✘ e2e-browser 判据的证伪能力**没有过关**。');
  process.exit(1);
}
say('✔ e2e-browser 判据：真形状会红、健康形状不红、抽掉修法就绿、异常凑不出结论。');
