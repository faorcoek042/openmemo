#!/usr/bin/env node
/**
 * e2e-browser-audit.mjs —— **真浏览器**里点按钮，判据只有一条：
 *
 *   > **点下去要么发生该发生的事，要么给出看得懂的错误 —— 不许没有反应。**
 *
 * ## 为什么必须有这一层（用户 2026-08-08，真机 Windows v0.3.0）
 *
 * > 「点击去安装模型，完全没有任何反应。」
 * > 「测速也没有任何反应。」
 *
 * 我们当时有四条 e2e 腿，**一条都看不见这类问题** —— 因为**它们一次都没有点过界面**。
 * 全部走 HTTP：按钮死了、事件没绑上、前端 JS 抛异常，**API 照样 200、断言照样全绿**。
 *
 * 这是同一形状的第三次：
 *   ① CI 从没执行过启动器      → v0.2.0 双击打不开
 *   ② CI 从没经历过空数据目录  → 组件装不上
 *   ③ **CI 从没点过一下**      → 按钮无反应
 * 三次都是**判据没有对准用户真正会做的动作**。
 *
 * ## 「有反应」怎么判定（这一节是本文件的核心）
 *
 * 不能只看"有没有报错"——**没反应恰恰是不报错的**。所以定义成**可观测的四选一**：
 * 点击之后的 1.5 秒内，至少发生一件：
 *
 *   ① 发出了 `/api/**` 请求      ② 地址栏变了
 *   ③ DOM 变了（结构指纹不同）   ④ 出现了可见的错误/提示文案
 *
 * 四件都没有 = **没反应** = 红。
 *
 * ⚠️ 判定 DOM 是否变化用**结构指纹字符串**（标签名 + testid + 可见文本的哈希），
 * **绝不把 DOM 节点本身传进断言** —— PROTOCOL §8：`assert.equal(domNode, null)`
 * 失败时 `util.inspect` 会顺着 `parentNode`/fiber 展开整棵树，实测涨到 10.5 GB，
 * 表现成"测试文件炸了"而不是"断言红了"。本文件里跨进 Node 的一律是**字符串与布尔**。
 *
 * ## 变异证明：这条断言必须能在"按钮死了"时真的红
 *
 * `--mutate <selector>` 会在页面里给目标按钮挂一个**捕获阶段**的监听器，
 * 调用 `stopImmediatePropagation()` + `preventDefault()` ——
 * 按钮**还在、还可点、样式不变**，但点击**到不了任何处理器**。
 * 这正是"按钮死了"的形状，而且**不改产品源码一个字节**（PROTOCOL §10）。
 * 判据：同一条断言量到它必须**红**。红不了，说明这条腿看不见问题。
 *
 * ## PROTOCOL §11
 *
 *   · 起 daemon 前**先证明端口是空的**（既没人答话、也能被我 bind 住）；
 *   · 收尾**按 pid 收整棵进程树**（Windows `taskkill /T`，POSIX 进程组），不 `pkill -f`；
 *   · 外部命令与页面操作**一律带超时**；
 *   · **「跳过」不许渲染成「成功」**：找不到按钮是**红**（并说清是哪一种找不到）。
 *
 * ## 用法
 *
 *   node scripts/ci/e2e-browser-audit.mjs [--bundle <包目录>] [--port 19980]
 *        [--mutate <testid或文本>] [--keep-open]
 *
 * 退出码：0 = 每个被点的按钮都有反应；1 = 任何一处没反应 / 变异证明没红。
 */
/*
 * ⚠️ `document` / `getComputedStyle` 只出现在 `page.evaluate()` 的回调里 ——
 * 那些函数被序列化后**在浏览器里执行**，不在 Node 里。eslint 按 Node 环境检查这个文件，
 * 所以要在这里显式声明它们，否则会报 no-undef。
 * 刻意**不**整file关掉 no-undef：那会连 Node 侧真正的拼写错误一起放过。
 */
/* global document, getComputedStyle */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const BUNDLE = arg('--bundle', null);
const PORT = Number(arg('--port', '19980'));
const MUTATE = arg('--mutate', null);
const BASE = `http://127.0.0.1:${PORT}`;
const IS_WIN = process.platform === 'win32';

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

/* ── playwright：不进 package.json ────────────────────────────────────────────
 *
 * 刻意**不**把 playwright 加进 `package.json` 的 devDependencies：
 * 那会动 `pnpm-lock.yaml`（共享文件，本轮同时有四路 agent 在这棵树上），
 * 而这条腿完全可以用一个**外部安装**的 playwright 跑。
 * CI 里由 workflow 单独 `npm i -g` 装；本机用 npx 缓存里的那份。
 * 找不到就**红并说清怎么装**，不静默跳过（§11）。
 */
