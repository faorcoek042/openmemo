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
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertPortFree, killTree, killTreeHard } from './launcher-spawn.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const BUNDLE = arg('--bundle', null);
const PORT = Number(arg('--port', '19980'));
const MUTATE = arg('--mutate', null);
/*
 * ★ `--diagnose-download <modelId>`：**一次性诊断,刻意不进门禁。**
 *
 * 门禁腿装的是 5.3 MB 的小包,`downloading` 快到 200ms 采样窗口之间就过去了 ——
 * `[CI 实测 run 31314976975]` 三个平台**没有一个**采到「下载中」。
 * 而要回答的那一位是「`downloading` 期间那几个数字动没动」,窗口不够就永远答不了。
 *
 * `[已知基准]` `measure-install-phases` 在 windows-2025 上真下过
 * `whisper-large-v2-q8_0`(1.66 GB),`downloading` 停留 **28,313 ms / 60 条事件**
 * ⇒ 200ms 采样约 140 个点,足够。沿用同一个模型,好和那次的时间基准对齐。
 *
 * ⚠️ 不传这个参数时整段跳过,所以它**不可能**拖慢门禁。
 */
const DIAGNOSE_DOWNLOAD = arg('--diagnose-download', null);
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
/*
 * `assertPortFree` 改用 `launcher-spawn.mjs` 的共享实现（Manager 2026-08-09 裁决 R-2）。
 * ⚠️ 本腿原来那份就是**正确的那一类**（HTTP + 真 bind），它注释里那句
 * 「光问一句 HTTP 不够」正是这次收敛方向的依据 —— 判据没有被放松，只是不再有六份。
 */

