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
 * ### ⚠️ 上面这四条量的是「**窗里发生过什么**」，不是「**这一次点击导致了什么**」
 *
 * 两者只在页面自己静止时才相等。页面一动（SSE 推任务进度、`/api/jobs` 5 秒兜底轮询、
 * 迟到的首屏查询落地），这条判据就**恒真** —— `[CI 实测 run 31736237514 /
 * 31833084492 / 31902320145]` 连着三夜的 `B1 的证伪能力 → MUT-BAD` 就是这么来的：
 * 按钮**真的被弄死了**，而后台自己在动，于是"有反应=true"，变异**存活**。
 * 同一夜 linux 判"如期变红"，靠的只是它那 1.5 秒恰好静止。
 *
 * 所以有名有姓的按钮（B1）另加两条，都在 `e2e-browser-assertions.mjs` 里、
 * 都有反向证明（`selftest-e2e-browser.mjs`）：
 *
 *   ⑤ **空转对照窗**：点之前先量同样长的一段、**什么都不点**。
 *      那一段里页面自己发的请求、自己改的 DOM，判据一律不认。
 *   ⑥ **该发生的那件事**：点「立即测速」必须发出 `POST /api/models/sources/probe`。
 *      后台轮询发的是别的端点，凑不出这一条。
 *
 * ⑤⑥ **不是**钉住变异体的机制（捕获阶段 `stopImmediatePropagation`），钉的是
 * **产品的契约**。换一种弄死按钮的办法（删 onClick、`pointer-events:none`）照样红。
 *
 * ⚠️ **①〜④ 里的「未捕获异常」只算"有反应"，不算"该发生的事发生了"。**
 * 把异常直接当成"红"会造出反方向的假绿 —— v0.7.3 抓到过一条（变异体导航错页、
 * 抛了超时，而框架把任何抛出都读成"如期变红"）。「断言判红」和「腿炸了」分得开，
 * 靠的是**抛出的类型**（`AssertionFailed` / `Undecided` / 其它），不是靠数异常 ——
 * 判决那一份在 `mutation-verdict.mjs`，正反都有证明。
 *
 * ⚠️ 第 3 节那 40 个匿名按钮**仍然只有 ①〜④**（多一个对照窗 = 每个按钮多 1.5 s）。
 * 那一格的同形缺口还在，记在 `coordination/inbox/e2e-browser.md`，不假装已修。
 *
 * ⚠️ 判定 DOM 是否变化用**结构指纹字符串**（标签名 + testid + 可见文本的哈希），
 * **绝不把 DOM 节点本身传进断言** —— PROTOCOL §8：`assert.equal(domNode, null)`
 * 失败时 `util.inspect` 会顺着 `parentNode`/fiber 展开整棵树，实测涨到 10.5 GB，
 * 表现成"测试文件炸了"而不是"断言红了"。本文件里跨进 Node 的一律是**字符串与布尔**。
 *
 * ## 变异证明：这条断言必须能在"按钮死了"时真的红
 *
 * `installMutation()` 会在页面里给目标按钮挂一个**捕获阶段**的监听器，
 * 调用 `stopImmediatePropagation()` + `preventDefault()` ——
 * 按钮**还在、还可点、样式不变**，但点击**到不了任何处理器**。
 * 这正是"按钮死了"的形状，而且**不改产品源码一个字节**（PROTOCOL §10）。
 * 判据：同一条断言量到它必须**红**。红不了，说明这条腿看不见问题。
 *
 * ⚠️ 「同一条断言」现在**真的是同一段代码**（`judgeProbeClick()`）。此前基线轮和
 * 变异轮各手抄一份 `ok()` 清单，而变异轮那份是基线那份的**子集** ——
 * 两份手抄的清单会分叉，分叉的表现是"变异证明证的是另一条断言"。
 *
 * ### ⚠️ 「红了」也分两种：**断言按设计判红** vs **这条腿自己炸了**
 *
 * `mutation()` 此前只问"抛没抛"，于是 Playwright 超时、页面崩了、选择器写错，
 * 全都被记成「如期变红」。`[CI 实测 run 31629900327, win32-x64]` 原话：
 *
 *     ✔ [变异] B10 的证伪能力（把「移动到文件夹」弄成死按钮，必须红）
 *       —— 如期变红：locator.click: Timeout 8000ms exceeded.
 *          waiting for locator('[data-testid="note-actions"]')
 *
 * **那一轮变异体一次都没装上、函数体根本没跑到，却被记成"这条断言有牙齿"。**
 * 现在判决按**抛出的类型**分四档（`mutation-verdict.mjs`，正反都有证明）：
 * 没抛 ⇒ `MUT-BAD`；`AssertionFailed`（只有 `ok()` 抛）⇒ `MUT-OK`；
 * `Undecided` ⇒ `MUT-UNKNOWN`(前提)；**其它任何抛出** ⇒ `MUT-UNKNOWN`(腿炸了)。
 * 最后一档不计入失败，但会打 `::warning` 注解并在汇总里单独列 —— 它要去修**测试**。
 *
 * ## PROTOCOL §11
 *
 *   · 起 daemon 前**先证明端口是空的**（既没人答话、也能被我 bind 住）；
 *   · 收尾**按 pid 收整棵进程树**（Windows `taskkill /T`，POSIX 进程组），不 `pkill -f`；
 *   · 外部命令与页面操作**一律带超时**；
 *   · **「跳过」不许渲染成「成功」**：找不到按钮是**红**（并说清是哪一种找不到）。
 *
 * ## 等待：等那条断言**真正需要的那个东西**，不是等「网络安静了」
 *
 * `waitUntil:'networkidle'` + 一段定值 `waitForTimeout` 曾经遍布本文件。
 * 它的前提「网络安静 ⇒ 页面画完了」**是假的**：`networkidle` 可以恰好落在
 * 「bundle 下完、React 还没发出第一个 `/api` 请求」的缝里。
 * `[CI 实测 run 31629900327, win32-x64]` 就栽在这条缝上 ——
 * B1 把「这一页还没加载完」印成了「页面上根本没有这个按钮」。
 * 详细的成因、计时对照与替代做法见下方「★ 等什么」那一大段。
 *
 * ## 用法
 *
 *   node scripts/ci/e2e-browser-audit.mjs [--bundle <包目录>] [--port 19980]
 *        [--keep-open]
 *
 * （`--mutate <testid或文本>` 已删 —— 它在 CI 里一次都没跑过，理由见第 4 节末尾。）
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
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertPortFree, killTree, killTreeHard } from './launcher-spawn.mjs';
import {
  PROBE_EFFECT,
  judgeDeadButton,
  judgeExpectedEffect,
  judgeReaction,
} from './e2e-browser-assertions.mjs';
import {
  Undecided,
  assertOk,
  classifyMutationThrow,
  markUndecided,
  mutationAnnotation,
} from './mutation-verdict.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const BUNDLE = arg('--bundle', null);
const PORT = Number(arg('--port', '19980'));
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
/**
 * ★ 覆盖面上报（照抄 runtime 腿 `e2e-runtime-audit.mjs` 的同名 flag，
 * Manager 2026-08-11 裁决，browser 腿）：`verify-e2e-attestation.mjs` 仍然只看
 * artifact 名字判定通过/不通过（不变），但会把 `undecided` 念出来做**建议性**
 * 展示——前提是这条腿真的把数字报出来。这个 flag 只是把下面「汇总」已经
 * 算出来的 `undec.length` 落盘成一个小文件，供 `attest` job 跨平台求和后
 * 传给 `emit-e2e-attestation.mjs --undecided`。
 * ⚠️ 与 runtime 不同：**本文件没有 runtime 那种「变异模式整段换一套汇总语义」的分支**
 * ——本腿的变异是**同一趟运行里追加的几条断言**，不替换主汇总。所以这里**不需要**
 * 像 runtime 那样用 `!mutation` 网关；下面「汇总」块本来就是唯一、无条件执行的那一段。
 * （原文这里举的例子是 `--mutate`，那个开关已删 —— 它在 CI 里一次都没跑过。）
 */
const UNDECIDED_OUT = arg('--undecided-out', null);
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
/** 整轮被异常掐断（不是某一条断言红）—— 汇总里那条"变异地板"据此让路。 */
let aborted = false;
const brief = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 400 ? `${s.slice(0, 400)}…` : (s ?? '');
};
/*
 * ★ `ok()` 抛的是**专用类型** `AssertionFailed`，不是裸 `Error` —— 这是
 *   `mutation()` 分得开「断言按设计判红」和「这条腿自己炸了」的**唯一**依据。
 *   判据是**类型**不是消息措辞（推导见 `mutation-verdict.mjs` 文件头）。
 */
function ok(cond, msg, got) {
  assertOk(cond, msg, got, brief);
}
/**
 * ★ 第三种结局：**无从判断**（既不是通过，也不是失败）。
 *
 * ## 为什么必须有它
 *
 * 在此之前这个脚手架只有 PASS / FAIL 两档，于是「**这一轮压根没采到那个阶段**」
 * 只能靠 `return '……无从判断'` 表达 —— 而它在汇总里**仍然记成 PASS**。
 * B6b 就是这么连着两轮"通过"的：第一轮 `下载中` 从没出现（空过），
 * 第二轮选择器抓错了元素（抓到就绪横幅，不是任务 Toast），**照样绿**。
 *
 * 一条**永远绿**的断言比没有这条断言更坏：它让人以为这块被看住了。
 * PROTOCOL §11 的原话是「跳过不许渲染成成功」，这里补上那一档。
 *
 * ## 它不计入 failed（故意的）
 *
 * 采不到阶段往往是**平台差异**（Linux 上没有适用的后端包 → 没有解压阶段），
 * 不是缺陷。让它红会训练所有人无视这盏灯。所以：**单独一档、单独计数、
 * 汇总里单独列**，谁都能一眼看出"这条这轮没被验过"。
 */
function undecided(msg) {
  markUndecided(msg);
}