const require_ = createRequire(import.meta.url);
let chromium;
{
  const candidates = ['playwright', 'playwright-core', process.env.PLAYWRIGHT_MODULE ?? ''].filter(
    Boolean,
  );
  let lastErr;
  for (const c of candidates) {
    try {
      ({ chromium } = require_(c));
      say(`   playwright 来自：${c}`);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!chromium) {
    console.error('✘ 找不到 playwright。这条腿需要一个真浏览器，**不能跳过**。');
    console.error(
      '  装法：npm i -g playwright@1.62.1 && npx playwright install --with-deps chromium',
    );
    console.error(
      `  （也可以用 PLAYWRIGHT_MODULE 指一个绝对路径）最后一次错误：${lastErr?.message}`,
    );
    process.exit(2);
  }
}

/* ── 断言框架（全部只吃字符串/布尔，PROTOCOL §8）──────────────────────────── */
const results = [];
let failed = 0;
const brief = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 400 ? `${s.slice(0, 400)}…` : (s ?? '');
};
function ok(cond, msg, got) {
  if (cond !== true) throw new Error(`${msg}${got === undefined ? '' : `（实得：${brief(got)}）`}`);
}
async function check(id, fn) {
  try {
    const detail = await fn();
    results.push({ id, status: 'PASS', detail: detail ?? '' });
    say(`   ✔ ${id}${detail ? `  —— ${detail}` : ''}`);
    return true;
  } catch (e) {
    failed += 1;
    results.push({ id, status: 'FAIL', detail: e.message });
    say(`   ✘ ${id}`);
    say(`     ${e.message}`);
    return false;
  }
}
async function mutation(id, fn) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (threw) {
    results.push({ id, status: 'MUT-OK', detail: threw.message });
    say(`   ✔ [变异] ${id} —— 如期变红：${brief(threw.message)}`);
    return true;
  }
  failed += 1;
  results.push({ id, status: 'MUT-BAD', detail: '变异体没让断言变红' });
  say(`   ✘ [变异] ${id} —— **没有变红**。这条腿看不见"按钮死了"，等于假绿灯。`);
  return false;
}

/* ── §11：端口必须是空的 ─────────────────────────────────────────────────── */
async function assertPortFree(port) {
  let answered = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    answered = true;
    say(`   ✘ 端口 ${port} 上已经有人在应答（HTTP ${r.status}）`);
  } catch {
    /* 空 */
  }
  if (answered) {
    throw new Error(`PORT_IN_USE: ${port} 有残留进程在应答 —— 我的绿灯会追溯不到是谁给的`);
  }
  await new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', (e) => fail(new Error(`PORT_IN_USE: ${port} 占不住（${e.code}）`)));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done()));
  });
  say(`   端口 ${port} 起服务前确认为空 ✔（没人答话，也能被我占住）`);
}

/* ── §11：按 pid 收整棵进程树，绝不 pkill -f ─────────────────────────────── */
function killTree(proc, signal) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (IS_WIN) {
      spawnSync(
        'taskkill',
        ['/PID', String(proc.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
        {
          timeout: 15_000,
          stdio: 'ignore',
        },
      );
    } else {
      process.kill(-proc.pid, signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* 已经死了 */
    }
  }
}

const DAEMON = BUNDLE
  ? join(BUNDLE, 'app', 'daemon', 'dist', 'main.js')
  : join(REPO, 'apps', 'daemon', 'dist', 'main.js');
const NODE_BIN = BUNDLE ? join(BUNDLE, 'runtime', IS_WIN ? 'node.exe' : 'node') : process.execPath;
/*
 * `--web-dist`：本机验证前端改动时用。
 * **PROTOCOL §7**：绝不 `vite build` 覆盖 `apps/web/dist`（`:10000` 的演示实例直接托管它，
 * 覆盖了不会有任何东西报错，用户看到的却已经是别人的半成品）。
 * 所以本机验证一律 `--outDir /tmp/<自己的目录>` 再用这个参数指过来。
 */
const WEB_DIST = arg(
  '--web-dist',
  BUNDLE ? join(BUNDLE, 'app', 'apps', 'web', 'dist') : join(REPO, 'apps', 'web', 'dist'),
);

if (!existsSync(DAEMON)) {
  console.error(`✘ 找不到 daemon 入口：${DAEMON}`);
  process.exit(2);
}
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error(`✘ 找不到网页产物：${WEB_DIST}/index.html —— 缺了它用户看到的就是白页`);
  process.exit(2);
}

/*
 * ★★ **空数据目录**，什么组件都不预装。
 *
 * 这一条不是省事，是判据本身：用户报的两个按钮都在"**还没装东西**"的状态下
 * 才会出现（`AsrModelPicker` 只有在一个 ASR 模型都没装时才渲染「去安装模型」）。
 * 预装好组件再去点，那个分支**根本不会出现** —— 而"CI 从没经历过空数据目录"
 * 正是本轮第二次事故的成因。
 */
const SCRATCH = mkdtempSync(join(tmpdir(), 'om-e2e-browser-'));
const DATA_DIR = join(SCRATCH, 'data');
const POINTER = join(SCRATCH, 'pointer.json');

let daemon = null;
let browser = null;

/** 点击之后要观测的四类反应。 */
const REACTION_WINDOW_MS = 1500;