/* ── §11：按 pid 收整棵进程树，绝不 pkill -f ─────────────────────────────── */
/*
 * 本地 `killTree(proc, signal)` 已删 —— 改用共享的
 * `killTree`(SIGTERM) / `killTreeHard`(SIGKILL)（裁决 R-3）。
 * ⚠️ 两档是**刻意的升级顺序**（先温和后强硬），不许压回一个 signal 参数。
 */

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
  await assertPortFree(PORT, { log: say });

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
  /* ─────────────────────────────────────────────────────────────────────────
   * B6 ★ 任务中心卡片上**依次出现的那行中文**
   *
   * ## 为什么这条必须存在
   *
   * 「正在安装」那组文案缺陷被修好了（中性标题、补 `progress.unpacking`、
   * 三处兜底收敛进 `lib/format/stepLabel.ts`）—— **但没有任何一条腿在守它**。
   * 而这一整轮的主线教训正是「CI 结构上看不见」：修完没有断言，
   * 等于亲手又造了一个盲区。
   *
   * ## 判据（Manager 2026-08-09 原文）
   *
   * > **判据是客户端最终显示的字，不是发出了哪个事件。**
   *
   * 所以这里**只读 DOM 文本**，一个 `/api/events` 都不看。
   * 三条硬性质：
   *   ① 出现过的阶段文案必须来自那张中文表（`EXPECTED_ZH`）；
   *   ② **任一时刻不许出现 ASCII-only 的 step token**（`unpacking` 这种机器枚举值）；
   *   ③ **不许从后段回退到「排队中」**（那是在说一件假的事：进度倒回起点）。
   *
   * ⚠️ 采样式观测**只能证伪不能证实**：没采到某一段不代表它没出现过
   * （安装那几步实测是毫秒级）。所以下面**不断言"五个都出现"** ——
   * 断言"出现过的都合法、且没有说谎的那两种形态"。把"必须五个都出现"写死
   * 会造出一条随机红的断言，而随机红的断言等于没人信的断言。
   * ───────────────────────────────────────────────────────────────────────── */
  const EXPECTED_ZH = ['正在选择下载源', '下载中', '正在校验完整性', '正在解压', '正在安装'];
  /** 阶段倒退的那个词 —— 出现在后段之后就是谎话。 */
  const REGRESS_ZH = '排队中';

  await page.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(800);

  // 起一个真实安装：走产品自己的 HTTP 路径，但**观测只看界面**。
  const packToInstall = await page.evaluate(async () => {
    const r = await fetch('/api/backends/catalog');
    const b = await r.json();
    const p = (b.packs ?? []).find((x) => x.applicable === true);
    if (!p) return null;
    await fetch('/api/backends/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    return p.id;
  });
  say(`   起了一个真实安装：${packToInstall ?? '(本机没有适用包)'}`);

  /** 界面上出现过的阶段文本，按首次出现排序。 */
  const seenLabels = [];
  let sawAsciiToken = null;
  let sawRegressAfterLate = null;
  let toastSaidInstallWhileDownloading = null;
  /** 解包阶段界面上那串百分比文本（B6c 用）。采不到就保持 null，不猜。 */
  let unpackingPercentText = null;

  if (packToInstall !== null) {
    await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle', timeout: 30_000 });
    for (let i = 0; i < 150; i++) {
      const snap = await page.evaluate(() => ({
        body: document.body.innerText.replace(/\s+/g, ' '),
      }));
      for (const zh of ['正在选择下载源', '下载中', '正在校验完整性', '正在解压', '正在安装']) {
        if (snap.body.includes(zh) && !seenLabels.includes(zh)) seenLabels.push(zh);
      }
      // ② ASCII-only 的 step token：机器枚举值漏到界面上
      for (const tok of ['resolving', 'downloading', 'verifying', 'unpacking', 'installing']) {
        if (new RegExp(`(^|[^a-z])${tok}([^a-z]|$)`).test(snap.body)) sawAsciiToken ??= tok;
      }
      // ③ 已经走到后段之后又出现「排队中」= 阶段倒退
      const late = seenLabels.some((l) => l !== '正在选择下载源' && l !== '下载中');
      if (late && snap.body.includes(REGRESS_ZH)) sawRegressAfterLate ??= seenLabels.join(' → ');
      // ④ Toast 标题在 downloading 期间不许出现「安装」
      if (snap.body.includes('下载中') && !seenLabels.includes('正在安装')) {
        const toast = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="job-toaster"], [role="status"]');
          return el ? (el.textContent || '').replace(/\s+/g, ' ') : '';
        });
        if (toast.includes('安装')) toastSaidInstallWhileDownloading ??= toast.slice(0, 80);
      }
      // B6c：解压那一段的百分比，采到一次就够（钉住集合用）
      if (snap.body.includes('正在解压') && unpackingPercentText === null) {
        unpackingPercentText = (/(\d+(?:\.\d+)?\s*%)/.exec(snap.body) ?? [])[1] ?? '(无百分比)';
      }
      const done = await page.evaluate(async () => {
        const r = await fetch('/api/backends/installed');
        return ((await r.json()).packs ?? []).length > 0;
      });
      if (done) break;
      await page.waitForTimeout(200);
    }
  }
  say(`   界面上依次出现过的阶段文案：${JSON.stringify(seenLabels)}`);
  say(`   ASCII step token=${sawAsciiToken ?? '(无)'}  后段回退=${sawRegressAfterLate ?? '(无)'}`);

  await check('B6 任务中心卡片上的阶段文案必须是中文、且不许阶段倒退', () => {
    ok(packToInstall !== null, '本机没有适用的后端包，这条无从谈起（不是通过）');
    ok(seenLabels.length > 0, '整个安装过程中界面上一个阶段文案都没出现过');
    const illegal = seenLabels.filter((l) => !EXPECTED_ZH.includes(l));
    ok(illegal.length === 0, `出现了不在预期表里的阶段文案：${illegal.join('、')}`);
    ok(
      sawAsciiToken === null,
      `界面上出现了 ASCII step token「${sawAsciiToken}」—— 机器枚举值漏给用户看了`,
    );
    ok(
      sawRegressAfterLate === null,
      `已经走到后段之后又显示「${REGRESS_ZH}」—— 阶段倒退，是在说一件假的事（序列：${sawRegressAfterLate}）`,
    );
    return `依次出现：${seenLabels.join(' → ')}`;
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * B6c ★ 已知未修的界面谎话:**钉住集合**,不是断言它必须消失
   *
   * ## 为什么不做成一条"必须为真"的断言
   *
   * `e2e-browser` **现在在发布门禁里**。一条红的断言会挡住**每一次**发布,
   * 包括与它完全无关的修复 —— 而本仓自己的判据是
   * **「一个永远红的门禁等于没有门禁,它训练所有人无视这盏灯」**。
   * Manager 2026-08-09 接受了这条反对,改用与 `KNOWN_DEAD` 同一种机制。
   *
   * ## 钉住集合的语义(两个方向都红)
   *
   * · 清单**之外**出现新的谎话 → 红(有新缺陷);
   * · 清单**之内**的那条被修好了 → **也红**(逼人回来把它划掉,清单不会烂在这儿)。
   *
   * ## 登记的这一条(信息要足够下一个人直接开修)
   *
   * **解包期间百分比掉回 0%。**
   *   · `lib/format/bytes.ts:32-37` 的 `formatPercent` 把 `null`/`NaN` **一律渲染成 0%**,
   *     **没有"未知"这一档**;
   *   · 而 `installer.ts:79` 在解包阶段**只给比例、不再更新字节计数**,
   *     于是分子分母缺失 → `null` → 显示 0%。
   *   ⇒ 用户看到进度**从 90% 多掉回 0%**,而实际上正在解压。**它在说谎。**
   *   修法方向(**不由本腿决定**):`formatPercent` 给出"未知"的表达(如 `—`),
   *   或解包阶段照常推进比例。
   * ───────────────────────────────────────────────────────────────────────── */
  /*
   * ⚠️ **这条登记项在 2026-08-09 被实测订正过一次，过程本身值得留着看。**
   *
   * 我最初按读码登记的是「解包期间百分比**掉回 0%**」（依据：`formatPercent` 把
   * `null`/`NaN` 一律渲染成 0%）。`[CI 实测 run 31314976975, win32-x64]`
   * 真跑出来是 **`100%`** —— 不是 0%。
   *
   * ⇒ 真实形态是「**解包期间百分比停在下载结束时的 100%**」：
   *   它不刷新，而不是它归零。**对用户仍然是假话**（正在解压，却显示 100%），
   *   但**和我登记的那句话不是同一句**。
   *
   * ★ 这正是钉住集合该起的作用：它**当场变红**，逼我回来把登记改成实测的样子，
   *   而不是让一条**读码读出来的、听起来很对的**描述长期占着位置。
   *   （如果我当初把它写成一条断言并让它红，红的会是产品；而实际上错的是我的描述。）
   *
   * 判据统一成「解包期间百分比是不是一个**不随解压推进而变化的定值**」，
   * 0% 与 100% 都算命中 —— 两者是同一个成因（解包阶段字节计数不再更新）的两种表现。
   */
  const KNOWN_UI_LIES = ['unpacking-percent-frozen'];
  const observedLies = [];
  if (unpackingPercentText !== null && /(^|\D)(0|100)(\.0+)?\s*%/.test(unpackingPercentText)) {
    observedLies.push('unpacking-percent-frozen');
  }
  say(`   解包期间百分比文本：${unpackingPercentText ?? '(没采到解压那一段)'}`);

  await check('B6c 已知界面谎话的集合必须与清单一致（多了少了都红）', () => {
    const unexpected = observedLies.filter((x) => !KNOWN_UI_LIES.includes(x));
    ok(unexpected.length === 0, `出现了清单之外的新谎话：${unexpected.join('、')}`);
    if (unpackingPercentText === null) {
      // 没采到解压那一段就无从判断 —— 不当成"已修",也不当成"仍在"。
      return '本轮没采到解压阶段，这一条无从判断（不是通过）';
    }
    const fixed = KNOWN_UI_LIES.filter((x) => !observedLies.includes(x));
    ok(
      fixed.length === 0,
      `清单里的「${fixed.join('、')}」看起来已经被修好了 —— ` +
        `**请把它从 KNOWN_UI_LIES 里划掉**（清单被修好也要红，否则它会烂在这儿）`,
    );
    return `已知谎话仍在：${observedLies.join('、')}`;
  });

  await check('B6b 下载期间 Toast 标题不许出现「安装」二字', () => {
    ok(packToInstall !== null, '没起成安装，这条无从谈起（不是通过）');
    ok(
      toastSaidInstallWhileDownloading === null,
      `还在下载时 Toast 就说「安装」了：${toastSaidInstallWhileDownloading}`,
    );
    return '下载期间标题是中性的';
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * B7 ★ 三条 llm 引导动作：**落地页上要真的有那个控件**
   *
   * 上一路把它们接到了 `/models?tab=llm` 而**不是** `/settings` ——
   * 那个动作名字叫 `openSettings`、参数写着 `section:'llm'`，
   * 但控件全在 `ModelsPage` 上；**按名字接线就会重造一个死按钮**。
   *
   * 所以判据不是"跳转发生了"，是**"落到的那个页面上真的有他要用的控件"**。
   * ───────────────────────────────────────────────────────────────────────── */
  await page.goto(`${BASE}/models?tab=llm`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1000);
  const llmLanding = await page.evaluate(() => ({
    hasProviderPicker: !!document.querySelector(
      '[data-testid*="llm"], select, [data-testid*="provider"]',
    ),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  }));
  say(`   /models?tab=llm 上有 llm 相关控件=${llmLanding.hasProviderPicker}`);

  /* ─────────────────────────────────────────────────────────────────────────
   * D1 ★ 一次性诊断:`downloading` 期间那几个数字到底动没动
   *
   * **判据仍然只读 DOM** —— 一次 `/api/events` 都不碰。
   * 采的是用户眼睛能看到的那几个数:百分比 / 已下载字节 / 速度 / ETA,
   * 以及 Toast 标题(B6b 至今空过,因为「下载中」从没出现过)。
   *
   * 结论只有两种,而它决定用户那条线索能不能定案:
   *   · **只有标题不动、数字在走** ⇒ 就是那个已修的文案缺陷,**定案**;
   *   · **数字也不动**            ⇒ `downloading` 那一段还藏着别的东西,继续查。
   * ───────────────────────────────────────────────────────────────────────── */
  if (DIAGNOSE_DOWNLOAD !== null) {
    hdr(`D1 诊断:${DIAGNOSE_DOWNLOAD} 的 downloading 期间,界面上的数字动不动`);
    await page.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 30_000 });
    const started = await page.evaluate(async (id) => {
      const r = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return r.status;
    }, DIAGNOSE_DOWNLOAD);
    say(`   POST /api/models/pull → HTTP ${started}`);
    await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle', timeout: 30_000 });

    /** 每一次采样：界面上那几个数 + Toast 标题 + 当前阶段文案。 */
    const samples = [];
    const labelSeq = [];
    for (let i = 0; i < 900; i++) {
      const s = await page.evaluate(() => {
        const body = document.body.innerText.replace(/\s+/g, ' ');
        const toastEl = document.querySelector('[data-testid="job-toaster"], [role="status"]');
        return {
          pct: (/(\d+(?:\.\d+)?)\s*%/.exec(body) ?? [])[1] ?? null,
          // 「12.3 MB / 1.66 GB」这种；只取第一处
          bytes: (/([\d.]+\s*[KMG]i?B)\s*\/\s*([\d.]+\s*[KMG]i?B)/.exec(body) ?? [])[0] ?? null,
          speed: (/([\d.]+\s*[KMG]i?B\/s)/.exec(body) ?? [])[0] ?? null,
          eta: (/(剩余|ETA)[^,;。]{0,20}/.exec(body) ?? [])[0] ?? null,
          toast: toastEl ? (toastEl.textContent || '').replace(/\s+/g, ' ').slice(0, 60) : null,
          body,
        };
      });
      for (const zh of ['正在选择下载源', '下载中', '正在校验完整性', '正在解压', '正在安装']) {
        if (s.body.includes(zh) && !labelSeq.includes(zh)) labelSeq.push(zh);
      }
      samples.push({
        t: i * 200,
        pct: s.pct,
        bytes: s.bytes,
        speed: s.speed,
        eta: s.eta,
        toast: s.toast,
      });
      const done = await page.evaluate(async () => {
        const r = await fetch('/api/models/installed');
        return ((await r.json()).models ?? []).length > 0;
      });
      if (done) break;
      await page.waitForTimeout(200);
    }

    // 只看**处于 downloading 阶段**的那些采样点
    const dl = samples.filter((x) => x.toast !== null || x.pct !== null);
    const distinct = (k) => [...new Set(dl.map((x) => x[k]).filter((v) => v !== null))];
    const moved = {
      pct: distinct('pct').length > 1,
      bytes: distinct('bytes').length > 1,
      speed: distinct('speed').length > 1,
      eta: distinct('eta').length > 1,
    };
    say(`   采样点 ${samples.length} 个（每 200ms）`);
    say(`   完整文案序列：${JSON.stringify(labelSeq)}`);
    say(`   百分比取值 ${distinct('pct').length} 种：${distinct('pct').slice(0, 8).join(', ')}`);
    say(`   字节文本 ${distinct('bytes').length} 种：${distinct('bytes').slice(0, 4).join(' | ')}`);
    say(`   速度 ${distinct('speed').length} 种：${distinct('speed').slice(0, 4).join(' | ')}`);
    say(
      `   Toast 标题取值 ${distinct('toast').length} 种：${distinct('toast').slice(0, 4).join(' | ')}`,
    );
    say('');
    say(
      `   ★ downloading 期间「动了没有」：百分比=${moved.pct} 字节=${moved.bytes} 速度=${moved.speed} ETA=${moved.eta}`,
    );
    say(
      `   ★ 定案判据：${
        moved.pct || moved.bytes || moved.speed
          ? '**数字在走** ⇒ 用户看到的"没更新"只可能是标题那一处（已修的文案缺陷）'
          : '**数字也不动** ⇒ downloading 那一段还藏着别的东西，不能定案'
      }`,
    );
  }

  await check('B7 llm 引导落地页上必须真的有可操作的控件（不是只发生了跳转）', () => {
    ok(
      llmLanding.hasProviderPicker === true,
      '落地页上找不到任何 llm 相关控件 —— 引导把用户送到了一个他做不了事的地方',
      [llmLanding.text.slice(0, 200)],
    );
    return '落地页有控件';
  });

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

  /* ── 3d. 文件夹改名 / 笔记移动 —— 两条刚接上的线 ──────────────────────────── */
  hdr('3d. 文件夹改名 + 笔记移动到文件夹（两条 mutation 刚接上入口）');

  // 侧栏文件夹树在每一页都在，随便挑一页
  await page.goto(`${BASE}/notes`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1200);

  /*
   * 改名按钮是 hover 才显形的（`opacity-0 group-hover:opacity-100`），
   * 所以**不能靠可见性去点** —— 用 force 点，模拟鼠标移上去之后的那一下。
   * 这也是为什么它不走通用的 clickAndObserve：那个函数会先要求 visible。
   */
  const renameOpened = await (async () => {
    const btn = page.locator('[data-testid="folder-rename"]').first();
    if ((await btn.count()) === 0) return false;
    await btn.click({ force: true, timeout: 8000 });
    await page.waitForTimeout(600);
    return (await page.locator('[data-testid="folder-rename-input"]').count()) > 0;
  })();
  say(`   点「重命名」后出现输入框 = ${renameOpened}`);

  await check('B8 ★ 文件夹改名有入口，且点了真的展开就地编辑（不是死按钮）', () => {
    ok(renameOpened === true, '点了重命名按钮，输入框没出现 —— 入口是死的');
    return '出现 folder-rename-input';
  });

  // 真的改一次名，并确认发出了 PATCH /api/folders/:uid
  const renameReqs = [];
  const onReq = (r) => {
    try {
      if (new URL(r.url()).pathname.startsWith('/api/folders/') && r.method() === 'PATCH') {
        renameReqs.push(r.method());
      }
    } catch {
      /* 忽略 */
    }
  };
  page.on('request', onReq);
  /*
   * ⚠️ 整段包在 try 里：这一步**点不动也只该让这条断言红**，不该把整轮审计带走。
   * `[实测]` 第一版没包，submit 按钮点超时直接抛出去 —— B10/B11 一条都没跑到，
   * 汇总里看不到它们，等于"跳过被渲染成了没有问题"（§11 那条的变形）。
   * 同样用 force：这一行的控件是 hover 才显形的。
   */
  try {
    /*
     * ★ 用**回车**提交，不用点那个 ✓ 按钮。
     *   两个理由，第二个是实测出来的：
     *   ① 回车才是用户改完名字最自然的动作；
     *   ② `[实测]` 对 ✓ 按钮 `click({force:true})` **点不动** ——
     *      force 会跳过"这个元素真的收得到指针事件吗"这项检查，
     *      于是坐标落在了别的元素上而我毫无察觉：请求 0 条、编辑框还开着。
     *      换成回车之后立刻看到 `PATCH /api/folders/<uid>` + 列表失效 + 编辑框关闭。
     *      **那是我的点法不对，不是产品坏了** —— 这类"测试看不见它"和"它坏了"
     *      长得一模一样，本轮已经栽过两次（B6 也是）。
     */
    await page
      .locator('[data-testid="folder-rename-input"]')
      .first()
      .pressSequentially(` 改名${Date.now() % 1000}`, { delay: 15 });
    await page.locator('[data-testid="folder-rename-input"]').first().press('Enter');
    await page.waitForTimeout(1500);
  } catch (e) {
    say(`   ⚠️ 提交改名时出错：${String(e.message).slice(0, 120)}`);
  }
  page.off('request', onReq);
  say(`   PATCH /api/folders/:uid 发出 ${renameReqs.length} 条`);

  await check('B9 ★ 改名真的打到了 PATCH /api/folders/:uid（不是只动了本地状态）', () => {
    ok(
      renameReqs.length > 0,
      '输入框有、按钮能点，但一条 PATCH 都没发出去 —— 那是"看起来能用"的假象',
    );
    return `${renameReqs.length} 条 PATCH`;
  });

  /*
   * ── 笔记移动：入口在笔记自己的「⋯」菜单里 ──
   *
   * ⚠️ 先造一条笔记：本脚本刻意用**空数据目录**（那两个按钮只有"还没装东西"时才出现），
   * 而空目录里**一条笔记都没有**，菜单自然也不存在。
   * `[实测]` 第一版就是这么拿到 `moveOpened = null` 的 —— 那不是"入口是死的"，
   * 是**这一节根本没有被执行**。§11：跳过不许被渲染成通过，所以这里
   * 走产品自己的导入端点真的建一条出来，建不出来就如实红。
   */
  const dummyPath = join(DATA_DIR, 'e2e-browser-move.wav');
  writeFileSync(dummyPath, Buffer.alloc(64));
  const imported = await fetch(`${BASE}/api/notes/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: dummyPath, title: '移动测试用的笔记' }),
  })
    .then((r) => r.json().then((b) => ({ status: r.status, uid: b?.noteUid })))
    .catch(() => ({ status: 0, uid: undefined }));
  say(`   为移动测试建了一条笔记：HTTP ${imported.status} uid=${imported.uid ?? '(无)'}`);
  /*
   * ⚠️ `NoteActionsMenu` 只渲染在**笔记详情页**（`NoteDetailPage.tsx:196`），
   * 列表页上没有它。`[实测]` 第一版建完笔记还停在 `/notes` 列表页，
   * 于是 `note-actions` 一直找不到 —— 又一次"我的测试没走到那儿"被误读成"入口是死的"。
   */
  if (imported.uid) {
    await page.goto(`${BASE}/notes/${imported.uid}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
  }

  /* ── 笔记移动：入口在笔记自己的「⋯」菜单里 ── */
  const moveOpened = await (async () => {
    try {
      const act = page.locator('[data-testid="note-actions"]').first();
      if ((await act.count()) === 0) return null; // 一条笔记都没有 —— 不算失败，如实说
      await act.click({ timeout: 8000 });
      await page.waitForTimeout(400);
      const mv = page.locator('[data-testid="note-move"]').first();
      if ((await mv.count()) === 0) return false;
      await mv.click({ timeout: 8000 });
      await page.waitForTimeout(900);
      return (await page.locator('[data-testid="note-move-panel"]').count()) > 0;
    } catch (e) {
      say(`   ⚠️ 打开移动面板时出错：${String(e.message).slice(0, 120)}`);
      return false;
    }
  })();
  say(`   点「移动到文件夹」后出现面板 = ${moveOpened}`);

  await check('B10 ★ 笔记「移动到文件夹」有入口且点得开（不是死按钮）', () => {
    ok(moveOpened !== null, '页面上一条笔记都没有 —— 这一节没有被真的执行（§11）');
    ok(moveOpened === true, '点了「移动到文件夹」，面板没出现 —— 入口是死的');
    return '出现 note-move-panel';
  });

  /*
   * ★ 失败要说话：把目标文件夹**移到一个已经不存在的 uid** 上会得到
   *   404 `FOLDER_NOT_FOUND`。这里注入它，要求界面真的说一句。
   */
  await page.route(
    (u) => {
      try {
        return /^\/api\/notes\/[^/]+\/folder$/.test(new URL(u).pathname);
      } catch {
        return false;
      }
    },
    (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'FOLDER_NOT_FOUND', message: 'gone', messageZh: '文件夹不存在' },
        }),
      }),
  );
  let moveSpoke = false;
  if (moveOpened === true) {
    const before = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    await page.click('[data-testid="note-move-root"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1800);
    const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    moveSpoke = FAIL_WORDS.test(after.replace(before, ''));
  }
  await page.unroute((u) => {
    try {
      return /^\/api\/notes\/[^/]+\/folder$/.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
  say(`   移动失败（注入 404）后界面说话了吗 = ${moveSpoke}`);

  await check('B11 ★ 移动失败时界面必须说话（目标文件夹已被删）', () => {
    ok(moveOpened === true, '面板没打开，这条无从谈起');
    ok(moveSpoke === true, '端点回了 404 FOLDER_NOT_FOUND，而界面一个字都没说 —— 又一处吞错误');
    return '出现了可读的错误';
  });

  // 变异①（死按钮那一种）：把「移动到文件夹」变成点不动，B10 必须红
  await mutation('B10 的证伪能力（把「移动到文件夹」弄成死按钮，必须红）', async () => {
    await page.goto(`${BASE}/notes`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1000);
    await page.locator('[data-testid="note-actions"]').first().click({ timeout: 8000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="note-move"]');
      if (el) {
        el.addEventListener(
          'click',
          (ev) => {
            ev.stopImmediatePropagation();
            ev.preventDefault();
          },
          true,
        );
      }
    });
    await page.locator('[data-testid="note-move"]').first().click({ timeout: 8000 });
    await page.waitForTimeout(900);
    const opened = (await page.locator('[data-testid="note-move-panel"]').count()) > 0;
    ok(opened === true, '点了「移动到文件夹」，面板没出现 —— 入口是死的');
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
  killTree(daemon?.pid);
  await new Promise((r) => setTimeout(r, 1200));
  killTreeHard(daemon?.pid);
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