async function check(id, fn) {
  try {
    const detail = await fn();
    results.push({ id, status: 'PASS', detail: detail ?? '' });
    say(`   ✔ ${id}${detail ? `  —— ${detail}` : ''}`);
    return true;
  } catch (e) {
    if (e instanceof Undecided) {
      results.push({ id, status: 'UNDECIDED', detail: e.message });
      say(`   ？ ${id}  —— 无从判断：${e.message}`);
      return false;
    }
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
  /*
   * ★ 判决走**唯一**的那一份（`mutation-verdict.mjs`，有正反证明）。四档：
   *
   *   · 什么都没抛            ⇒ MUT-BAD      变异体存活
   *   · `AssertionFailed`     ⇒ MUT-OK       断言**按设计**判红
   *   · `Undecided`           ⇒ MUT-UNKNOWN  前提没构造出来
   *   · **其它任何抛出**      ⇒ MUT-UNKNOWN  **这条腿自己炸了**
   *
   * 最后一档此前落在 MUT-OK 里 —— `[CI 实测 run 31629900327, win32-x64]` 原话：
   * 「✔ [变异] B10 …—— 如期变红：locator.click: Timeout 8000ms exceeded」，
   * 那一轮变异体一次都没装上、函数体根本没跑到，却被记成"这条断言有牙齿"。
   *
   * ⚠️ MUT-UNKNOWN **不计入 failed**（平台差异构造不出前提是常态），所以
   *   `crash` 那一档必须**响**：打一条 `::warning` 注解，并进"本轮无从判断"清单。
   *   一个安静的 UNKNOWN 只是把一种假绿换成了另一种。
   */
  const verdict = classifyMutationThrow(threw, brief);
  results.push({ id, status: verdict.status, detail: verdict.detail, mutKind: verdict.kind });
  say(`   ${verdict.mark} [变异] ${id} —— ${verdict.text}`);
  const annotation = mutationAnnotation(id, verdict);
  if (annotation) say(annotation);
  if (verdict.status === 'MUT-BAD') failed += 1;
  return verdict.status === 'MUT-OK';
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

  /* ── ★ 等什么：**等这一页真的画完，不是等"网络安静了"** ──────────────────────
   *
   * `[CI 实测 run 31629900327, win32-x64]` B1 报「页面上根本没有这个按钮」，
   * 而**同一趟运行**两分钟后的 2b 节里，同一个按钮 `存在=true 可见=true 禁用=false`。
   * 变的不是产品，是我等的方式：
   *
   *     await page.goto(…, { waitUntil: 'networkidle', timeout: 30_000 });
   *     await page.waitForTimeout(1500);
   *
   * `networkidle` 说的是「连接安静了 500 ms」——它可以**恰好落在**
   * 「bundle 下完了、React 还没发出第一个 `/api` 请求」的那个缝里：缝的两侧都安静。
   * 同一趟运行的计时对照（`goto` 本身耗时，= 打印时刻差 − 那 1500 ms）：
   *   · win32 **0.59 s** → 红；   · linux **1.03 s** → 绿；
   *   · 通过的两趟 win32：**7.13 s**（run 31633140317）/ **7.81 s**（run 31571495081）。
   * **0.59 s 那趟不是页面快，是 idle 得太早**，而定值 1500 ms 盖不住这个缺口。
   *
   * 缺口另一侧是产品的渲染契约：`useModelsSourcesQuery()` pending 期间
   * `SourcesSection.tsx:48` 是 `if (!data) return null;` —— 整块下载源区块连同
   * `data-testid="models-sources-probe"`（同文件 :91）**根本不在 DOM 里**，
   * 不是隐藏、不是禁用，是**不存在**。于是「还没加载完」和「按钮真的没了」
   * 在 `exists === false` 这一个布尔上**完全同形**。
   * **一条把"还在加载"报成"按钮不存在"的腿，正是本文件要拆掉的那种假红。**
   *
   * ⇒ 之后**一律等那条断言真正需要的那个东西**：
   *     · `openPage()` 只等 DOM 到手（`domcontentloaded`），不再拿网络冒充页面；
   *     · 紧跟着 `waitForSel()` / `until()` 等**具体那个元素/条件**，带超时；
   *     · **等不到不抛** —— 结果交给断言，断言才说得清是「这一页没加载完」
   *       还是「那个东西真的不在」（`endpointEvidence()` 提供分辨用的证据）。
   *
   * ⚠️ **判据一个字都没放松**：等不到照样红，只是红的那句话变准了。
   *   刻意保留的定值等待只有两类，各自在原地写明理由：
   *     ① `REACTION_WINDOW_MS` —— 它**就是**判据本身（「点击之后的 1.5 秒内」）；
   *     ② 采样循环的 200/300 ms 间隔、以及 B12 变异基线那 1.2 s ——
   *        那是**测量**（要的就是"过了这么久"），不是等待。
   */
  const READY_MS = 20_000;

  /** 打开一页：只等 DOM 到手。「这一页画完没有」由调用方按自己需要的东西去等。 */
  async function openPage(page_, path) {
    await page_.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  /**
   * 等一个选择器出现。**等不到不抛**，返回 `{ ok, ms }`（全是字符串/数字/布尔，§8）。
   * 谁调用谁负责把"没等到"写进自己那条断言的失败消息里 —— 这正是两件事分得开的地方。
   */
  async function waitForSel(page_, sel, { timeout = READY_MS, state = 'attached' } = {}) {
    const t0 = Date.now();
    try {
      await page_.waitForSelector(sel, { state, timeout });
      return { ok: true, ms: Date.now() - t0 };
    } catch {
      return { ok: false, ms: Date.now() - t0 };
    }
  }

  /**
   * 轮询一个谓词（页面侧或 Node 侧都行）直到为真或超时，同样**不抛**。
   *
   * ⚠️ 用它替换定值 sleep 时，**谓词必须和那条断言用的是同一个** ——
   * 谓词一旦比断言宽，就成了"等到断言能过为止"，那是放水，不是等待。
   */
  async function until(probe, { timeout = READY_MS, interval = 150 } = {}) {
    const t0 = Date.now();
    for (;;) {
      let hit;
      try {
        hit = (await probe()) === true;
      } catch {
        // 探针自己抛了（页面正在导航、元素刚被换掉…）= 这一轮不算命中，继续等
        hit = false;
      }
      if (hit) return { ok: true, ms: Date.now() - t0 };
      if (Date.now() - t0 >= timeout) return { ok: false, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** SPA 真的挂上了（body 里有字），不是一张白纸。给"只要一个页面上下文"的地方用。 */
  async function waitForAppMounted(page_, { timeout = READY_MS } = {}) {
    return await until(
      async () => (await page_.evaluate(() => document.body.innerText.trim().length)) > 0,
      { timeout, interval: 100 },
    );
  }

  /**
   * 某个端点这一轮到底发生过什么。断言拿它把三件事分开说：
   *   · 请求 0 条  ⇒ 前端压根没发起（页面没跑到那一步）—— **不是产品缺陷**；
   *   · 有 >=400   ⇒ 请求失败了，该走错误分支；
   *   · 有请求、无错误、界面却没东西 ⇒ **这才轮到怀疑产品**。
   */
  function endpointEvidence(needle) {
    const reqs = requests.filter((r) => r.includes(needle));
    const bad = badResponses.filter((r) => r.includes(needle));
    if (reqs.length === 0) return `${needle} 请求 0 条（前端根本没发起 —— 页面还没跑到那一步）`;
    return bad.length > 0
      ? `${needle} 请求 ${reqs.length} 条，其中 HTTP>=400 ${bad.length} 条：${bad[0]}`
      : `${needle} 请求 ${reqs.length} 条，没有 >=400 的响应`;
  }

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

  /**
   * 横扫专用的「画完了」：**按钮清单连续两次采样一模一样**。
   *
   * 横扫没有"要等的那一个元素" —— 它要等的是**全部**，所以只能等清单静止。
   * 静不下来**不红**（那不是这一节的判据），但必须如实说一句：
   * 默默少扫几个按钮才是最坏的形态 —— **覆盖面缩水，而汇总里一片绿**。
   */
  async function waitForInventorySettled(page_, { timeout = 12_000, interval = 300 } = {}) {
    const t0 = Date.now();
    let prev = null;
    for (;;) {
      // 采样自己出错（正在导航、执行上下文刚被换掉）**不许把整页判成"打不开"** ——
      // 外层那个 try 会 `continue` 掉一整页，那才是真正的覆盖面损失。
      let now;
      try {
        now = (await inventory(page_)).join('\n');
      } catch {
        now = '';
      }
      if (prev !== null && now === prev && now.length > 0) {
        return { ok: true, ms: Date.now() - t0, count: now.split('\n').length };
      }
      prev = now;
      if (Date.now() - t0 >= timeout) {
        return { ok: false, ms: Date.now() - t0, count: now ? now.split('\n').length : 0 };
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /**
   * 装一个变异体：让目标按钮"还在但点不动"。**不改产品源码一个字节。**
   *
   * ⚠️ `return` 不许再丢：原来这里 `await` 了页面侧的返回值却没往外传，
   * 于是**变异体没装上**（按钮还没渲染出来）与**装上了**在调用方看来一模一样，
   * 而后者会被 `mutation()` 记成 MUT-OK ——「这条断言有牙齿」是**假的**。
   */
  async function installMutation(page_, needle) {
    return await page_.evaluate((n) => {
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
   *
   * ## `ambientWindow` —— 点之前先量一段「什么都不点」的同长窗口
   *
   * 判据要的是「**这一次点击**导致了什么」，而观测到的是「窗里发生过什么」。
   * 两者只在页面自己静止时才相等 —— 页面一动（SSE 推进度、任务列表 5 秒兜底轮询、
   * 迟到的首屏查询落地），老判据就恒真。`[CI 实测 run 31736237514 / 31833084492 /
   * 31902320145]` 连着三夜的 `MUT-BAD` 就是这么来的：变异体把按钮弄死了，
   * 而后台自己在动，于是"有反应=true"，变异**存活**。
   *
   * 打开它 ⇒ 先量 `REACTION_WINDOW_MS` 的**空转对照窗**：那一段里页面自己发的请求、
   * 自己改的 DOM，判据一律不认（细节与推导在 `e2e-browser-assertions.mjs` 文件头）。
   *
   * ⚠️ 代价是每个点击多花一个观测窗（1.5 s）。所以**只给有名有姓的那几个按钮打开**，
   * 横扫那 40 个匿名按钮维持原样（`ambient = null` ⇒ 判据退化回老四选一）——
   * 横扫的判据没有变，这次改的是 B1 那一条。横扫那一格的同形缺口**仍然在**，
   * 单独记在 `coordination/inbox/e2e-browser.md`，不在这次的范围里。
   *
   * ## `expectApi` —— 「该发生的那件事」
   *
   * 形如 `'POST /api/models/sources/probe'`。有它的按钮，判据不再只问"窗里动了吗"，
   * 还要问"**那一条**请求发出去了吗"。后台轮询发的是别的端点，凑不出这一条。
   */
  async function clickAndObserve(page_, opts) {
    const {
      name,
      testid,
      text,
      rawSel,
      expectUrlChange = false,
      ambientWindow = false,
      expectApi = null,
    } = opts;
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

    /*
     * ★ 空转对照窗（t0 → t1）：**同样长、什么都不点**。
     *   它量的是"这一刻页面自己在动多少" —— 点击窗里凑不出比它更多的东西，
     *   就说明这一次点击什么都没导致。
     */
    const ambientFrom = requests.length;
    const ambientFp = ambientWindow ? await page_.evaluate(FINGERPRINT) : null;
    if (ambientWindow) await page_.waitForTimeout(REACTION_WINDOW_MS);

    const before = {
      url: page_.url(),
      fp: await page_.evaluate(FINGERPRINT),
      reqCount: requests.length,
      errCount: pageErrors.length,
    };
    const ambient = ambientWindow
      ? {
          domChanged: ambientFp !== before.fp,
          apiRequests: requests
            .slice(ambientFrom, before.reqCount)
            .filter((r) => r.includes('/api/')),
        }
      : null;

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

    /*
     * ★ 这个定值等待**刻意保留**：它不是"等页面画完"，它**就是判据本身** ——
     *   文件头写死的「点击之后的 1.5 秒内至少发生一件」。
     *   改成"等到有反应为止"会把判据从"1.5 秒内有反应"偷换成"迟早会有反应"，
     *   那是放水。等待可以改，**判据不行**。
     */
    await page_.waitForTimeout(REACTION_WINDOW_MS);

    const after = {
      url: page_.url(),
      fp: await page_.evaluate(FINGERPRINT),
    };
    const newReqs = requests.slice(before.reqCount).filter((r) => r.includes('/api/'));
    const newErrs = pageErrors.slice(before.errCount);

    const obs = {
      name,
      ...found,
      clicked,
      clickError,
      urlChanged: before.url !== after.url,
      domChanged: before.fp !== after.fp,
      apiRequests: newReqs,
      newPageErrors: newErrs,
      expectUrlChange,
      ambient,
      expectApi,
    };
    /*
     * ★ 「有反应」的判据**只有一份**，在 `e2e-browser-assertions.mjs` 里 ——
     *   抽出去是为了能对它写证明（这个文件全程顶层执行 + `process.exit()`，
     *   import 不进来，判据留在这儿就永远喂不进输入）。
     */
    const reaction = judgeReaction(obs);
    const expected = judgeExpectedEffect(obs);
    return { ...obs, reacted: reaction.reacted, reactedWhy: reaction.why, expected };
  }

  function reportClick(r) {
    say(`   ── ${r.name}`);
    say(
      `      存在=${r.exists} 可见=${r.visible ?? '-'} 禁用=${r.disabled ?? '-'} 文案="${r.label ?? ''}"`,
    );
    say(`      点击成功=${r.clicked}${r.clickError ? ` clickError=${r.clickError}` : ''}`);
    if (r.ambient) {
      // 「页面自己在动多少」——不打出来，读日志的人无从判断那句"有反应"值不值钱。
      say(
        `      空转对照窗（同样长、什么都不点）：DOM 自己变了=${r.ambient.domChanged}` +
          `  /api 自己发了 ${r.ambient.apiRequests.length} 条`,
      );
      for (const q of r.ambient.apiRequests.slice(0, 6)) say(`        ∘ ${q}`);
    }
    say(
      `      URL 变了=${r.urlChanged}  DOM 变了=${r.domChanged}  /api 请求 ${r.apiRequests.length} 条`,
    );
    for (const q of r.apiRequests.slice(0, 6)) say(`        → ${q}`);
    for (const e of r.newPageErrors.slice(0, 4)) say(`        ✘ 未捕获异常：${e}`);
    say(`      **有反应 = ${r.reacted}**（${r.reactedWhy}）`);
    if (r.expectApi) {
      const mark = { hit: '✔', miss: '✘', ambiguous: '？' }[r.expected.verdict] ?? '-';
      say(`      ${mark} 该发生的那件事（${r.expectApi}）：${r.expected.why}`);
    }
  }

  /**
   * ★ B1 的**判决那一句** —— 基线轮和变异轮共用**同一段代码**。
   *
   * 此前两边各写一遍 `ok()` 清单，而变异轮那份是基线那份的**子集**。
   * 「同一条断言必须红」这句话，只有当它真的是同一条时才成立 ——
   * 两份手抄的清单迟早会分叉，而分叉的表现正是"变异证明证的是另一条断言"。
   *
   * ⚠️ 这里**只放判决**，不放前提。前提（按钮在不在、点不点得到）两轮的性质不同：
   *   · 基线轮：前提不成立 = **缺陷**（按钮没了 / 点不动，就是用户报的那个）⇒ `ok()` ⇒ FAIL；
   *   · 变异轮：前提不成立 = **这一轮没构造出来** ⇒ `undecided()` ⇒ MUT-UNKNOWN。
   * 把变异轮的前提也写成 `ok()` 会让"腿炸了"落进 MUT-OK ——「这条断言有牙齿」是假的，
   * 正是 v0.7.3 抓到的那条反方向假绿（那次是"抛了超时被读成如期变红"）。
   */
  function judgeProbeClick(r) {
    const verdict = judgeDeadButton(r);
    // 第三态：页面自己就在发那条请求 ⇒ 这一轮量不出因果，什么都没证明。
    if (verdict.verdict === 'undecidable') undecided(verdict.why);
    ok(
      verdict.verdict === 'alive',
      `**点了没有发生该发生的事** —— ${verdict.why}`,
      `有反应=${r.reacted} 该发生的事=${r.expected.verdict}`,
    );
  }

  /* ── 2. 复现用户报的那两个 ─────────────────────────────────────────────── */

  hdr('2. 复现用户报的两个按钮（空数据目录 = 用户当时的状态）');
  await openPage(page, '/models');
  /*
   * ★ 等的是**下载源区块真的挂进 DOM**，不是"网络安静了 + 睡 1.5 秒"（见上方「等什么」）。
   *   `models-sources` 是 `useModelsSourcesQuery()` 落地的**唯一** DOM 出口，
   *   而「立即测速」就长在它里面 —— 它出现了，B1 的 `exists=false` 才说得上是缺陷。
   */
  const sourcesReady = await waitForSel(page, '[data-testid="models-sources"]');
  say(`   打开 ${BASE}/models`);
  say(
    `   下载源区块（models-sources）就绪=${sourcesReady.ok}，等了 ${sourcesReady.ms} ms` +
      ` | ${endpointEvidence('/api/models/sources')}`,
  );
  say(`   页面标题：${await page.title()}`);
  say('   ── 这一页上所有可见按钮（先枚举再点，不猜选择器）──');
  for (const b of await inventory(page)) say(`      ${b}`);

  const probeR = await clickAndObserve(page, {
    name: '「立即测速」（models.sources.probe）',
    testid: 'models-sources-probe',
    // ★ B1 与它的变异证明用**同一套观测参数**，否则两边量的就不是同一件事。
    ambientWindow: true,
    expectApi: PROBE_EFFECT,
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
    /*
     * ★ 这一条**先于**"按钮在不在"：把「这一页没加载完」和「按钮真的不在」分开说。
     *   两者在 `exists === false` 上同形，而只有后者是缺陷。
     *   `[CI 实测 run 31629900327, win32-x64]` 红的正是前者，却印成了后者。
     */
    ok(
      sourcesReady.ok === true,
      `等了 ${sourcesReady.ms} ms，下载源区块（models-sources）**从没进过 DOM** —— ` +
        '这一轮**页面没加载完**，不是"按钮不存在"' +
        `（pending 期间 SourcesSection.tsx:48 整段 return null）。证据：${endpointEvidence(
          '/api/models/sources',
        )}`,
    );
    ok(probeR.exists === true, '页面上根本没有这个按钮', probeR);
    ok(probeR.visible === true, '按钮存在但不可见', probeR);
    ok(
      probeR.disabled === false,
      '按钮是禁用的 —— 禁用本身不算错，但必须同时告诉用户为什么（这里没有）',
      probeR,
    );
    ok(probeR.clicked === true, `点不动：${probeR.clickError}`);
    // ★ 判决那一句与下面第 4 节的变异证明**是同一段代码**（见 judgeProbeClick 的注释）。
    judgeProbeClick(probeR);
    return (
      `api=${probeR.apiRequests.length} domChanged=${probeR.domChanged}` +
      ` 空转对照窗(DOM 自己变了=${probeR.ambient?.domChanged} /api ${probeR.ambient?.apiRequests.length} 条)` +
      ` 该发生的事=${probeR.expected.verdict}`
    );
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
    /*
     * ★ 「不存在」在这条断言里是**通过**的形态之一，所以它对"页面没加载完"
     *   格外脆弱：`[CI 实测 run 31629900327, win32-x64]` 那一轮页面根本没画完，
     *   B2 却报了 PASS —— **一次假绿，就躺在那次假红旁边**。
     * ⚠️ `sourcesReady` 不是 `AsrModelPicker` 那条 query 的直接证据（是另一条），
     *   但同一次挂载发出的那批请求里已经有一条落地了，足以否掉「整页还是空的」
     *   这一种 —— 而那正是这里唯一会把"没加载完"读成"已修复"的情形。
     */
    ok(
      sourcesReady.ok === true,
      `等了 ${sourcesReady.ms} ms 这一页的数据一条都没落地 —— ` +
        '此时"按钮不在页面上"什么都说明不了，不许记成"正是修复后的形态"',
    );
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
      await openPage(page, path);
      /*
       * ★ 横扫的危害形状和 B1 不同：页面没画完不会红，会**默默少扫几个按钮** ——
       *   覆盖面缩水，汇总里却一片绿。所以这里等的是"按钮清单不再往外冒"。
       */
      const settled = await waitForInventorySettled(page);
      if (!settled.ok) {
        say(
          `   ${path}：${settled.ms} ms 内按钮清单一直在变（当前 ${settled.count} 个）—— ` +
            '这一页可能没扫全，如实记一句（不红：这不是本节的判据）',
        );
      }
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
        await openPage(page, path);
        /*
         * ★ 先等清单静止**再**按序号打标：序号是在上面枚举完整清单时定的，
         *   在一张还在往外冒按钮的页面上数到第 i 个，数到的可能是**另一颗按钮**。
         *   （定值 700 ms 时这个错位一直存在，只是没人看得见。）
         */
        await waitForInventorySettled(page, { timeout: 8_000 });
        /*
         * ★ 按**枚举序号**打标再点，不靠文案。
         *   `[实测]` 第一版用文案定位，而图标按钮**没有文案** —— `getByText('')`
         *   定位不到，于是它们被报成"点了没反应"。那是**我的选择器坏了**，
         *   不是产品坏了。差点因此报出一串假缺陷。
         *   打的是一个惰性属性（不改行为），而且每次导航都会被重置。
         *
         * ★ 等的是"第 i 个可点按钮真的枚举得到"，不是定值 700 ms ——
         *   页面没画完时打不上标，会走到下面那句「这一轮枚举不到它了，跳过」，
         *   而那句话在说的其实是"我来早了"。同一形状：**把没看见说成不存在**。
         */
        let tagged = false;
        const tagWait = await until(
          async () => {
            tagged = await page.evaluate(
              ({ skipSrc, idx }) => {
                const re = new RegExp(skipSrc);
                let k = 0;
                for (const el of document.querySelectorAll('button')) {
                  const st = getComputedStyle(el);
                  const r = el.getBoundingClientRect();
                  if (st.display === 'none' || st.visibility === 'hidden' || r.width === 0)
                    continue;
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
            return tagged;
          },
          { timeout: 10_000, interval: 250 },
        );
        if (!tagged) {
          say(
            `   ── ${path} #${i}「${n.label || n.aria || '(图标按钮)'}」：` +
              `等了 ${tagWait.ms} ms 仍枚举不到它，跳过（这一页这一轮就是没画出它）`,
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
  await openPage(page, '/models');
  /*
   * ★ 同 B1：等那颗按钮真的进 DOM。这里等不到的话，B5 会报「按钮没点到」——
   *   又一句把"页面没加载完"说成产品问题的话（`clickAndObserve` 只拍快照，不等）。
   */
  const probeBtnReady = await waitForSel(page, '[data-testid="models-sources-probe"]');
  say(`   「立即测速」就绪=${probeBtnReady.ok}，等了 ${probeBtnReady.ms} ms`);
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
    ok(
      probeBtnReady.ok === true,
      `等了 ${probeBtnReady.ms} ms「立即测速」都没进 DOM —— **页面没加载完**，` +
        `不是产品问题（${endpointEvidence('/api/models/sources')}）`,
    );
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

  /*
   * ★ 这一次 `goto` 只是为了要一个**同源的页面上下文**去 `fetch` ——
   *   下面那段 `page.evaluate` 完全不看 DOM。所以只等 SPA 挂上就够，
   *   原来的 `networkidle` + 800 ms 既不必要、又会白白吃掉后面那段很短的安装窗口。
   */
  await openPage(page, '/models');
  await waitForAppMounted(page);

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
  /** 真的处在 downloading 的采样轮数（B6b 的元断言用：没采到就不许算通过）。 */
  let downloadingMoments = 0;
  /** downloading 期间**任务 Toast 标题**的原文。空数组 = 这一轮压根没看见过标题。 */
  const toastTitlesWhileDownloading = [];
  /** 解包阶段界面上那串百分比文本（B6c 用）。采不到就保持 null，不猜。 */
  let unpackingPercentText = null;
  /**
   * ★ B6 的"有没有机会看"计数：**界面上真的出现过安装进度**（字节数或百分比）的采样轮数。
   *
   * 判据要分开的是两件事，而它们此前都落在同一条红里：
   *   · **没机会看**：安装太快，整轮没在屏幕上抓到过"正在装"的任何痕迹 → 这一轮什么都没证明；
   *   · **看了，但界面是哑的**：进度都渲染出来了，**阶段文案却一个都没有** → 这是真缺陷，必须红。
   *
   * 用"进度指示"当机会信号，是因为它和阶段文案是**两个不同的 DOM 出口**——
   * 用阶段文案自己判断"有没有机会看阶段文案"是循环论证。
   */
  let progressVisibleSamples = 0;
  let sampleRounds = 0;

  if (packToInstall !== null) {
    /*
     * ★ 这里**故意只等到"SPA 挂上"就开始采样**，不等更多。
     *   安装窗口本来就短（门禁装的是 5.3 MB 的小包），多等一毫秒都可能把
     *   "看得见安装在进行"的那几个瞬间等没了 —— 而 `progressVisibleSamples`
     *   少一个，B6 就更容易掉进 UNDECIDED。
     *   `networkidle` 在这里恰恰是**等得太久**的那一种错，方向和 B1 相反、成因同一个：
     *   拿网络状态冒充页面状态。
     */
    await openPage(page, '/tasks');
    await waitForAppMounted(page, { timeout: 10_000 });
    for (let i = 0; i < 150; i++) {
      const snap = await page.evaluate(() => ({
        body: document.body.innerText.replace(/\s+/g, ' '),
      }));
      sampleRounds += 1;
      // 进度指示（字节计数或百分比）= "这一刻界面上确实在显示安装这件事"
      if (
        /([\d.]+\s*[KMG]i?B)\s*\/\s*([\d.]+\s*[KMG]i?B)/.test(snap.body) ||
        /(^|\D)\d+(\.\d+)?\s*%/.test(snap.body)
      ) {
        progressVisibleSamples += 1;
      }
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
      //
      // ⚠️ 选择器踩过两次坑，别再改回去：
      //   · `[role="status"]` 在这个页面上**不止一个** —— 文档序里第一个是
      //     首页的**就绪横幅**（「有 N 项能力未就绪」），根本不是任务 Toast。
      //     `querySelector` 取第一个匹配，于是上一轮采到的全是横幅的字。
      //   · 容器是 `[data-testid="job-toaster"]`，每条是 `job-toast-<jobId>`；
      //     **标题**是那条里的第一个 `<p>`（JobToaster.tsx:349 `titleFor()`）。
      //     注意 `job-toast-goto-note` 等**按钮**的 testid 前缀也一样，
      //     但按钮里没有 `<p>`，所以用 `querySelector('p')` 天然把它们滤掉。
      if (snap.body.includes('下载中') && !seenLabels.includes('正在安装')) {
        downloadingMoments += 1;
        const titles = await page.evaluate(() => {
          const box = document.querySelector('[data-testid="job-toaster"]');
          if (box === null) return null;
          return [...box.querySelectorAll('[data-testid^="job-toast-"]')]
            .map((row) => row.querySelector('p'))
            .filter((p) => p !== null)
            .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((s) => s.length > 0);
        });
        if (titles !== null && titles.length > 0) {
          toastTitlesWhileDownloading.push(...titles);
          for (const t of titles) {
            if (t.includes('安装')) toastSaidInstallWhileDownloading ??= t.slice(0, 80);
          }
        }
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

  say(`   B6 采样：共 ${sampleRounds} 轮，其中 ${progressVisibleSamples} 轮界面上有进度指示`);

  /* ─────────────────────────────────────────────────────────────────────────
   * B6 ★ 采不到样 → UNDECIDED，和姊妹判据 B6b/B6c 对齐
   *
   * 此前这条**采不到样直接判死刑**：`seenLabels` 为空就红。
   * `[CI 实测 darwin-arm64]` 那格的安装窗口只有 ~11.5 秒、历史上也一贯只勉强抓到 1 条，
   * 于是它红的是 **macOS runner 偏慢导致的采样竞态**，不是产品。
   * 而**同一个文件里** B6b/B6c 采不到样都会降级成 UNDECIDED —— 唯独 B6 没有。
   * 我当初立那第三态的原话是「空的和真的，现在分得开了」；这里是它的镜像：
   * **"不知道"被当成了失败**。同一个混淆，另一个方向。
   *
   * ⚠️ 但**不许**顺手把"真的没有阶段文案"也降级掉 —— 那才是这条断言的本职。
   * 所以用**两个不同的 DOM 出口**把两件事分开：
   *   · `progressVisibleSamples === 0` → 整轮没在屏幕上见过安装进度 ⇒ **没机会看** ⇒ UNDECIDED；
   *   · 进度出现过、阶段文案却一条都没有 ⇒ **界面是哑的** ⇒ **照样红**。
   * ───────────────────────────────────────────────────────────────────────── */
  await check('B6 任务中心卡片上的阶段文案必须是中文、且不许阶段倒退', () => {
    if (packToInstall === null) undecided('本机没有适用的后端包，压根没起安装');
    /*
     * ★ 门槛是 3，不是 1 —— 这条边界是 `[CI 实测 darwin-arm64, run 31366579943]` 校出来的。
     *
     * 那一轮 `progressVisibleSamples === 1` 就宣判「那一处真的是哑的」并且红了。
     * **一个瞬间支撑不起"从来没有"这句话**：阶段文案和进度指示是同一张卡上的两行，
     * 只采到一个瞬间时，"没看见文案"与"恰好错过"在证据上不可分。
     * 同一台 darwin 上一轮采到 2 个瞬间就抓到了「正在选择下载源」并且绿 ——
     * **n=1 时结论会随运气翻面，那就不是判据，是抛硬币。**
     *
     * 所以：< 3 个"看得见安装在进行"的瞬间 ⇒ 这一轮**没看够**，报无从判断；
     * ≥ 3 个瞬间还一条文案都没有 ⇒ 那一处确实是哑的 ⇒ **照样红**。
     * ⚠️ 这不是放宽判据 —— 判据仍是"必须有中文阶段文案"，动的是
     * **"我到底看够了没有"** 这个前提，而前提不成立时本来就不该下结论。
     */
    const MIN_LOOKS = 3;
    if (progressVisibleSamples < MIN_LOOKS) {
      undecided(
        `采样 ${sampleRounds} 轮，其中只有 ${progressVisibleSamples} 个瞬间看得见安装在进行` +
          `（需要至少 ${MIN_LOOKS} 个）—— 安装窗口短过采样间隔，这一轮没看够，不下结论`,
      );
    }
    ok(
      seenLabels.length > 0,
      `界面上有 ${progressVisibleSamples} 个瞬间看得见安装进度，**却一个阶段文案都没有** —— ` +
        `这不是没采到（进度采到了），是那一处真的是哑的`,
    );
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
  /*
   * ★ 这条登记项**适用于哪条路径**（2026-08-09 查清，之前没写清楚）
   *
   * 只适用于**带压缩包的安装**：后端包（backend pack）一律是 `.tar.zst`/`.zip`，
   * 必经解压；模型侧则**看清单里的 `files[].unpack`** —— 有这个字段的才解压。
   * 抽查 `vendor/manifests/models-whisper.json` 的 `asr/whisper-large-v2-q8_0`：
   * 单文件 `ggml-large-v2-q8_0.bin`、`unpack` 缺省 ⇒ **这条模型路径根本没有解压阶段**。
   * 这解释了 D1 那一轮（win32，1.7 GB 模型）阶段序列里为什么没有「正在解压」：
   * **不是没推事件，是这条路径本来就没有这一段。**
   * ⇒ 所以 B6c 在"只装了这类模型"的机器上会亮**无从判断**，那是对的；
   *   要验它必须走**后端包**或**带 `unpack` 的模型**。
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
      // （这里以前是 `return`，会被汇总记成 PASS；现在走 UNDECIDED 那一档。）
      undecided('本轮没采到解压阶段');
    }
    const fixed = KNOWN_UI_LIES.filter((x) => !observedLies.includes(x));
    ok(
      fixed.length === 0,
      `清单里的「${fixed.join('、')}」看起来已经被修好了 —— ` +
        `**请把它从 KNOWN_UI_LIES 里划掉**（清单被修好也要红，否则它会烂在这儿）`,
    );
    return `已知谎话仍在：${observedLies.join('、')}`;
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
  await openPage(page, '/models?tab=llm');
  /*
   * ★ 等的是 llm **面板**（`models-llm-tab`，`ModelsPage.tsx:484`）挂上 ——
   *   B7 问的是"落地页上有没有他要用的控件"，页面没画完时答案必然是"没有"，
   *   而那句"引导把用户送到了一个他做不了事的地方"就成了假指控。
   */
  const llmReady = await waitForSel(page, '[data-testid="models-llm-tab"]');
  say(`   /models?tab=llm 面板就绪=${llmReady.ok}，等了 ${llmReady.ms} ms`);
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
    /*
     * ★ 顺序是判据的一部分：**先落到要观察的那一页，再发起任务。**
     *
     * `[CI 实测 run 31317995697, win32-x64]`：downloading 采到 **127** 轮，
     * Toast 标题却**一条都没有**。原因不在选择器 —— 在这两行的先后：
     * `JobToaster` 的 toast 列表是 **SSE 事件喂出来的 React state**
     * （`job.created` → `setToasts`），而 `page.goto` 是**整页导航**，
     * 会把 SPA 连同这份 state 一起重挂。任务是在导航**之前**发起的，
     * 那条 `job.created` 早就过去了，重挂后的 Toast 层永远是空的。
     * ⇒ 先 `goto('/tasks')`，再 POST，事件才落在活着的那个页面上。
     *
     * 附带一条**产品观察**（只记，不改）：这意味着**任务进行中刷新页面，
     * Toast 就再也不出现了**（任务中心里还在，Toast 层空）。
     * 对"转瞬即逝的通知"来说这也许可以接受，但它是真实存在的行为差异。
     */
    await openPage(page, '/tasks');
    /*
     * ★ 这里的"先落页再 POST"是判据的一部分（见上一段），所以等的必须是
     *   **SPA 真的挂上了**，而不是"网络安静了" —— 后者可能在 React 还没挂载时就成立，
     *   于是 `job.created` 又一次落在一个不存在的 Toast 层上，正是上一次踩的坑。
     */
    const mounted = await waitForAppMounted(page);
    say(`   /tasks 已挂载=${mounted.ok}（等了 ${mounted.ms} ms）—— 之后才发起任务`);
    const started = await page.evaluate(async (id) => {
      const r = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return r.status;
    }, DIAGNOSE_DOWNLOAD);
    say(`   POST /api/models/pull → HTTP ${started}`);

    /** 每一次采样：界面上那几个数 + Toast 标题 + 当前阶段文案。 */
    const samples = [];
    const labelSeq = [];
    for (let i = 0; i < 900; i++) {
      const s = await page.evaluate(() => {
        const body = document.body.innerText.replace(/\s+/g, ' ');
        // 同 B6b：只认 `job-toaster`。`[role="status"]` 会先命中就绪横幅。
        const toastEl = document.querySelector('[data-testid="job-toaster"]');
        return {
          pct: (/(\d+(?:\.\d+)?)\s*%/.exec(body) ?? [])[1] ?? null,
          // 「12.3 MB / 1.66 GB」这种；只取第一处
          bytes: (/([\d.]+\s*[KMG]i?B)\s*\/\s*([\d.]+\s*[KMG]i?B)/.exec(body) ?? [])[0] ?? null,
          speed: (/([\d.]+\s*[KMG]i?B\/s)/.exec(body) ?? [])[0] ?? null,
          // ⚠️ 上一轮这里报「ETA 0 个不同值」，是**我的正则错了**，不是产品没渲染：
          // 界面根本不写「剩余」或「ETA」这两个词。`lib/format/time.ts:70 approxEta()`
          // 出的字面是「不到 1 分钟 / 约 N 分钟 / 约 N 小时」（en: less than a minute /
          // about N min / about N hr），由 JobToaster.tsx:369、JobList.tsx:100、
          // NoteProgressLine.tsx:68 三处以 ` · ${eta}` 拼在阶段行尾。按这个改。
          eta:
            (/(不到\s*1\s*分钟|约\s*\d+\s*(?:分钟|小时)|less than a minute|about\s+\d+\s*(?:min|hr))/.exec(
              body,
            ) ?? [])[0] ?? null,
          toast: toastEl ? (toastEl.textContent || '').replace(/\s+/g, ' ').slice(0, 60) : null,
          // B6b 要的是**标题那一行**，不是整块 Toast 的字（见 B6b 处的选择器说明）。
          titles:
            toastEl === null
              ? []
              : [...toastEl.querySelectorAll('[data-testid^="job-toast-"]')]
                  .map((row) => row.querySelector('p'))
                  .filter((p) => p !== null)
                  .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
                  .filter((x) => x.length > 0),
          body,
        };
      });
      for (const zh of ['正在选择下载源', '下载中', '正在校验完整性', '正在解压', '正在安装']) {
        if (s.body.includes(zh) && !labelSeq.includes(zh)) labelSeq.push(zh);
      }
      /*
       * ★ 把 D1 的采样**喂给 B6b**。
       *
       * 门禁腿装的是 5.3 MB 的小包，`[CI 实测 run 31314976975]` 三平台**没有一个**
       * 采到过「下载中」—— 也就是说 B6b 在门禁里**永远**只能报"无从判断"。
       * 那条判据要想真的被验一次，只能借这次大文件下载的窗口。
       * 于是：D1 跑的时候顺手把 downloading 期间的标题收进同一个池子，
       * B6b 的判定挪到 D1 之后。**门禁不填 diagnoseDownload 时这里一行都不执行**，
       * 所以它不会给门禁加任何时间。
       */
      if (s.body.includes('下载中') && !s.body.includes('正在安装')) {
        downloadingMoments += 1;
        toastTitlesWhileDownloading.push(...s.titles);
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

  say(
    `   downloading 采样轮数=${downloadingMoments} · 采到的 Toast 标题=` +
      `${JSON.stringify([...new Set(toastTitlesWhileDownloading)])}`,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * B6b ★ 空过和真过必须分得开
   *
   * 判据没变：**`downloading` 期间 Toast 标题不许出现「安装」二字**
   * （用户看到的字是"正在安装"、进度条却在下载，这是在说一件假的事）。
   *
   * 变的是**它凭什么敢说"过了"**。这条断言此前"绿"过两轮，两轮都是假的：
   *   · 第一轮：那台机器上 `下载中` 从没出现 → 判据的前件为空 → 空过；
   *   · 第二轮：选择器抓到的是**就绪横幅**而不是任务 Toast → 采的字全无关 → 空过。
   * 两次都记成 PASS，于是"下载期间不说安装"这件事**从来没有真的被验过一次**。
   *
   * 所以下面两个前提**任一不满足就报无从判断**，不许落到"通过"那一档：
   *   ① 这一轮真的采到过 downloading（`downloadingMoments > 0`）；
   *   ② 那期间真的读到过**任务 Toast 的标题**（`toastTitlesWhileDownloading` 非空）。
   * ②是关键：选择器再抓错，得到的是**空**，于是这条会亮"无从判断"而不是"通过" ——
   * **抓错元素不再能伪装成好消息。**
   * ───────────────────────────────────────────────────────────────────────── */
  await check('B6b 下载期间 Toast 标题不许出现「安装」二字', () => {
    if (packToInstall === null) undecided('本机没有适用的后端包，压根没起安装');
    if (downloadingMoments === 0) undecided('整轮没采样到 downloading 阶段');
    if (toastTitlesWhileDownloading.length === 0) {
      undecided(
        `downloading 采到 ${downloadingMoments} 轮，但任务 Toast 一个标题都没读到 —— ` +
          `要么 Toast 没渲染，要么选择器又抓错了元素（当前用 job-toaster > job-toast-* > p）`,
      );
    }
    ok(
      toastSaidInstallWhileDownloading === null,
      `还在下载时 Toast 标题就说「安装」了：${toastSaidInstallWhileDownloading}`,
    );
    return `读到 ${toastTitlesWhileDownloading.length} 条标题，都不含「安装」：${JSON.stringify(
      [...new Set(toastTitlesWhileDownloading)].slice(0, 3),
    )}`;
  });

  await check('B7 llm 引导落地页上必须真的有可操作的控件（不是只发生了跳转）', () => {
    ok(
      llmReady.ok === true,
      `等了 ${llmReady.ms} ms，llm 面板（models-llm-tab）都没挂上 —— ` +
        '这一页没加载完，"落地页上没有控件"这句话此刻不成立',
    );
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
  await openPage(page, '/runtime');
  /*
   * ★ 等的是**这一页上真的出现了可点的「安装 …」按钮** —— 那就是 B12 的前提本身。
   *   定值 1800 ms 在慢 runner 上盖不住目录渲染，于是 B12 会报
   *   「/runtime 上没有一个可点的「安装」按钮」—— 一句关于产品的**假指控**。
   */
  const installBtnReady = await until(async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('button')].some(
        (e) => !e.disabled && /^安装\s/.test((e.textContent || '').trim()),
      ),
    ),
  );
  say(
    `   /runtime 上出现可点的「安装 …」按钮=${installBtnReady.ok}，等了 ${installBtnReady.ms} ms`,
  );

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
    /*
     * ★ 等的是"界面说话了"，不是定值 2.5 s：**谓词与 B12 的断言逐字相同**，
     *   所以等到就走、等不到就照旧红 —— 判据没动，动的只是"我肯等多久"。
     *   预算 2.5 s → 8 s：这条断言防的是「静默吞掉」（= 永远不出现），
     *   把预算放宽到 8 s 遮不住它；而 2.5 s 在慢 runner 上遮得住的，
     *   恰恰是"产品其实说了话"这一面 —— 那才是假红。
     */
    await until(
      async () => {
        const now = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
        return FAIL_WORDS.test(now.replace(beforeInstall, ''));
      },
      { timeout: 8_000, interval: 250 },
    );
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

  /*
   * ★ 2026-08-10 改名：这条原来也叫 `B6`。
   *
   * 本文件里 `B6` 同时是两条**毫不相干**的判据：一条是"任务中心的阶段文案"
   * （连同 B6b/B6c 一家），另一条就是这条"安装失败必须说话"。
   * 日志里只印 id，于是读日志的人会把两条当成同一条 —— Manager 自己也差点搞混。
   * （`B7` 有同样的问题：llm 引导落地页 vs 复制诊断信息，一并改成 `B13`。）
   * 判据一个字没改，只是把名字分开：**同名不同物比没有名字更坏**。
   */
  await check('B12 ★ 安装失败时界面必须出现读得懂的话（不许静默吞掉）', () => {
    ok(
      installBtnReady.ok === true,
      `等了 ${installBtnReady.ms} ms，/runtime 上一个可点的「安装 …」按钮都没画出来 —— ` +
        '**这一页没加载完**，不是"目录是空的"',
    );
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
   * 它必须红，才证明 B12 量的是"失败时说话"，而不是"页面上随便有点字"。
   *
   * ★ `[CI 实测 darwin-arm64, run 31364427061]` 这条报了 **MUT-BAD**，而它不是缺陷：
   *   基线取的是 `base1.replace(base0,'')`，**只要这 1.2 秒里页面还在渲染**，
   *   增量里就会混进 `/runtime` 本来就该有的那些状态字 —— 那一页会列
   *   「CUDA/Vulkan/ROCm/Metal/CoreML **不可用**（未安装后端包）」五条，
   *   而 `FAIL_WORDS` 里正好有「不可用」。**慢 runner 上页面画得晚，增量就带上它们。**
   *   于是谓词为真 ⇒ 断言没红 ⇒ 被记成"变异存活"。
   *   **量的不是产品，是渲染时序。**
   *
   * 修法不是放宽谓词（那会把真正的"失败时不说话"一起放过），而是**先让页面静下来**：
   * 连续两次取样文本完全一致才算基线成立；一直静不下来就是**这一轮没量成**，
   * 报"无从判断"，不报"变异存活"。
   */
  await mutation('B12 的证伪能力（没注入故障那轮不该有错误话，同一谓词必须红）', async () => {
    /*
     * ⚠️ 这里**不再**用 `networkidle` 冒充"画完了"，但下面那个静止循环
     *   （连续两次文本一致）**原样保留** —— 它不是"等待"，它就是这条变异的**测量**：
     *   要的正是"页面已经不动了"这个前提本身。同理下面那 1.2 s 也保留（见原注）。
     */
    await openPage(page, '/runtime');
    const textNow = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    let prev = null;
    let settled = false;
    for (let i = 0; i < 40; i++) {
      const now = await textNow();
      if (prev !== null && now === prev) {
        settled = true;
        break;
      }
      prev = now;
      await page.waitForTimeout(300);
    }
    if (!settled) {
      undecided('页面 12 秒内文本一直在变（慢 runner 还在渲染），量不出"静止时不该有错误话"');
    }
    const base0 = prev;
    await page.waitForTimeout(1200);
    const base1 = await textNow();
    const delta = base1.replace(base0, '');
    /*
     * ★ 证据必须**无条件打印**。
     *
     * 上一版我把命中词塞进了 `ok()` 的失败消息里 —— 而这条变异**出问题的那一面
     * 恰恰是 `ok()` 通过**（没红＝MUT-BAD），失败消息永远不会被打出来。
     * `[CI 实测 darwin-arm64, run 31366579943]` 于是又只留下一句"没有变红"。
     * 诊断信息挂在"断言失败"那条路上，就等于在**它最需要说话的那一刻沉默**。
     */
    const hits = [...new Set(delta.match(new RegExp(FAIL_WORDS.source, 'gi')) ?? [])];
    say(
      `   [变异基线] 静止=${settled} 增量长度=${delta.length} 命中词=${JSON.stringify(hits)} ` +
        `增量前 200 字=${JSON.stringify(delta.slice(0, 200))}`,
    );
    /*
     * 页面在这 1.2 秒里**又动了**就无从归因（`/runtime` 有轮询刷新，
     * 状态区本来就会重画，而那一片正当地写着「不可用」——`FAIL_WORDS` 命中的是它）。
     * 前提没构造出来 ⇒ 报无从判断，不报"变异存活"。
     */
    if (base1 !== base0) {
      undecided(
        `基线这 1.2 秒里页面又变了（增量 ${delta.length} 字，命中 ${JSON.stringify(hits)}）——` +
          `无法把"有错误话"归因于注入的故障，这一轮量不成`,
      );
    }
    ok(FAIL_WORDS.test(delta) === true, '没注入故障时界面本来就没有错误话（这条变异本就该红）');
  });

  /* ── 3c. 「复制诊断信息」：成功要出声，失败也要出声 ────────────────────────── */
  hdr('3c. 「复制诊断信息」点完必须出声（Manager 裁决：成功必须出声）');
  await openPage(page, '/diagnostics');
  /*
   * ★ `clickAndObserve` 只**拍快照**，自己不等 —— 所以按钮得先等出来，
   *   否则 B13 报的是「按钮没点到」，而真话是「我来早了」。
   */
  const copyBtnReady = await until(async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('button')].some((e) =>
        (e.textContent || '').includes('复制诊断信息'),
      ),
    ),
  );
  say(`   「复制诊断信息」就绪=${copyBtnReady.ok}，等了 ${copyBtnReady.ms} ms`);
  const copyR = await clickAndObserve(page, { name: '「复制诊断信息」', text: '复制诊断信息' });
  const copyFeedback = await page.evaluate(() => ({
    ok: !!document.querySelector('[data-testid="diagnostics-copy-ok"]'),
    failed: !!document.querySelector('[data-testid="diagnostics-copy-failed"]'),
    fallback: !!document.querySelector('[data-testid="diagnostics-copy-fallback"]'),
  }));
  say(`   反馈：成功=${copyFeedback.ok} 失败=${copyFeedback.failed} 退路=${copyFeedback.fallback}`);

  await check('B13 ★ 「复制诊断信息」点完必须出声（成功或失败都算，沉默不算）', () => {
    ok(
      copyBtnReady.ok === true,
      `等了 ${copyBtnReady.ms} ms，/diagnostics 上「复制诊断信息」都没画出来 —— 这一页没加载完`,
    );
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
  await mutation('B13 的证伪能力（把反馈元素摘掉，同一条断言必须红）', async () => {
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
  await openPage(page, '/notes');
  /*
   * ★ 等**改名入口真的挂进 DOM**（`state: 'attached'` —— 它平时是 `opacity-0`，
   *   等"可见"永远等不到）。定值 1200 ms 等不够时 `count() === 0`，
   *   B8 会报「入口是死的」—— 又一句把"我来早了"说成产品缺陷的话。
   */
  const renameBtnReady = await waitForSel(page, '[data-testid="folder-rename"]');
  say(`   侧栏「重命名」入口就绪=${renameBtnReady.ok}，等了 ${renameBtnReady.ms} ms`);

  /*
   * 改名按钮是 hover 才显形的（`opacity-0 group-hover:opacity-100`），
   * 所以**不能靠可见性去点** —— 用 force 点，模拟鼠标移上去之后的那一下。
   * 这也是为什么它不走通用的 clickAndObserve：那个函数会先要求 visible。
   */
  const renameOpened = await (async () => {
    const btn = page.locator('[data-testid="folder-rename"]').first();
    if ((await btn.count()) === 0) return false;
    await btn.click({ force: true, timeout: 8000 });
    // 等的是就地编辑框真的展开，不是定值 600 ms
    return (await waitForSel(page, '[data-testid="folder-rename-input"]', { timeout: 10_000 })).ok;
  })();
  say(`   点「重命名」后出现输入框 = ${renameOpened}`);

  await check('B8 ★ 文件夹改名有入口，且点了真的展开就地编辑（不是死按钮）', () => {
    ok(
      renameBtnReady.ok === true,
      `等了 ${renameBtnReady.ms} ms，侧栏里连「重命名」按钮都没挂上 —— 这一页没加载完，不是"入口是死的"`,
    );
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
    /*
     * ★ 等的是 **PATCH 真的发出去了**（B9 的判据本身），不是定值 1500 ms。
     *   谓词与断言完全相同：发出了就立刻走，没发出照旧红。
     */
    await until(async () => renameReqs.length > 0, { timeout: 10_000, interval: 150 });
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
  /**
   * ★ 「移动面板到底开没开」的等待预算。**B10 和它的变异必须用同一个值** ——
   *   变异等得比正路短，就成了拿"我等得少"冒充"面板没开"，
   *   那条变异证明的是我的耐心，不是产品。
   */
  const MOVE_PANEL_MS = 10_000;
  let actionsReady = { ok: false, ms: 0 };
  if (imported.uid) {
    await openPage(page, `/notes/${imported.uid}`);
    // 等的是「⋯」菜单入口真的挂上，不是定值 1500 ms
    actionsReady = await waitForSel(page, '[data-testid="note-actions"]');
    say(`   笔记详情页「⋯」入口就绪=${actionsReady.ok}，等了 ${actionsReady.ms} ms`);
  }

  /* ── 笔记移动：入口在笔记自己的「⋯」菜单里 ── */
  const moveOpened = await (async () => {
    try {
      const act = page.locator('[data-testid="note-actions"]').first();
      if ((await act.count()) === 0) return null; // 一条笔记都没有 —— 不算失败，如实说
      await act.click({ timeout: 8000 });
      // 等菜单项出现，不是定值 400 ms
      if (!(await waitForSel(page, '[data-testid="note-move"]', { timeout: MOVE_PANEL_MS })).ok) {
        return false;
      }
      await page.locator('[data-testid="note-move"]').first().click({ timeout: 8000 });
      // 等面板出现，不是定值 900 ms
      return (await waitForSel(page, '[data-testid="note-move-panel"]', { timeout: MOVE_PANEL_MS }))
        .ok;
    } catch (e) {
      say(`   ⚠️ 打开移动面板时出错：${String(e.message).slice(0, 120)}`);
      return false;
    }
  })();
  say(`   点「移动到文件夹」后出现面板 = ${moveOpened}`);

  await check('B10 ★ 笔记「移动到文件夹」有入口且点得开（不是死按钮）', () => {
    ok(
      moveOpened !== null,
      `页面上一条笔记都没有 —— 这一节没有被真的执行（§11）` +
        `（「⋯」入口就绪=${actionsReady.ok}，等了 ${actionsReady.ms} ms；导入 uid=${
          imported.uid ?? '(无)'
        }）`,
    );
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
  /*
   * ── B11 的判据在 2026-08-10 被重写。原来那版**两个方向都是错的**，记在这里。 ──
   *
   * 原判据：
   *     const before = innerText; click(note-move-root); const after = innerText;
   *     moveSpoke = FAIL_WORDS.test(after.replace(before, ''));
   *
   * ① **假红**：`FAIL_WORDS = /失败|错误|重试|无法|不可用|出错|error|failed|retry/i`，
   *    而产品对 `FOLDER_NOT_FOUND` 渲染的是「文件夹不存在 / 它可能刚被删掉了。
   *    侧栏刷新后重新选一个。」——**一个关键词都不含**。
   *    `[实测 jsdom]` 走产品真实路径注入 404：
   *      新增文字 = "文件夹不存在它可能刚被删掉了。侧栏刷新后重新选一个。查看详情"
   *      FAIL_WORDS 命中 = false
   *    也就是说：**产品说话了，这条断言却报「界面一个字都没说」。**
   *    文案写得越好（不吼"错误！"，而是说清发生了什么 + 下一步怎么办），
   *    关键词判据就越判不出来 —— 它在惩罚好文案。
   *
   * ② **假绿**：`after.replace(before, '')` 只在 `before` 是 `after` 的**连续子串**时
   *    才是"新增文字"；页面上任何**无关**文字变了一个字（这一页正躺着一条注定失败的
   *    转写任务，它的状态随时会从「转写中」翻成「失败」），`replace` 就原样返回 `after`，
   *    于是**整页**被拿去匹配 —— 而 zh-CN 里命中 FAIL_WORDS 的词条有 63 条。
   *    `[实测]` 复刻这两种情形：
   *      before ⊆ after  → diff="文件夹不存在…"                 → false（红）
   *      before ⊄ after  → diff=整页（含别处的「失败/重试」）    → true （绿）
   *    **绿的那次和"移动失败"没有半点关系。** 这正是它在门禁里绿、在慢一些的诊断运行里
   *    红的原因：快慢决定了那条无关文字有没有恰好在两次快照之间翻面。
   *
   * → 新判据钉**结构**，两条都必须成立，且都不看具体用词：
   *     (a) 面板**仍然开着**（失败不许静默收起 —— 收起来用户分不清"移好了"还是"被吞了"）；
   *     (b) 面板**内部**出现了一个错误块（`[data-testid="error-block"]`，
   *         同时带 `role="alert"`），且它有非空文字。
   *   "面板内部"是关键：不许被页面别处的错误（比如那条失败的转写任务）顶替。
   */
  let moveSpoke = false;
  let moveDiag = '';
  if (moveOpened === true) {
    /*
     * ⚠️ 点击失败**不许再被 `.catch(() => {})` 吞掉**。
     * 原来吞了之后 `moveSpoke` 保持 false，B11 会报「端点回了 404 而界面一个字都没说」
     * —— 一句**假指控**：请求可能压根没发出去。现在把它记下来单独说。
     */
    let clickErr = '';
    await page.click('[data-testid="note-move-root"]', { timeout: 8000 }).catch((e) => {
      clickErr = String(e.message).slice(0, 120);
    });
    /*
     * ★ 等的是"面板里冒出错误块"（**与 B11 的判据逐字相同**：面板仍开着 +
     *   面板内有 error-block 且文字非空），不是定值 1800 ms。
     *   等到就走；等不到照旧红。这条防的是「静默吞掉」= 永远不出现，
     *   把预算从 1.8 s 放到 8 s 遮不住它，遮住的只是慢 runner 造的假红。
     */
    await until(
      async () =>
        page.evaluate(() => {
          const panel = document.querySelector('[data-testid="note-move-panel"]');
          if (panel === null) return false;
          const el = panel.querySelector('[data-testid="error-block"]');
          return el !== null && (el.textContent || '').replace(/\s+/g, ' ').trim().length > 0;
        }),
      { timeout: 8_000, interval: 200 },
    );
    const probe = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="note-move-panel"]');
      if (!panel) return { panel: false, block: false, text: '' };
      const el = panel.querySelector('[data-testid="error-block"]');
      return {
        panel: true,
        block: el !== null,
        text: ((el && el.textContent) || '').replace(/\s+/g, ' ').trim(),
      };
    });
    moveSpoke = probe.panel === true && probe.block === true && probe.text.length > 0;
    moveDiag =
      (clickErr ? `点击失败：${clickErr}；` : '') +
      `面板还开着=${probe.panel} 错误块=${probe.block} 文字=${JSON.stringify(probe.text.slice(0, 80))}`;
  }
  await page.unroute((u) => {
    try {
      return /^\/api\/notes\/[^/]+\/folder$/.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
  say(`   移动失败（注入 404）后界面说话了吗 = ${moveSpoke}  ${moveDiag}`);

  await check('B11 ★ 移动失败时界面必须说话（目标文件夹已被删）', () => {
    ok(moveOpened === true, '面板没打开，这条无从谈起');
    ok(
      moveSpoke === true,
      '端点回了 404 FOLDER_NOT_FOUND，而移动面板里没有出现错误块 —— 又一处吞错误。' +
        '（判据是结构不是用词：面板仍开着 + 面板内有 [data-testid="error-block"] 且文字非空）',
      moveDiag,
    );
    return '面板里出现了错误块';
  });

  /* 变异①（死按钮那一种）：把「移动到文件夹」变成点不动，B10 必须红。
   *
   * ⚠️ `[CI 实测 run 31629900327, win32-x64]` 这条报的是
   *   **MUT-OK「如期变红：locator.click: Timeout 8000ms exceeded / waiting for
   *   locator('[data-testid="note-actions"]')」** —— 也就是说：
   *   **变异体一次都没装上，整段函数体根本没跑到，却被记成"这条断言有牙齿"。**
   *   成因就写在上面 B10 自己的注释里：`NoteActionsMenu` 只渲染在**笔记详情页**，
   *   而这里 `goto('/notes')` 落在**列表页**上。B10 走的是 `/notes/<uid>`，
   *   它的变异走的却是另一页 —— 两条路从来没对齐过。
   *   `mutation()` 把"抛了"一律读成"如期变红"，于是**导航错页**伪装成了好消息。
   *
   * 修法两条，缺一不可：
   *   ① 落到**和 B10 同一页**（`/notes/<uid>`）；
   *   ② 前提（菜单入口、菜单项）没构造出来就报**无从判断**（MUT-UNKNOWN），
   *      绝不许再落进 MUT-OK —— 这正是本文件为变异立第三态的原意。
   */
  await mutation('B10 的证伪能力（把「移动到文件夹」弄成死按钮，必须红）', async () => {
    if (!imported.uid) undecided('这一轮没建出笔记，变异体无处可装');
    await openPage(page, `/notes/${imported.uid}`);
    if (!(await waitForSel(page, '[data-testid="note-actions"]')).ok) {
      undecided('笔记详情页上没等到「⋯」入口，变异体装不上 —— 这一轮什么都没证明');
    }
    await page.locator('[data-testid="note-actions"]').first().click({ timeout: 8000 });
    if (!(await waitForSel(page, '[data-testid="note-move"]', { timeout: MOVE_PANEL_MS })).ok) {
      undecided('菜单里没等到「移动到文件夹」，变异体装不上 —— 这一轮什么都没证明');
    }
    const installed = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="note-move"]');
      if (el === null) return false;
      el.addEventListener(
        'click',
        (ev) => {
          ev.stopImmediatePropagation();
          ev.preventDefault();
        },
        true,
      );
      return true;
    });
    if (installed !== true) undecided('变异体没挂上 —— 这一轮什么都没证明');
    await page.locator('[data-testid="note-move"]').first().click({ timeout: 8000 });
    // ★ 和 B10 用**同一个**等待预算（MOVE_PANEL_MS）：短了就是拿耐心冒充结论
    const opened = (
      await waitForSel(page, '[data-testid="note-move-panel"]', {
        timeout: MOVE_PANEL_MS,
      })
    ).ok;
    ok(opened === true, '点了「移动到文件夹」，面板没出现 —— 入口是死的');
  });

  /* ── 4. 变异证明：把按钮弄"死"，同一条断言必须红 ───────────────────────── */

  hdr('4. ★ 变异证明：让按钮"还在但点不动"，同一条断言必须红');
  say('   做法：给目标按钮挂一个**捕获阶段**监听器，stopImmediatePropagation + preventDefault。');
  say('   按钮还在、还可见、还可点、样式不变 —— 但点击到不了任何处理器。');
  say('   **产品源码一个字节都没改**（PROTOCOL §10）。');

  await openPage(page, '/models');
  /*
   * ★ 变异体只能装在**已经在 DOM 里**的元素上。定值 1200 ms 等不到那颗按钮时，
   *   `installMutation` 静默什么都不做，随后 `mutR.exists === false`。
   *   曾经这里写的是 `ok()`，而当时 `mutation()` 把"抛了"一律记成 **MUT-OK**，
   *   于是**变异体根本没装上，汇总里却写着"这条断言有牙齿"**。
   *   （和 B1 本身是同一个缺口的两面：那边把"没加载完"报成假红，这边报成假绿。）
   *   现在两头都堵上了：这一族前提走 `undecided()` ⇒ MUT-UNKNOWN（见下面那段），
   *   而 `mutation()` 本身也只认 `AssertionFailed` 才算"如期变红"（`mutation-verdict.mjs`）。
   */
  const mutTargetReady = await waitForSel(page, '[data-testid="models-sources-probe"]');
  const mutInstalled =
    mutTargetReady.ok === true ? await installMutation(page, 'models-sources-probe') : false;
  say(
    `   变异体装上了=${mutInstalled}（按钮就绪=${mutTargetReady.ok}，等了 ${mutTargetReady.ms} ms）`,
  );
  const mutR = await clickAndObserve(page, {
    name: '「立即测速」（已被变异成死按钮）',
    // ★ 与 B1 基线轮**逐字相同**的观测参数。少一个 `ambientWindow`，量的就不是同一件事了。
    testid: 'models-sources-probe',
    ambientWindow: true,
    expectApi: PROBE_EFFECT,
  });
  reportClick(mutR);

  /*
   * ★ `[CI 实测 run 31736237514 win32 / 31833084492 win32 / 31902320145 win32+darwin]`
   *   这条连着三夜报 **MUT-BAD**，而它不是"变异体没装上"：
   *
   *   ```
   *   变异体装上了=true（按钮就绪=true，等了 246 ms）
   *   ── 「立即测速」（已被变异成死按钮）
   *      存在=true 可见=true 禁用=false 文案="立即测速"
   *      点击成功=true
   *      URL 变了=false  DOM 变了=true  /api 请求 0 条      ← win32
   *      **有反应 = true**
   *   ```
   *
   *   按钮**真的死了**（点击到不了任何处理器），而判据量的是"这 1.5 秒里页面动过吗"——
   *   后台自己在动（SSE 推任务进度、`/api/jobs` 5 秒兜底轮询、迟到的首屏查询落地），
   *   于是"有反应=true"，**变异存活**。同一夜 linux 那格判"如期变红"，
   *   靠的只是它恰好静止 —— 三个平台的分歧从头到尾没有一格是产品的差异。
   *
   *   修法两条（都在 `e2e-browser-assertions.mjs` 里，两条都有反向证明）：
   *     ① **空转对照窗**：点之前先量同样长的一段、什么都不点，页面自己干的不算数；
   *     ② **该发生的那件事**：点「立即测速」必须发出 `POST /api/models/sources/probe`。
   *        后台轮询发的是别的端点，凑不出这一条 —— 判决不再取决于运气。
   */
  await mutation('B1 的证伪能力（按钮死了时，同一条断言必须红）', () => {
    /*
     * 前提没构造出来 = 什么都没证明 ⇒ 第三态，不许记成"如期变红"。
     * ⚠️ `exists / visible / clicked` 也是前提，**不是判决** —— 变异体本该让按钮
     *    "还在、还可见、还可点"。它们不成立说明这一轮的现场不是我要的那个现场。
     *    用 `ok()` 会把它们印成"这条断言有牙齿"：`ok()` 抛的是 `AssertionFailed`，
     *    而那正是 `mutation()` 唯一认作"如期变红"的那一种。前提要走 `undecided()`。
     */
    if (mutInstalled !== true) {
      undecided(
        `变异体没装上（按钮就绪=${mutTargetReady.ok}，等了 ${mutTargetReady.ms} ms）—— ` +
          '这一轮既没证明断言有牙齿，也没证明它没有',
      );
    }
    if (mutR.exists !== true) undecided('变异轮里这颗按钮不在页面上 —— 现场不成立，什么都没证明');
    if (mutR.visible !== true) undecided('变异轮里这颗按钮不可见 —— 现场不成立，什么都没证明');
    if (mutR.clicked !== true) {
      undecided(`变异轮里这颗按钮点不动（${mutR.clickError}）—— 现场不成立，什么都没证明`);
    }
    // ★ 判决那一句与 B1 基线**是同一段代码**。
    judgeProbeClick(mutR);
  });

  /*
   * ★ 这里**曾经**有一节「4b. 额外变异：`--mutate <选择器>`」：给任意一个按钮挂上
   *   死按钮变异体、点一下、把观测结果打出来。**它在 CI 里一次都没跑过** ——
   *   `e2e-browser.yml` 的两处调用都不传 `--mutate`（查过全部 31 轮日志，
   *   没有一轮出现过「4b. 额外变异」这一行）。
   *
   *   它想做的事是**人工排查时的一次性工具**：怀疑某个按钮是死的，就现场变异一下
   *   看这条腿抓不抓得住。那个用途今天由 B1/B10/B12/B13 四条常驻变异覆盖，
   *   而且它们**每轮都跑、都有判决**；`--mutate` 那一节**不登记任何 `mutation()` 结果**，
   *   所以它既不制造假绿也不制造假红 —— 它只是死代码。
   *
   *   ⚠️ 删它的理由不是"没用过"，是**它看起来像一层覆盖而实际不是**：
   *   读文件头「用法」那一行的人会以为这条腿有一个可配的变异入口在门禁里生效。
   *   要恢复它，`installMutation()` 还在（B1 用着），加回来是十几行。
   */
} catch (e) {
  failed += 1;
  aborted = true;
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
const undec = results.filter((r) => r.status === 'UNDECIDED' || r.status === 'MUT-UNKNOWN');
say(
  `   断言通过 ${pass} 条 · 变异证明 ${mut} 条 · 失败 ${failed} 条 · 无从判断 ${undec.length} 条`,
);
/*
 * ★ 变异地板：**这一轮至少要有一条变异真的判到 MUT-OK。**
 *
 * ⚠️ 它守的不是产品，是**这条判决链路自己还通不通**。
 *   `MUT-UNKNOWN` 刻意不计入 failed，所以「`ok()` 不再抛 `AssertionFailed` 了」
 *   （改错 import、类型被别的模块实例覆盖、有人把 `ok()` 换回裸 `Error`）
 *   的表现是**四条变异悄悄全变 UNKNOWN，整条腿照样绿** ——
 *   一种比它替换掉的那个假绿更安静的假绿。
 *
 *   单元证明（`selftest-mutation-verdict.mjs`）证的是判据本身，**证不到接线**。
 *   这一条守的正是接线：`ok()` → `AssertionFailed` → `MUT-OK` 这条路还走得通。
 *
 * 判据取"至少 1 条"而不是"4 条"：某条变异在某台 runner 上前提构造不出来
 * （premise ⇒ UNKNOWN）是正当的，钉死条数会造出一盏为合法情况常亮的灯。
 * `[CI 实测]` 近 5 轮三平台每一格都是 3～4 条 MUT-OK —— 地板离现状很远，
 * 只有链路真的断了才会踩到它。
 *
 * 整轮被掐断时让路：那时 `failed` 已经因为"审计中断"加过一次，
 * 再报一条"没有变异判到 MUT-OK"只是在复述同一件事。
 *
 * ★ `mutTotal === 0` 也踩地板（**不是** `mutTotal > 0 && mut === 0`）。
 *   变异**一条都没登记**时，此前的表现是"总表短了几行" —— 而少几行没有人看得见。
 *   `[CI 实测 run 31484205254 win32-x64]` 那一轮 4 条变异一条都没出现（整轮掐断，
 *   已由 `aborted` 兜住）；但**没掐断却一条都没跑到**的路径同样存在，
 *   而它今天连一个字都不会说。缺席不许长得像"没事发生"。
 */
const mutTotal = results.filter((r) => String(r.status).startsWith('MUT-')).length;
if (!aborted && mut === 0) {
  failed += 1;
  say('');
  say(`   ✘ 这一轮登记了 ${mutTotal} 条变异，**没有一条**判到 MUT-OK。`);
  say('     变异证明不计入失败的那两档（前提没构造出来 / 腿炸了）把整套证明吃光了 ——');
  say('     多半是 `ok()` → `AssertionFailed` → `MUT-OK` 这条接线断了，');
  say('     而它断掉的表现恰恰是"什么都不说"。先看上面每条变异各自是哪一档。');
  if (mutTotal === 0) {
    say('     （登记数是 0：变异那几段**根本没跑到**，而缺席在总表里只表现为少几行。）');
  }
}
/*
 * ★ 覆盖面落盘。不看 failed —— 这是展示用的覆盖面计数，不是判定，
 * 红也要如实落盘（与 runtime 腿同一条道理）。
 */
if (UNDECIDED_OUT) {
  mkdirSync(dirname(UNDECIDED_OUT), { recursive: true });
  writeFileSync(UNDECIDED_OUT, `${JSON.stringify({ unknowns: undec.length }, null, 2)}\n`);
  say(`   覆盖面已写到 ${UNDECIDED_OUT}（unknowns=${undec.length}）`);
}
if (undec.length > 0) {
  // 单独列出来：**这些不是通过**。不列的话它们会混在一片绿里被当成覆盖到了。
  say('   ？ 本轮无从判断（这一轮没验到，别当成绿）：');
  for (const r of undec) say(`     · ${r.id} —— ${r.detail}`);
}
/*
 * ★ 「这条腿自己炸了」单独再列一次。
 *
 * 它和「前提没构造出来」同为 MUT-UNKNOWN、同样不计入 failed，但**两者的下一步不同**：
 * 前者是**我们的测试坏了**（选择器、导航、超时预算），要去修测试；
 * 后者往往是**平台差异**，本来就没打算每台机器都构造得出来。
 * 混在一起列，"测试坏了"就会被当成"这台机器没条件"而永远没人去修 ——
 * 而那正是这一版要拆掉的那种沉默（此前它连 UNKNOWN 都不是，是 MUT-OK）。
 */
const crashed = results.filter((r) => r.mutKind === 'crash');
if (crashed.length > 0) {
  say('');
  say(`   ⚠️ 其中 ${crashed.length} 条是**这条腿自己炸了**，不是"这台机器没条件"：`);
  for (const r of crashed) say(`     · ${r.id} —— ${r.detail}`);
  say('     这些要去修**测试**（选择器 / 导航 / 超时预算），不是去修产品，也不是等下一轮。');
}
say('');
say('   ⚠️ 无头浏览器**做不到**的（如实列出，不假装覆盖）：');
say('     · 系统级权限弹窗（麦克风授权）—— headless 里被自动允许/拒绝，测不出真实体验');
say('     · 真实的文件选择对话框、拖拽外部文件');
say('     · 操作系统的通知、托盘、外部程序打开（双击启动器）');
say('     · GPU/驱动相关的真实渲染差异');
process.exit(failed > 0 ? 1 : 0);