/**
 * 页面结构指纹：**字符串**，不是节点（§8）。
 *
 * ⚠️ 必须包含 `input` / `textarea` / `select`。`[实测]` 第一版只看
 * button/a/h1/h2/dialog，于是「新建文件夹」点开一个**行内输入框**时指纹一个字都没变，
 * 它被判成"点了没反应" —— 那是**我的指纹太窄**，不是产品坏了。
 * 再加上正文长度与元素总数：文案变化（提示、错误、计数）也算反应。
 *
 * ⚠️ 这是一段**在浏览器里求值的模板字符串**，里面**不能出现反引号** ——
 * 第一版把带反引号的注释写了进来，反引号被当成插值，整个脚本 ReferenceError。
 */
const FINGERPRINT = `(() => {
  const parts = [];
  parts.push('LEN:' + document.body.innerText.length);
  parts.push('CNT:' + document.querySelectorAll('*').length);
  for (const el of document.querySelectorAll('button, a, input, textarea, select, [data-testid], h1, h2, [role="dialog"], [role="alert"], [role="menu"]')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    parts.push(el.tagName + '|' + (el.getAttribute('data-testid') || '') + '|' +
               (el.getAttribute('aria-label') || '') + '|' +
               (el.textContent || '').trim().slice(0, 40) + '|' + (el.disabled ? 'D' : '') +
               '|' + (el.value === undefined ? '' : String(el.value).slice(0, 20)));
  }
  return parts.join('\\n');
})()`;

try {
  hdr('0. 起一个 daemon —— **空数据目录**，什么组件都不预装');
  say(`   数据目录：${DATA_DIR}（全新）`);
  say(`   网页产物：${WEB_DIST}`);
  await assertPortFree(PORT);

  daemon = spawn(NODE_BIN, [DAEMON, '--data-dir', DATA_DIR, '--port', String(PORT)], {
    env: {
      ...process.env,
      OPENMEMO_AUTH: 'none',
      OPENMEMO_DATA_DIR: DATA_DIR,
      OPENMEMO_POINTER_FILE: POINTER, // PROTOCOL §9：绝不写机器级指针
      OPENMEMO_WEB_DIST: WEB_DIST,
      ...(BUNDLE ? { OPENMEMO_EXT_DIR: join(BUNDLE, 'ext') } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(IS_WIN ? {} : { detached: true }),
  });
  const dlogs = [];
  daemon.stdout.on('data', (d) => dlogs.push(String(d)));
  daemon.stderr.on('data', (d) => dlogs.push(String(d)));

  let up = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        up = true;
        say(`   daemon 就绪（${((i + 1) * 0.5).toFixed(1)}s）`);
        break;
      }
    } catch {
      /* 还没起来 */
    }
    if (daemon.exitCode !== null) break;
  }
  if (!up) {
    say(
      dlogs
        .join('')
        .split('\n')
        .slice(-40)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
    throw new Error('daemon 没起来');
  }

  /* ── 浏览器 ─────────────────────────────────────────────────────────────── */
  hdr('1. 打开真浏览器');
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  /*
   * ★ 语言锁成 zh-CN。用户报的是中文界面上的按钮，而 runner 默认是英文 ——
   *   `[实测]` 第一版没锁，页面渲染成 "Measure now"，我按中文文案找按钮当然找不到，
   *   于是报了一个"按钮不存在"的**假缺陷**。判据必须对准用户看到的那一版。
   */
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);

  /** 三样现场：控制台、未捕获异常、网络。 */
  const consoleMsgs = [];
  const pageErrors = [];
  const requests = [];
  const badResponses = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
  page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e).slice(0, 300)));
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  /**
   * 把当前页所有**可见**的按钮/链接列出来（纯字符串，§8）。
   * 先枚举再点 —— 猜选择器猜错时报出来的是"按钮不存在"，那是**假缺陷**，
   * 会把人引去修一个根本不存在的问题。
   */
  async function inventory(page_) {
    return await page_.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (st.display === 'none' || st.visibility === 'hidden' || r.width === 0) continue;
        out.push(
          [
            el.tagName,
            el.getAttribute('data-testid') || '-',
            (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || '(无文案)',
            el.disabled ? 'disabled' : '',
            el.getAttribute('href') || '',
          ].join(' | '),
        );
      }
      return out;
    });
  }

  /** 装一个变异体：让目标按钮"还在但点不动"。**不改产品源码一个字节。** */
  async function installMutation(page_, needle) {
    await page_.evaluate((n) => {
      const all = [...document.querySelectorAll('button, a')];
      const target = all.find(
        (el) => el.getAttribute('data-testid') === n || (el.textContent || '').trim().includes(n),
      );
      if (!target) return false;
      // 捕获阶段拦下：按钮还在、还可点、样式不变，但事件到不了任何处理器。
      target.addEventListener(
        'click',
        (ev) => {
          ev.stopImmediatePropagation();
          ev.preventDefault();
        },
        true,
      );
      return true;
    }, needle);
  }

  /**
   * 点一个按钮，回答**唯一**的问题：有没有反应？
   * 返回一份**纯字符串/布尔**的报告（§8：绝不把节点带出页面）。
   */
  async function clickAndObserve(page_, { name, testid, text, rawSel, expectUrlChange = false }) {
    const sel = rawSel ?? (testid ? `[data-testid="${testid}"]` : null);
    // 先定位。找不到是**红**，而且要说清是"页面上没有"还是"有但不可见/被禁用"。
    const found = await page_.evaluate(
      ({ sel: s, text: t }) => {
        const all = [...document.querySelectorAll('button, a, [role="button"]')];
        const el = s
          ? document.querySelector(s)
          : all.find((x) => (x.textContent || '').trim().includes(t));
        if (!el) return { exists: false };
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          exists: true,
          visible:
            st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0,
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
          label: (el.textContent || '').trim().slice(0, 60),
          tag: el.tagName,
        };
      },
      { sel, text },
    );

    const before = {
      url: page_.url(),
      fp: await page_.evaluate(FINGERPRINT),
      reqCount: requests.length,
      errCount: pageErrors.length,
    };

    let clicked = false;
    let clickError = '';
    if (found.exists && found.visible && !found.disabled) {
      try {
        if (sel) await page_.click(sel, { timeout: 8000 });
        else await page_.getByText(text, { exact: false }).first().click({ timeout: 8000 });
        clicked = true;
      } catch (e) {
        clickError = String(e.message ?? e).slice(0, 200);
      }
    }

    await page_.waitForTimeout(REACTION_WINDOW_MS);

    const after = {
      url: page_.url(),
      fp: await page_.evaluate(FINGERPRINT),
    };
    const newReqs = requests.slice(before.reqCount).filter((r) => r.includes('/api/'));
    const newErrs = pageErrors.slice(before.errCount);

    return {
      name,
      ...found,
      clicked,
      clickError,
      urlChanged: before.url !== after.url,
      domChanged: before.fp !== after.fp,
      apiRequests: newReqs,
      newPageErrors: newErrs,
      expectUrlChange,
      // ★ 「有反应」的定义（四选一）
      reacted:
        before.url !== after.url ||
        before.fp !== after.fp ||
        newReqs.length > 0 ||
        newErrs.length > 0,
    };
  }

  function reportClick(r) {
    say(`   ── ${r.name}`);
    say(
      `      存在=${r.exists} 可见=${r.visible ?? '-'} 禁用=${r.disabled ?? '-'} 文案="${r.label ?? ''}"`,
    );
    say(`      点击成功=${r.clicked}${r.clickError ? ` clickError=${r.clickError}` : ''}`);
    say(
      `      URL 变了=${r.urlChanged}  DOM 变了=${r.domChanged}  /api 请求 ${r.apiRequests.length} 条`,
    );
    for (const q of r.apiRequests.slice(0, 6)) say(`        → ${q}`);
    for (const e of r.newPageErrors.slice(0, 4)) say(`        ✘ 未捕获异常：${e}`);
    say(`      **有反应 = ${r.reacted}**`);
  }

  /* ── 2. 复现用户报的那两个 ─────────────────────────────────────────────── */

  hdr('2. 复现用户报的两个按钮（空数据目录 = 用户当时的状态）');
  await page.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1500);
  say(`   打开 ${BASE}/models`);
  say(`   页面标题：${await page.title()}`);
  say('   ── 这一页上所有可见按钮（先枚举再点，不猜选择器）──');
  for (const b of await inventory(page)) say(`      ${b}`);

  const probeR = await clickAndObserve(page, {
    name: '「立即测速」（models.sources.probe）',
    testid: 'models-sources-probe',
  });
  reportClick(probeR);

  const installR = await clickAndObserve(page, {
    name: '「去安装模型」（asr.goInstall）',
    text: '去安装模型',
    expectUrlChange: true,
  });
  reportClick(installR);

  say('');
  say('   ── 本页控制台（前 12 条）──');
  for (const m of consoleMsgs.slice(0, 12)) say(`      ${m}`);
  say('   ── HTTP >= 400 ──');
  for (const b of badResponses.slice(0, 10)) say(`      ${b}`);
  if (badResponses.length === 0) say('      (没有)');

  await check('B1 「立即测速」点下去有反应', () => {
    ok(probeR.exists === true, '页面上根本没有这个按钮', probeR);
    ok(probeR.visible === true, '按钮存在但不可见', probeR);
    ok(
      probeR.disabled === false,
      '按钮是禁用的 —— 禁用本身不算错，但必须同时告诉用户为什么（这里没有）',
      probeR,
    );
    ok(probeR.clicked === true, `点不动：${probeR.clickError}`);
    ok(probeR.reacted === true, '**点了完全没有反应**：URL 没变、DOM 没变、没发请求、没报错');
    return `api=${probeR.apiRequests.length} domChanged=${probeR.domChanged}`;
  });

  await check('B2 /models 上不许有「去安装模型」这种点了没反应的按钮', () => {
    /*
     * ★ 判据是"**没有死按钮**"，不是"必须有这个按钮"。
     *
     * 用户报的缺陷是：`/models` 上渲染了一个「去安装模型」，而它的动作是
     * `navigate('/models')` —— 导航到你已经在的那一页，什么都不发生。
     * 修法是**在这一页上不渲染它**（改成一句"就在这一页里下载安装"）。
     * 所以两种形态都算通过：**不存在**，或者**存在且点了有反应**；
     * 只有"存在但点了没反应"是那个缺陷本身。
     */
    if (installR.exists !== true) {
      return '按钮已不在 /models 上（改成了说明文案）—— 正是修复后的形态';
    }
    ok(installR.clicked === true, `按钮还在但点不动：${installR.clickError}`);
    ok(
      installR.reacted === true,
      '**「去安装模型」还在 /models 上，而且点了完全没有反应** —— 就是用户报的那个缺陷',
    );
    return `存在且有反应（urlChanged=${installR.urlChanged}）`;
  });

  /* ── 3. 横扫：主要交互路径上的按钮 ─────────────────────────────────────── */

  hdr('3. 横扫同形：主要交互路径上的按钮，逐个点一下');
  /*
   * ★ 横扫改成**自动枚举**：每个页面把所有"可见 + 可点"的按钮列出来，逐个点。
   *   写死一张 testid 清单只能覆盖我想得到的按钮，而用户会点的是**全部**。
   *
   * ⚠️ 两条护栏，缺一不可：
   *   ① **跳过破坏性/重量级的**（删除、卸载、下载、重置、停止…）——
   *      一条会真的删东西或下 574 MB 的审计腿，不会有人愿意跑它。
   *      跳过的**明确记在案**，不混进"通过"里（§11：跳过不许渲染成成功）。
   *   ② **每点一次就回到该页重新枚举** —— 点击可能导航走，
   *      在错的页面上接着点下一个按钮，测的就不是同一件事了。
   */
  const SKIP_WORDS =
    /删除|卸载|下载|移除|清空|重置|恢复出厂|停止|退出|注销|取消|开始录|安装|更新|升级|重启/;
  const SWEEP_PAGES = ['/models', '/runtime', '/settings', '/tasks', '/diagnostics', '/notes'];
  const MAX_PER_PAGE = 8;

  const sweepResults = [];
  const skipped = [];
  for (const path of SWEEP_PAGES) {
    let names = [];
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(1000);
      names = await page.evaluate(
        ({ skipSrc }) => {
          const re = new RegExp(skipSrc);
          const out = [];
          for (const el of document.querySelectorAll('button')) {
            const st = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (st.display === 'none' || st.visibility === 'hidden' || r.width === 0) continue;
            if (el.disabled) continue;
            const label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
            const tid = el.getAttribute('data-testid') || '';
            out.push({ tid, label, skip: re.test(label) });
          }
          return out;
        },
        { skipSrc: SKIP_WORDS.source },
      );
    } catch (e) {
      say(`   ${path}：打不开 —— ${String(e.message).slice(0, 140)}`);
      continue;
    }

    const clickable = names.filter((n) => !n.skip).slice(0, MAX_PER_PAGE);
    for (const n of names.filter((x) => x.skip)) skipped.push(`${path} 「${n.label}」`);
    say(
      `   ${path}：可见按钮 ${names.length} 个，本轮点 ${clickable.length} 个，跳过 ${names.length - clickable.length} 个`,
    );

    for (let i = 0; i < clickable.length; i++) {
      const n = clickable[i];
      try {
        // 每点一次都回到该页重新开始 —— 上一次点击可能已经把我们导航走了
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForTimeout(700);
        /*
         * ★ 按**枚举序号**打标再点，不靠文案。
         *   `[实测]` 第一版用文案定位，而图标按钮**没有文案** —— `getByText('')`
         *   定位不到，于是它们被报成"点了没反应"。那是**我的选择器坏了**，
         *   不是产品坏了。差点因此报出一串假缺陷。
         *   打的是一个惰性属性（不改行为），而且每次导航都会被重置。
         */
        const tagged = await page.evaluate(
          ({ skipSrc, idx }) => {
            const re = new RegExp(skipSrc);
            let k = 0;
            for (const el of document.querySelectorAll('button')) {
              const st = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              if (st.display === 'none' || st.visibility === 'hidden' || r.width === 0) continue;
              if (el.disabled) continue;
              const label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
              const aria = el.getAttribute('aria-label') || '';
              const title = el.getAttribute('title') || '';
              if (re.test(label + ' ' + aria + ' ' + title)) continue;
              if (k === idx) {
                el.setAttribute('data-sweep-idx', String(idx));
                return true;
              }
              k += 1;
            }
            return false;
          },
          { skipSrc: SKIP_WORDS.source, idx: i },
        );
        if (!tagged) {
          say(
            `   ── ${path} #${i}「${n.label || n.aria || '(图标按钮)'}」：这一轮枚举不到它了，跳过`,
          );
          continue;
        }
        const r = await clickAndObserve(page, {
          name: `${path} #${i}「${n.label || n.aria || '(图标按钮)'}」`,
          rawSel: `[data-sweep-idx="${i}"]`,
        });
        sweepResults.push(r);
        if (r.reacted !== true) reportClick(r);
      } catch (e) {
        say(`   ── ${path} #${i}：点击时出错 ${String(e.message).slice(0, 120)}`);
      }
    }
  }

  say('');
  say(`   ── 跳过的破坏性/重量级按钮（${skipped.length} 个，明确记在案，不算通过）──`);
  for (const sk of skipped.slice(0, 20)) say(`      ${sk}`);

  /*
   * ★ 已知**未修**的死按钮，逐条记名。
   *
   * 为什么不从横扫里删掉：删掉就再也没人看见了。
   * 为什么不让整条腿一直红：一个**永远红**的门禁等于没有门禁 ——
   * 它训练所有人忽略这盏灯（本仓已经吃过这个亏）。
   * 折中是**钉住集合本身**：出现清单之外的死按钮 → 红；
   * 清单里的某条被修好了 → 也红（提醒把它划掉），清单不会烂在这儿。
   */
  const KNOWN_DEAD = [
    /*
     * 空了 —— 「复制诊断信息」已修（Manager 2026-08-08 裁决"成功必须出声"）：
     * 点完出现「已复制」，失败时出现「复制失败」并把全文摊出来给退路。
     * 把它留在清单里会让 B3 一直红（清单里的条目被修好也要红，
     * 提醒把它划掉）—— 这条机制刚刚**真的**发挥了作用：修完之后 B3 当场红，
     * 逼我回来更新清单，而不是让一条过期的"已知缺陷"烂在这儿。
     */
  ];

  await check('B3 横扫：不许出现**清单之外**的死按钮', () => {
    const dead = sweepResults.filter(
      (r) =>
        r.exists === true &&
        r.visible === true &&
        r.disabled === false &&
        r.clicked === true &&
        r.reacted === false,
    );
    const unexpected = dead.filter(
      (d) => !KNOWN_DEAD.some((k) => String(d.label ?? '').includes(k)),
    );
    const stillKnown = KNOWN_DEAD.filter((k) =>
      dead.some((d) => String(d.label ?? '').includes(k)),
    );
    const probed = sweepResults.filter((r) => r.clicked === true).length;

    ok(probed > 0, '一个按钮都没点到 —— 这一节等于没跑（§11：跳过不许渲染成成功）');
    ok(
      unexpected.length === 0,
      `出现了清单之外的死按钮 ${unexpected.length} 个：` +
        unexpected.map((d) => `${d.name}（文案「${d.label ?? ''}」）`).join('、'),
    );
    ok(
      stillKnown.length === KNOWN_DEAD.length,
      `已知清单 ${KNOWN_DEAD.length} 条，本轮只复现到 ${stillKnown.length} 条 —— ` +
        '修好了就把它从 KNOWN_DEAD 里划掉（清单不许烂在这儿）',
    );
    return `点了 ${probed} 个；死按钮 ${dead.length} 个，全部在已知清单里`;
  });

  /*
   * ── B5：**测速失败时，用户看得懂吗** ──────────────────────────────────────
   *
   * 用户第二条报告是「测速也没有任何反应」，而在 Linux + 本地 daemon 上它是**有**反应的
   * （POST /api/models/sources/probe，DOM 变了）。所以"没反应"多半不是按钮死了，
   * 而是**那次请求失败了、而失败没有被显示出来**。
   *
   * `SourcesSection.tsx` 的写法是 `onClick={() => void probe.mutateAsync()}` ——
   * `void` 把 Promise 的拒绝**吞掉**。请求一失败，按钮转一下就回到原样，
   * 界面上**不留任何痕迹**：这在用户那里与"按钮是死的"**完全一样**。
   *
   * 这里用路由拦截把那个端点变成 500（**不改产品源码一个字节**），
   * 再问一句：界面上出现"看得懂的错误"了吗？
   */
  // 注入故障**之前**的异常快照 —— B4 只对这一段负责（见那条断言里的说明）
  const normalPhaseErrors = pageErrors.slice();

  hdr('2b. 测速**失败时**，用户看得懂吗（用户第二条报告的可能成因）');
  await page.route('**/api/models/sources/probe', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'PROBE_FAILED', message: 'boom', messageZh: '测速失败（本轮人为注入）' },
      }),
    }),
  );
  await page.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1200);
  const beforeErrText = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, ' ').slice(0, 4000),
  );
  const probeFailR = await clickAndObserve(page, {
    name: '「立即测速」（端点被注入 500）',
    testid: 'models-sources-probe',
  });
  reportClick(probeFailR);
  const afterErrText = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, ' ').slice(0, 4000),
  );
  const gainedText = afterErrText.length > beforeErrText.length || afterErrText !== beforeErrText;
  const looksLikeError = /失败|错误|重试|无法|error|failed/i.test(
    afterErrText.replace(beforeErrText, ''),
  );
  say(`   正文变了=${gainedText}  新增文字里像错误提示=${looksLikeError}`);
  await page.unroute('**/api/models/sources/probe');

  await check('B5 测速失败时，界面上必须出现看得懂的错误（不许静默吞掉）', () => {
    ok(probeFailR.clicked === true, '按钮没点到，这条无从谈起');
    ok(
      looksLikeError === true,
      '端点回了 500，而界面上没有出现任何错误提示 —— ' +
        '`void probe.mutateAsync()` 把 Promise 拒绝吞掉了。' +
        '在用户那里这与"按钮是死的"完全一样。',
    );
    return '有可见的错误提示';
  });

  /*
   * ⚠️ 只看**注入故障之前**那一段。第 2b 节我自己往端点里塞了 500，
   *   由此产生的未捕获拒绝是**我造的**，把它算进产品的账上就是一条假缺陷。
   *   （第一版没分段，B4 当场被自己的注入弄红了。）
   */
  await check('B4 正常路径上没有未捕获的前端异常', () => {
    ok(
      normalPhaseErrors.length === 0,
      `有 ${normalPhaseErrors.length} 条未捕获异常（前端抛了异常，界面可能已经半死）`,
      normalPhaseErrors.slice(0, 5),
    );
    return '0 条';
  });

  /* ── 3b. ★ 第二种死法：点到了、请求发了、失败了，**然后没人说话** ────────────
   *
   * 我原有的变异（捕获阶段监听器）只证明得了"点击到不了 handler"。
   * 但用户报的「点安装没反应」有**第二个源头**，形状完全不同：
   * 请求真的发出去、服务端回了错，而 `void mutateAsync()` 把 rejection 吞掉 ——
   * 界面一个字都不说。**在用户眼里这两种一模一样，而我此前只看得见第一种。**
   *
   * ⚠️ 这条断言第一版是**红的，而且红错了原因**，值得记：
   *   · 我用 `getByText('安装')` 定位，`.first()` 命中的是一个**被禁用**的按钮
   *     （`/runtime` 上有 20+ 个「安装 …」按钮，大多数在空数据目录下不可点）；
   *   · 路由用通配前缀去拦 `/api/backends/install`，**把 `/api/backends/installed`
   *     那个 GET 也一起拦了**，于是"看到错误"可能来自列表查询失败而不是安装失败。
   *   两个都是**我的测量错**，不是产品的问题。`[实测]` 修正之后：
   *   恰好 1 条 `POST /api/backends/install` 被拦，页面上出现「本轮人为注入的失败」。
   */
  hdr('3b. ★ 请求失败时界面必须说话（第二种"没反应"）');

  const FAIL_WORDS = /失败|错误|重试|无法|不可用|出错|error|failed|retry/i;

  await page.route(
    (u) => {
      try {
        return new URL(u).pathname === '/api/backends/install';
      } catch {
        return false;
      }
    },
    (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INJECTED', message: 'boom', messageZh: '本轮人为注入的失败' },
        }),
      }),
  );
  await page.goto(`${BASE}/runtime`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1800);

  const beforeInstall = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  // 挑第一个**没有被禁用**、文案以「安装 」开头的按钮，并打标再点（不靠 getByText）
  const targetLabel = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (e) => !e.disabled && /^安装\s/.test((e.textContent || '').trim()),
    );
    if (!b) return null;
    b.setAttribute('data-b6', '1');
    return (b.textContent || '').trim();
  });
  let installClicked = false;
  if (targetLabel) {
    try {
      await page.click('[data-b6="1"]', { timeout: 8000 });
      installClicked = true;
    } catch {
      /* 下面按未点到处理 */
    }
    await page.waitForTimeout(2500);
  }
  const afterInstall = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const installAdded = afterInstall.replace(beforeInstall, '');
  await page.unroute((u) => {
    try {
      return new URL(u).pathname === '/api/backends/install';
    } catch {
      return false;
    }
  });
  say(`   目标按钮：${targetLabel ?? '(没找到可点的安装按钮)'}`);
  say(`   注入 500 后新增文字里像错误提示 = ${FAIL_WORDS.test(installAdded)}`);

  await check('B6 ★ 安装失败时界面必须出现读得懂的话（不许静默吞掉）', () => {
    ok(
      targetLabel !== null,
      '/runtime 上没有一个可点的「安装」按钮 —— 先确认目录不是空的（本轮 catalog 有 25 个包）',
    );
    ok(installClicked === true, '按钮点不动');
    ok(
      FAIL_WORDS.test(installAdded) === true,
      '端点回了 500，而界面上一个字都没说 —— `void mutateAsync()` 把 rejection 吞掉了；' +
        '这在用户眼里与"按钮是死的"完全一样',
      installAdded.slice(0, 200),
    );
    return `点了「${targetLabel}」，界面说了话`;
  });

  /*
   * 变异：把**同一个谓词**拿去量"没注入故障"的那一轮 —— 那时界面本来就不该冒出错误话。
   * 它必须红，才证明 B6 量的是"失败时说话"，而不是"页面上随便有点字"。
   */
  await mutation('B6 的证伪能力（没注入故障那轮不该有错误话，同一谓词必须红）', async () => {
    await page.goto(`${BASE}/runtime`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1500);
    const base0 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    await page.waitForTimeout(1200);
    const base1 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    ok(
      FAIL_WORDS.test(base1.replace(base0, '')) === true,
      '没注入故障时界面本来就没有错误话（这条变异本就该红）',
    );
  });

  /* ── 3c. 「复制诊断信息」：成功要出声，失败也要出声 ────────────────────────── */
  hdr('3c. 「复制诊断信息」点完必须出声（Manager 裁决：成功必须出声）');
  await page.goto(`${BASE}/diagnostics`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1200);
  const copyR = await clickAndObserve(page, { name: '「复制诊断信息」', text: '复制诊断信息' });
  const copyFeedback = await page.evaluate(() => ({
    ok: !!document.querySelector('[data-testid="diagnostics-copy-ok"]'),
    failed: !!document.querySelector('[data-testid="diagnostics-copy-failed"]'),
    fallback: !!document.querySelector('[data-testid="diagnostics-copy-fallback"]'),
  }));
  say(`   反馈：成功=${copyFeedback.ok} 失败=${copyFeedback.failed} 退路=${copyFeedback.fallback}`);

  await check('B7 ★ 「复制诊断信息」点完必须出声（成功或失败都算，沉默不算）', () => {
    ok(copyR.clicked === true, `按钮没点到：${copyR.clickError}`);
    ok(
      copyFeedback.ok === true || copyFeedback.failed === true,
      '点完既没有"已复制"也没有"复制失败" —— 用户没法判断是成功了还是又一个死按钮',
    );
    // 失败时必须同时给退路，否则用户拿不到那段文本
    if (copyFeedback.failed === true) {
      ok(copyFeedback.fallback === true, '说了失败却没给退路 —— 用户还是拿不到诊断信息');
    }
    return copyFeedback.ok ? '出现「已复制」' : '出现「复制失败」+ 全文退路';
  });

  // 变异：把反馈元素摘掉，同一条断言必须红 —— 证明它量的是"有没有出声"。
  await mutation('B7 的证伪能力（把反馈元素摘掉，同一条断言必须红）', async () => {
    await page.evaluate(() => {
      for (const sel of [
        '[data-testid="diagnostics-copy-ok"]',
        '[data-testid="diagnostics-copy-failed"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) el.remove();
      }
    });
    const after = await page.evaluate(() => ({
      ok: !!document.querySelector('[data-testid="diagnostics-copy-ok"]'),
      failed: !!document.querySelector('[data-testid="diagnostics-copy-failed"]'),
    }));
    ok(
      after.ok === true || after.failed === true,
      '点完既没有"已复制"也没有"复制失败"（这条变异本就该红）',
    );
  });

  /* ── 4. 变异证明：把按钮弄"死"，同一条断言必须红 ───────────────────────── */

  hdr('4. ★ 变异证明：让按钮"还在但点不动"，同一条断言必须红');
  say('   做法：给目标按钮挂一个**捕获阶段**监听器，stopImmediatePropagation + preventDefault。');
  say('   按钮还在、还可见、还可点、样式不变 —— 但点击到不了任何处理器。');
  say('   **产品源码一个字节都没改**（PROTOCOL §10）。');

  await page.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1200);
  await installMutation(page, 'models-sources-probe');
  const mutR = await clickAndObserve(page, {
    name: '「立即测速」（已被变异成死按钮）',
    testid: 'models-sources-probe',
  });
  reportClick(mutR);

  await mutation('B1 的证伪能力（按钮死了时，同一条断言必须红）', () => {
    ok(mutR.exists === true, '页面上根本没有这个按钮');
    ok(mutR.visible === true, '按钮存在但不可见');
    ok(mutR.clicked === true, `点不动：${mutR.clickError}`);
    ok(mutR.reacted === true, '**点了完全没有反应**：URL 没变、DOM 没变、没发请求、没报错');
  });

  if (MUTATE) {
    hdr(`4b. 额外变异：--mutate ${MUTATE}`);
    await page.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1000);
    await installMutation(page, MUTATE);
    const r = await clickAndObserve(page, { name: `自定义变异 ${MUTATE}`, text: MUTATE });
    reportClick(r);
  }
} catch (e) {
  failed += 1;
  say('');
  say(`✘ 审计中断：${e.message}`);
  say(
    String(e.stack ?? '')
      .split('\n')
      .slice(1, 5)
      .join('\n'),
  );
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* 已经关了 */
    }
  }
  killTree(daemon, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  killTree(daemon, 'SIGKILL');
  rmSync(SCRATCH, { recursive: true, force: true });
}

hdr('汇总');
for (const r of results) say(`   ${String(r.id).padEnd(58)} ${r.status}`);
say('');
const pass = results.filter((r) => r.status === 'PASS').length;
const mut = results.filter((r) => r.status === 'MUT-OK').length;
say(`   断言通过 ${pass} 条 · 变异证明 ${mut} 条 · 失败 ${failed} 条`);
say('');
say('   ⚠️ 无头浏览器**做不到**的（如实列出，不假装覆盖）：');
say('     · 系统级权限弹窗（麦克风授权）—— headless 里被自动允许/拒绝，测不出真实体验');
say('     · 真实的文件选择对话框、拖拽外部文件');
say('     · 操作系统的通知、托盘、外部程序打开（双击启动器）');
say('     · GPU/驱动相关的真实渲染差异');
process.exit(failed > 0 ? 1 : 0);
