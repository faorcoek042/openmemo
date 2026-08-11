#!/usr/bin/env node
/**
 * e2e-runtime-audit.mjs —— 章程要求 **2.1 / 2.2** 的端到端验收：
 * 「GPU 相关组件都要能通过网页安装配置」「模型浏览/下载/切换/删除都通过网页」。
 *
 * ## 判据从今天起是什么
 *
 * 用户 2026-08-08 下载 v0.2.0 预编译包在真机上用，Windows 双击报错、macOS 被拦、
 * 界面打不开。他的原话：
 *
 * > 「你应该派多路 agent 去在 CI 中运行一遍把各个流程跑通才能给我交付的啊！」
 *
 * 他是对的。此前 CI 只验了「产品能不能被脚本驱动着转出一段文本」。
 * **本脚本的判据是：这条功能面在 CI 上、用预编译包、走产品自己的 HTTP 路径，
 * 端到端真的能用。**
 *
 * 所以四条硬规矩，缺一条这份报告就不算数：
 *
 *   ① **只走 HTTP。** 不 import 产品的任何函数、不读它的内部状态。
 *      判据必须与用户在网页上点出来的那条路**逐字相同** —— 直接调函数能绕开
 *      路由、鉴权、序列化、缓存，而本仓已经栽过一次「函数是对的、端点是坏的」。
 *      （唯一的例外是**故障注入**与**地面真相核对**：注入要动磁盘上的探针二进制，
 *        核对要 stat 真实文件大小。两者都刻意不经过产品，因为它们的意义
 *        正是"不听产品自述"。）
 *   ② **跑预编译包**，解释器用**包自带的 Node**。用户机器上没有 node，
 *      而"没有 node 也能用"正是这个包存在的理由。
 *   ③ **屏蔽宿主 PATH**（照抄 cold-start-audit.mjs 的 shim 手法），
 *      并把"借了宿主几个工具"**报出来**。
 *   ④ **每条关键断言都要有对应的变异证明它会红**（`--mutate`）。
 *      本仓刚栽过两次假绿灯，"断言写了"和"断言有用"不是一回事。
 *
 * ## 安全边界（PROTOCOL §9 / §9-bis，不可协商）
 *
 * 数据目录指针 `~/.local/share/openmemo/datadir.json` 是**全机器共享的一份**。
 * 已经出过一次事故：某轮测试把它改到临时目录，几小时后 Manager 重启 demo，
 * daemon 挂到空壳上，用户的 key / 模型 / 转写记录在界面上**全部"消失"**。
 *
 * 而本脚本要做的事情里，**有一整段就是搬数据目录** —— 它是最有资格重演那场事故的。
 * 所以这里按 §9-bis 的判据（「把它 kill -9 在最坏的那一行，机器上会留下什么」）
 * 做了**三层**，而不是一层：
 *
 *   1. `OPENMEMO_POINTER_FILE` 指到 mkdtemp 出来的临时路径。**模块级设定，窗口为零**，
 *      不依赖任何 `finally` —— 而"清理代码"正是 §9-bis 判定为靠不住的那个东西。
 *   2. **连兜底位置也搬走**：子进程的 `HOME` / `XDG_DATA_HOME` / `APPDATA` /
 *      `USERPROFILE` / `LOCALAPPDATA` 全部指向临时根。也就是说，即便哪天
 *      `OPENMEMO_POINTER_FILE` 这个覆盖被谁"顺手简化"掉了，
 *      `defaultDataDir()` 算出来的兜底路径**仍然落在临时目录里**。
 *      一层防线要靠"别人别改坏"才成立，就不算防线。
 *   3. 跑完**核对真实机器指针的 sha256 + mtime**（`A-POINTER-UNTOUCHED`）。
 *      文件本来不存在的机器上，判据是"它仍然不存在"。
 *
 * ★ 第 2 层对 `--mutate` 尤其重要：变异清单里有一条就是
 *   「让 `pointerFile()` 忽略环境变量、改回硬编码全局位置」。
 *   `scripts/mutation-check.mjs` 第一版**正是栽在这条上** —— 一个用来防事故的工具
 *   复现了那场事故。变异体必须假设是敌对的。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/ci/e2e-runtime-audit.mjs --bundle <包目录> --require-bundle
 * node scripts/ci/e2e-runtime-audit.mjs --bundle <包目录> --phases backends,models
 * node scripts/ci/e2e-runtime-audit.mjs --list-mutations
 * node scripts/ci/e2e-runtime-audit.mjs --bundle <包目录> --mutate M-datadir-default-move
 * ```
 *
 * ## 退出码（调用方按这张表判，别只判"非 0"）
 *
 * | 码 | 含义 | 调用方该怎么读 |
 * |---|---|---|
 * | 0 | 通过。普通模式=断言全绿；`--mutate` 模式=**变异被抓住了** | 真的验过了 |
 * | 1 | **失败**。普通模式=有断言 FAIL；`--mutate` 模式=**变异存活**（断言没牙齿） | 有东西坏了，去修 |
 * | 2 | **跑不起来**：锚点失配、包不存在、参数不对 | 前提没成立，结论无效 |
 * | 3 | **跑起来了，但什么都没证明**：`--mutate` 的目标断言在本机全是 UNKNOWN | 换台机器再验；**不许当成通过** |
 *
 * ★ 3 这一档是 T-63/#65 那轮补的。它原本是 **exit 0** ——
 * 屏幕上诚实地打着「这条变异在这里什么都证明不了」，**而退出码说通过**。
 * 只看退出码的调用方（CI 就是这种调用方）会把它读成"守卫已验证"。
 * 同一轮还有一个更贵的同形教训：`ERR_MODULE_NOT_FOUND` 也是 exit=1，
 * 差点被当成"锚点失配导致的红"——**只看退出码，分不开"我要测的原因"和"别的原因"。**
 * 所以这里给"什么都没证明"单独一个码，而不是把它塞进 0 或 1。
 */

import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  spawnDaemon,
  killTree,
  assertPortFree as sharedAssertPortFree,
} from './launcher-spawn.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WIN = process.platform === 'win32';

/* ══════════════════════════════════════════════════════════════════════════ */
/* 参数                                                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);

const PORT = Number(arg('--port', '19820'));
const BUNDLE = arg('--bundle', null);
const REQUIRE_BUNDLE = has('--require-bundle');
const MASK = !has('--no-mask');
const MUTATE = arg('--mutate', null);
const LIST_MUTATIONS = has('--list-mutations');
/**
 * ★ 覆盖面上报（Manager 2026-08-10 裁决，runtime 腿）：`verify-e2e-attestation.mjs`
 * 只看 artifact 名字判定通过/不通过（不变），但会把 `undecided` 念出来做**建议性**
 * 展示 —— 前提是这条腿真的把数字报出来。这个 flag 只是把下面「23. 汇总」已经
 * 算出来的 `unknowns.length` 落盘成一个小文件，供 `attest` job 跨平台求和后
 * 传给 `emit-e2e-attestation.mjs --undecided`。**只在非变异模式下写**：
 * 变异模式的汇总是另一套语义（targets/wentRed/allUnknown），与"这条腿本轮
 * 有多少条断言无从判断"不是同一个问题。
 */
const UNDECIDED_OUT = arg('--undecided-out', null);
/**
 * 断点续传要真的把一个**下到一半**的下载打断。小包（2–6 MB）在 runner 上
 * 常常还没等我们看见就下完了 —— 那样测的是"我手快不快"，不是产品。
 * 所以它默认关闭，只在带宽便宜的那条腿上开，并且**打断不成就如实报未验证**，
 * 绝不把"没打断成功"写成"续传通过"。
 */
const RESUME_TEST = has('--resume-test');
const PHASES = String(arg('--phases', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALL_PHASES = ['boot', 'hw', 'backends', 'breaker', 'models', 'datadir', 'diag'];
/**
 * 变异模式下**只跑它需要的那几段**（每条变异自己声明）。
 * 理由不是省时间，是**减少噪声**：变异体是坏的，跑到无关的阶段只会产生
 * 一堆与判定无关的红，而那些红会让人分不清"变异被抓住了"和"变异把别的东西也弄坏了"。
 * 显式给了 `--phases` 就听显式的。
 */
const EFFECTIVE_PHASES = PHASES.length > 0 ? PHASES : [];
const wantPhase = (p) => {
  if (EFFECTIVE_PHASES.length > 0) return EFFECTIVE_PHASES.includes(p);
  if (mutationPhases) return mutationPhases.includes(p);
  return ALL_PHASES.includes(p);
};
/** 由下面的变异查找填上（清单定义在后面，这里先占位）。 */
let mutationPhases = null;

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(96));
  say(`── ${s}`);
  say('─'.repeat(96));
};

/* ══════════════════════════════════════════════════════════════════════════ */
/* 断言收集器                                                                  */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每条断言有 **id**，因为变异清单是按 id 指名道姓的：
 * 「把 X 改坏 ⇒ `A-DATADIR-SWITCH-ONLY` 必须变红」。
 * 没有 id 的话，变异只能证明"有*某条*红了"，而那对**这一条**断言毫无意义 ——
 * 本仓栽过的第二种假绿灯正是这个形状（红的是别的东西）。
 */
const results = [];
function assert(id, ok, detail) {
  results.push({ id, status: ok ? 'PASS' : 'FAIL', detail: String(detail) });
  say(`   ${ok ? '✔' : '✘'} ${String(id).padEnd(30)} ${detail}`);
  return ok;
}
/** 前提在本平台/本 runner 上构造不出来 —— 如实记 UNKNOWN，**绝不当成通过**。 */
function unknown(id, why) {
  results.push({ id, status: 'UNKNOWN', detail: String(why) });
  say(`   ? ${String(id).padEnd(30)} UNKNOWN — ${why}`);
}
/** 观测项：只打印，不参与红绿。有些事实值得说，但不该决定红绿。 */
function note(msg) {
  say(`   ${msg}`);
}

/** 真实缺陷：记下来，单独汇总。**不改退出码** —— 它是产品的问题，不是本脚本的判据。 */
const findings = [];
function finding(title, detail) {
  findings.push({ title, detail });
  say(`   ⚠ 发现缺陷：${title}`);
  for (const line of String(detail).split('\n')) say(`       ${line}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 变异清单                                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每条变异 = 「把某个安全性质拿掉 ⇒ 指定的那条断言必须变红」。
 *
 * 锚点是**源文本**不是行号（照 `scripts/mutation-check.mjs` 的判据：
 * 行号锚的清单几天就烂，然后开始报假红，而假红和假绿一样贵）。
 * 找不到锚点、或找到多处 → **当场报错**，绝不猜一个位置改下去。
 *
 * `file` 是**相对包内某处的后缀**，在包里递归找唯一匹配 —— 包的内部布局
 * （`app/daemon/dist/…` / `app/node_modules/@openmemo/…`）不该被抄进这里，
 * 抄了就等于把两份布局知识钉死在两个文件里。
 */
const MUTATIONS = [
  {
    id: 'M-datadir-default-move',
    file: 'http/rest/storage.js',
    find: "move: hasNew ? rec['moveExisting'] : hasOld ? rec['move'] : false,",
    replace: "move: rec['move'] !== false,",
    proves: ['A-DATADIR-SWITCH-ONLY', 'A-DATADIR-DEFAULT-NOMOVE'],
    phases: ['boot', 'datadir'],
    why: '把 T-174 那个真 bug 原样种回去：只读旧键名 `move`、缺省=搬。用户取消勾选「一并移动」照样被搬走几十 GB，且不可逆',
  },
  {
    id: 'M-datadir-loose-envelope',
    file: 'http/rest/storage.js',
    find: 'const unknown = Object.keys(rec).filter((k) => !KNOWN_FIELDS.has(k));',
    replace: 'const unknown = [];',
    proves: ['A-DATADIR-UNKNOWN-FIELD'],
    phases: ['boot', 'datadir'],
    why: '写错字段名被静默忽略 ⇒ 缺省值替用户做掉那个不可逆的决定。这正是 T-174 的成因本身',
  },
  {
    id: 'M-freedbytes-fake',
    file: 'downloader/dist/store.js',
    find: 'freed += f.bytes;',
    replace: 'freed += 1024;',
    proves: ['A-FREEDBYTES-REAL'],
    phases: ['boot', 'models'],
    why: '「释放了多少空间」变成编的。用户删了 3 GB 模型，界面告诉他释放了几 KB —— 或者反过来',
  },
  {
    id: 'M-breaker-no-retryat',
    file: 'runtime/dist/probe/runProbe.js',
    find: 'retryAt: new Date(now.getTime() + breakerCooldownMs(consecutiveFailures)).toISOString(),',
    replace: 'retryAt: null,',
    proves: ['A-BREAKER-RETRYAT'],
    phases: ['boot', 'backends', 'breaker'],
    why: 'T-173 之前的死锁原样回来：跳闸没有到期时刻 ⇒ 永远不再探测 ⇒ GPU 加速"就是不工作"且零报错',
  },
  {
    id: 'M-breaker-permanent',
    file: 'runtime/dist/probe/runProbe.js',
    find: 'if (Number.isNaN(due) || now.getTime() >= due)',
    replace: 'if (false)',
    proves: ['A-BREAKER-HEAL'],
    phases: ['boot', 'backends', 'breaker'],
    why: '冷却到期也不放半开那一发 ⇒ 拉黑是永久的。故障修好了产品也永远发现不了',
  },
  {
    id: 'M-uninstall-noop',
    file: 'http/rest/backends.js',
    find: "await state.store.removeManifest('backend', id);",
    replace: '/* mutation: 不真的卸载 */',
    proves: ['A-UNINSTALL-GONE'],
    phases: ['boot', 'backends'],
    why: '卸载返回 204 但东西还在。用户点了卸载、界面刷新后包又出现了 —— T-149 同一形状的老朋友',
  },
  {
    id: 'M-model-inuse-guard-off',
    file: 'http/rest/models.js',
    find: "sendError(res, 409, 'MODEL_IN_USE'",
    replace: "sendJson(res, 200, { mutation: true }) || sendError(res, 409, 'MODEL_IN_USE'",
    proves: ['A-MODEL-DELETE-ACTIVE-REFUSED'],
    phases: ['boot', 'models'],
    why: '正在用的模型也能删 ⇒ 下一次转写直接失败，而失败点离用户的动作已经隔了很远',
  },
  {
    id: 'M-driver-lie',
    file: 'runtime/dist/backends/manager.js',
    /*
     * ★ 变异要**关掉 T-168 那条分支**，让控制流落到最后那句真正的
     *   「driver missing or too old」上 —— 那才是修复前的行为。
     *
     * `[CI 实测 run 31250206184]` 第一版改的是分支里那句字符串的**头一段**，
     * 结果拼接表达式的后半段又把值覆盖回去了 ⇒ 最终文案里根本没有"driver"，
     * 断言合理地保持绿色，**变异存活**。
     * 一条改了等于没改的变异比没有变异更糟：它会让人以为这条断言被验证过。
     */
    find: 'else if (!probed) {',
    replace: 'else if (false) {',
    proves: ['A-CPU-NO-DRIVER-LIE'],
    phases: ['boot', 'backends'],
    /*
     * ★ 这条变异**只在装得上两个后端包的平台上有意义** —— 它要的前提是
     *   「一个包装着、而这次探测没加载它」。Linux/Windows 的 runner 上
     *   加速包因为没有 GPU 硬件证据装不上，前提构造不出来，
     *   那时断言本身是 UNKNOWN，变异当然也证明不了什么。**这不是缺陷，是如实报**。
     */
    requiresTwoPacks: true,
    why: 'T-168 修掉的那句谎话回来：用户显式选了 CPU，他那块好好的加速包被报成「驱动缺失或过旧」，把他支去修一个根本不存在的故障',
  },
  {
    id: 'M-active-partial-load',
    file: 'http/rest/state.js',
    find: 'for (const role of MODEL_ROLES) {',
    replace: "for (const role of ['asr', 'llm']) {",
    proves: ['A-MODEL-SWITCH-PERSISTS'],
    phases: ['boot', 'models'],
    why: '把本轮实测抓到的那个真缺陷种回去：写全部 7 个 role、只读回 asr/llm ⇒ 用户选的 VAD 每次重启都被静默清空，而产品装完组件后还会主动请他重启',
  },
  {
    id: 'M-stale-hardware-snapshot',
    file: 'http/rest/backends.js',
    find: 'await state.freshHardware();',
    replace: '/* mutation: 回到启动时那份快照 */',
    proves: ['A-ACCEL-SWITCH'],
    phases: ['boot', 'backends'],
    why: '把要求 2.1 的死胡同种回去：硬件快照停在启动那一刻 ⇒ 用户在网页上装完加速后端，点"启用"得到 409「backend package not installed」，而包就是他刚装的',
  },
  {
    id: 'M-mask-bypassed',
    file: 'pipeline/dist/tools.js',
    find: '            if (await isExecutable(candidate))\n                return candidate;',
    /*
     * ★ 必须返回一个**真实存在且可执行**的宿主路径，不能是编出来的。
     *   第一版返回 `/usr/local/host-only/<name>`（不存在），`[CI 实测 run 31273191033]`
     *   **变异存活** —— 那个路径多半在后续装配里被当作"工具不可用"丢掉了，
     *   于是它根本没进到 selfcheck 的 `borrowed` 分类里，断言自然是绿的。
     *   一条改了等于没改的变异比没有变异更糟：它会让人以为这条断言被验证过。
     *   `/bin/sh` 在 POSIX runner 上必然存在、可执行，且既不在 shim 里也不在包里 ——
     *   正是这条断言要抓的形状。（变异作业只在 ubuntu 上跑全量，故 POSIX 即可。）
     */
    replace: "            if (await isExecutable(candidate))\n                return '/bin/sh';",
    proves: ['A-NO-HOST-BORROW-REAL'],
    phases: ['boot', 'diag'],
    why: '产品绕过 shim、去够宿主机器上的东西 —— 这条腿最核心的前提（"干净机器上也能用"）当场失效，而没有这条断言它是静默的',
  },
  {
    id: 'M-path-never-consulted',
    file: 'pipeline/dist/tools.js',
    find: 'const fromPath = async (name) => {',
    replace: 'const fromPath = async (_name) => { if (1) return null;',
    proves: ['A-MASK-EFFECTIVE'],
    phases: ['boot', 'diag'],
    why: '产品根本不查 PATH ⇒ 屏蔽**观测不到**。这正是本轮栽过的那种形态：屏蔽从来没生效，而输出与"生效了"一模一样',
  },
  {
    id: 'M-pointer-hardcoded',
    file: 'config/paths.js',
    find: "return process.env['OPENMEMO_POINTER_FILE'] ?? join(defaultDataDir(), 'datadir.json');",
    replace: "return join(defaultDataDir(), 'datadir.json');",
    proves: ['A-POINTER-EXTERNAL'],
    phases: ['boot', 'datadir'],
    /*
     * ⚠️ **这条变异是敌对的**：它让 daemon 去写"全局位置"。
     *   本脚本的第 2 层防线（假 HOME / XDG_DATA_HOME / APPDATA）就是为它准备的 ——
     *   `defaultDataDir()` 因此仍然落在临时根里，真实机器指针一个字节都不会被碰。
     *   `scripts/mutation-check.mjs` 第一版没有这层，跑完把用户的指针写坏了。
     */
    why: '指针重定向被"顺手简化"掉 ⇒ 任何一次测试搬迁都会写机器级状态，重演 T-142 那场"用户数据在界面上消失"的事故',
  },
];

/*
 * `--list-mutation-ids` 只吐 id，一行一个。
 * 存在的理由是**单一事实来源**：workflow 要挨个跑这些变异，
 * 而把 id 列表抄进 YAML 就等于第二份清单 —— 加一条变异时忘了同步，
 * 表现是"少跑了一条"而不是"报错"，正好是本仓最擅长长期存活的那种缺陷。
 */
if (has('--list-mutation-ids')) {
  for (const m of MUTATIONS) console.log(m.id);
  process.exit(0);
}

if (LIST_MUTATIONS) {
  say('变异清单（--mutate <id>）：');
  for (const m of MUTATIONS) {
    say(`  ${m.id.padEnd(28)} 证明 ${m.proves.join(', ')}`);
    say(`  ${' '.repeat(28)} 坏了会怎样：${m.why}`);
  }
  process.exit(0);
}

const mutation = MUTATE ? MUTATIONS.find((m) => m.id === MUTATE) : null;
if (MUTATE && !mutation) {
  console.error(`✘ 没有这条变异：${MUTATE}\n可用：\n  ${MUTATIONS.map((m) => m.id).join('\n  ')}`);
  process.exit(2);
}
if (mutation) mutationPhases = mutation.phases;

/**
 * ★ `--mutate` **必须**配 `--bundle`。
 *
 * 不是为了统一入口，是 PROTOCOL §10：反向验证不许在共享工作树里做 ——
 * 变异体要被写进磁盘才能被加载，而没有包就只剩仓库的 `dist/` 可写，
 * 那期间任何一个别的 agent 跑 `pnpm -r test` 都会撞上几条无法解释的红，
 * 然后去查一个根本不存在的 bug（本仓已经发生过一次，25 条）。
 * 有了包就有了可复制的对象，变异跑在 mkdtemp 里的副本上，别人看不见。
 */
if (mutation && !BUNDLE) {
  console.error('✘ --mutate 必须配 --bundle：变异只能跑在包的独立副本上（PROTOCOL §10）。');
  process.exit(2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 0. 真实机器指针：先拍照                                                      */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * 真实指针的位置**必须自己算**，不能问产品 —— 问产品等于让被告自证清白，
 * 而"产品把这个位置算错了"恰恰是要防的那件事。
 */
function realPointerPath() {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(
      process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
      'OpenMemo',
      'datadir.json',
    );
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenMemo', 'datadir.json');
  }
  return join(
    process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'),
    'openmemo',
    'datadir.json',
  );
}

function pointerSnapshot() {
  const p = realPointerPath();
  try {
    const st = statSync(p);
    return {
      path: p,
      exists: true,
      sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
      mtimeMs: Math.round(st.mtimeMs),
      size: st.size,
    };
  } catch {
    return { path: p, exists: false, sha256: null, mtimeMs: null, size: null };
  }
}

const POINTER_BEFORE = pointerSnapshot();

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. 临时根 + 屏蔽宿主工具                                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

/** ★ `mkdtemp` 不是"随便找个目录"：名字不可预测 ⇒ 两条并发的腿不会撞在一起。 */
const ROOT = mkdtempSync(join(tmpdir(), 'openmemo-e2e-runtime-'));
const DATA_DIR = join(ROOT, 'data');
const POINTER = join(ROOT, 'pointer.json');
const FAKE_HOME = join(ROOT, 'home');
const MASK_BIN = join(ROOT, 'maskbin');
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });

const HOST_TOOLS = [
  'ffmpeg',
  'ffprobe',
  'yt-dlp',
  'youtube-dl',
  'whisper-cli',
  'sqlite3',
  'python3',
];
const PATHEXT = IS_WIN ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
function which(tool, pathStr = process.env.PATH ?? '') {
  for (const dir of pathStr.split(delimiter).filter(Boolean)) {
    for (const ext of PATHEXT) {
      const full = join(dir, tool + ext);
      try {
        accessSync(full, fsConstants.X_OK);
        return full;
      } catch {
        /* 下一个 */
      }
    }
  }
  return null;
}

let PATH_FOR_DAEMON = process.env.PATH ?? '';
function setUpMasking() {
  hdr('1. 宿主基线 + 屏蔽（"借用"必须可见，而不是被消除）');
  const baseline = {};
  for (const t of HOST_TOOLS) {
    baseline[t] = which(t);
    say(`   ${t.padEnd(14)} ${baseline[t] ?? '(不在 PATH 上)'}`);
  }
  if (!MASK) {
    say('   ⚠️ --no-mask：这一轮的"能用"不能当证据。');
    return baseline;
  }
  mkdirSync(MASK_BIN, { recursive: true });
  for (const t of HOST_TOOLS) {
    if (IS_WIN) {
      // Windows 上无扩展名的 `#!/bin/sh` 文件**不是可执行文件**，写 .cmd 才挡得住 PATH 查找。
      writeFileSync(
        join(MASK_BIN, `${t}.cmd`),
        `@echo off\r\necho E2E-RUNTIME: host '${t}' was invoked - MASKED shim 1>&2\r\nexit /b 127\r\n`,
      );
      /*
       * ★ **`.exe` 也要写，否则 Windows 上这层屏蔽等于不存在。**
       *
       * `packages/pipeline/src/tools.ts` 的 `fromPath()` 拼的是
       * `join(dir, exe(name))`，而 `exe()` 在 win32 上**写死加 `.exe`** ——
       * 它根本不看 PATHEXT，所以 `.cmd` 和无扩展名那两个 shim 它一个都找不到。
       *
       * `[CI 实测 run 31249873183]` windows 那条腿上 `A-MASK-EFFECTIVE` 当场红：
       * 「没有任何工具落在 shim 上」。当时 runner 恰好也没装 ffmpeg，
       * 所以**屏没屏蔽的输出一模一样** —— 这正是那条反向守卫存在的理由，
       * 没有它，一个从未生效的屏蔽会一直绿着。
       *
       * 内容随便（产品只 `access(X_OK)` 判存在，真执行时才炸），
       * 但要能被找到。`cold-start-audit.mjs` 有同一个缺口，本轮只修我这条腿，
       * 那边归它自己的作者改（不动别人的交付物，PROTOCOL §1.3）。
       */
      writeFileSync(
        join(MASK_BIN, `${t}.exe`),
        `E2E-RUNTIME MASKED shim for '${t}' — not a real executable\r\n`,
      );
    }
    const shim = join(MASK_BIN, t);
    writeFileSync(
      shim,
      `#!/bin/sh\necho "E2E-RUNTIME: host '${t}' was invoked — MASKED shim" >&2\nexit 127\n`,
    );
    try {
      chmodSync(shim, 0o755);
    } catch {
      /* Windows 上是空操作 */
    }
  }
  PATH_FOR_DAEMON = `${MASK_BIN}${delimiter}${PATH_FOR_DAEMON}`;
  say('');
  say(`   已屏蔽 ${HOST_TOOLS.length} 个名字：${MASK_BIN}`);
  say('   shim 能通过 access(X_OK) ⇒「产品会不会去借」这个行为照常发生，');
  say('   借到的东西一执行就带 E2E-RUNTIME 标记失败 —— **借用变可见，不是被消除**。');
  return baseline;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. 预编译包                                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/** 在包里按后缀找唯一匹配的文件。找不到 / 找到多个都**当场报错**，绝不猜。 */
function findOne(root, suffix) {
  const want = suffix.split('/').filter(Boolean);
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        const parts = p.split(/[\\/]/);
        const tail = parts.slice(-want.length);
        if (tail.length === want.length && tail.every((s, i) => s === want[i])) hits.push(p);
      }
    }
  };
  walk(root, 0);
  if (hits.length !== 1) {
    throw new Error(
      `在 ${root} 里按后缀 "${suffix}" 找到 ${hits.length} 个匹配（要求恰好 1 个）：\n  ${hits.join('\n  ')}`,
    );
  }
  return hits[0];
}

let BUNDLE_DIR = BUNDLE;
if (mutation && BUNDLE_DIR) {
  /*
   * ★ PROTOCOL §10：**反向验证不许在共享工作树里做。**
   *   「最终状态干净」救不了「过程中别人跑了一次」。所以变异跑在包的**独立副本**上，
   *   原包一个字节不动 —— 别的腿此刻可能正拿同一个包做别的验证。
   */
  const copy = join(ROOT, 'bundle-mutated');
  cpSync(BUNDLE_DIR, copy, { recursive: true });
  BUNDLE_DIR = copy;
}

const NODE_BIN = BUNDLE_DIR
  ? join(BUNDLE_DIR, 'runtime', IS_WIN ? 'node.exe' : 'node')
  : process.execPath;

if (REQUIRE_BUNDLE && !BUNDLE_DIR) {
  console.error('✘ --require-bundle：本轮必须跑预编译包，但没有给 --bundle。');
  console.error(
    '  （不给就会静默回退到源码树 dist —— 那样绿灯证明的是仓库，不是用户下载的那个包。）',
  );
  process.exit(2);
}
if (BUNDLE_DIR && !existsSync(NODE_BIN)) {
  console.error(`✘ 包里没有自带的 Node 运行时：${NODE_BIN}`);
  process.exit(2);
}

/* ── 变异注入（只对副本）───────────────────────────────────────────────────── */
function applyMutation() {
  const target = findOne(BUNDLE_DIR, mutation.file);
  const src = readFileSync(target, 'utf8');
  const n = src.split(mutation.find).length - 1;
  if (n !== 1) {
    console.error(`✘ 变异锚点在 ${target} 里出现 ${n} 次（要求恰好 1 次）：\n  ${mutation.find}`);
    console.error('  锚点失效比变异存活更值得查 —— 它意味着这条变异从此什么都没测。');
    process.exit(2);
  }
  writeFileSync(target, src.replace(mutation.find, mutation.replace));
  say(`   已注入变异 ${mutation.id} → ${target}`);
  say(`   坏了会怎样：${mutation.why}`);
  say(`   必须变红的断言：${mutation.proves.join(', ')}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. daemon 生命周期（全部走 HTTP，绝不 pkill）                                */
/* ══════════════════════════════════════════════════════════════════════════ */

const childEnv = {
  ...process.env,
  /*
   * ⚠️ 这里放的是**占位**。真正生效的 PATH 在 `startDaemon()` 里现取 ——
   *
   * 第一版就在这里写 `PATH: PATH_FOR_DAEMON`，而这个对象是**模块级**求值的，
   * 早于 `setUpMasking()` 把 shim 目录插到前面。于是：日志一本正经地打印
   * 「已屏蔽 7 个名字」，daemon 拿到的却是**没屏蔽的** PATH。
   *
   * 后果是这条腿最不该出的那一种：**屏蔽看起来做了，其实一次都没做**。
   * 而它在 GitHub 的 ubuntu runner 上永远不会显形 —— 那台机器本来就没有 ffmpeg，
   * 借不到东西，屏没屏蔽的输出一模一样。是本机（/usr/bin/ffmpeg 真实存在）
   * 让 `A-NO-HOST-BORROW` 当场红了，才把它翻出来。
   *
   * 判据照 PROTOCOL 的老规矩：不是"记得别写错顺序"，而是**让顺序不可能错** ——
   * spawn 的那一刻现算，那时屏蔽必然已经发生。
   */
  PATH: process.env.PATH ?? '',
  OPENMEMO_AUTH: 'none',
  // ★ 第 1 层防线：指针重定向。模块级设定，窗口为零。
  OPENMEMO_POINTER_FILE: POINTER,
  /*
   * ★ 第 2 层防线：连**兜底位置**也搬进临时根。
   *   `defaultDataDir()` 读的就是这几个变量（`config/paths.ts`）。
   *   第 1 层被谁改坏时，写下去的东西仍然落在 ROOT 里 —— 而不是用户的家目录。
   */
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  XDG_DATA_HOME: join(FAKE_HOME, '.local', 'share'),
  XDG_CONFIG_HOME: join(FAKE_HOME, '.config'),
  XDG_CACHE_HOME: join(FAKE_HOME, '.cache'),
  APPDATA: join(FAKE_HOME, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(FAKE_HOME, 'AppData', 'Local'),
  ...(BUNDLE_DIR
    ? {
        // ⚠️ 归**启动器**设（见 launcher-spawn.mjs）：预设 = 又把启动器架空一次。
      }
    : {}),
};
// `OPENMEMO_DATA_DIR` **必须不存在**：它的优先级高于指针，设了就等于把
// 「搬完之后重启会去哪」这个问题的答案提前写死，整段数据目录测试就成了空转。
delete childEnv.OPENMEMO_DATA_DIR;

let proc = null;
const daemonLogs = [];

/** 写指针 = 告诉产品"数据目录在哪"。这是产品自己的机制，不是后门。 */
function seedPointer(dataDir) {
  writeFileSync(POINTER, JSON.stringify({ dataDir, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * ★ PROTOCOL §11：**起服务之前先证明这个端口是空的。**
 *
 * 判据是「一个绿灯必须能追溯到**是我这次启动的那个东西**给的」。
 * 本仓已经三次栽在残留进程上：泄漏的 daemon 占着端口，于是
 * 「被 Gatekeeper 拒掉的包」被报成「界面可达 HTTP 200」、
 * 「自己拉起的那个早死了」被报成「0.5 秒就绪」。
 *
 * 端口不空就**当场判失败**，绝不继续跑下去拿一个无意义的绿。
 */
async function assertPortFree(label) {
  /*
   * 判据用共享实现（`launcher-spawn.mjs`），**报告仍走本腿自己的 assert 框架** ——
   * 这条腿要把失败记成 `A-PORT-FREE` 这个断言 id，那是它真正需要的差异。
   * 统一意图，不统一拼写（Manager 2026-08-09 裁决 R-2）。
   *
   * ⚠️ 本地那份此前属于"只问 HTTP"那一类：`[实测]` 看不见「bind 住但不答 HTTP」
   * 的占用者 —— 而那正是残留进程正在关闭时的样子。
   */
  try {
    await sharedAssertPortFree(PORT, { label });
  } catch (e) {
    assert('A-PORT-FREE', false, e.message);
    throw e;
  }
  return true;
}

/**
 * 按 **pid 收整棵进程树**（§11）。**不许 `pkill -f`** —— 模式匹配会打到别人的进程。
 *
 * Windows 上 `child.kill()` 杀不掉 `cmd.exe` 底下的 `node.exe`，要 `taskkill /T`；
 * POSIX 上我们没用 shell 包一层，所以直接按 pid 杀就是同一个进程。
 */

async function startDaemon(label) {
  await assertPortFree(label);
  /*
   * ★★ 走**启动器**：这条腿验的是 2.1/2.2（网页检测硬件 → 推荐后端 → 装 → 自检），
   *   而"第一屏六个后端全是 probe did not complete"正是**只有启动器才设**的
   *   `OPENMEMO_BUNDLED_PROBE_DIR` 在管的事。直接起入口，这条腿就测不到它要测的东西。
   */
  const _started = spawnDaemon({
    bundleDir: BUNDLE_DIR,
    repoRoot: REPO,
    args: ['--port', String(PORT)],
    // ★ PATH 在这一刻现取（见 childEnv 上面那段）：屏蔽必然已经发生。
    env: { ...childEnv, PATH: PATH_FOR_DAEMON },
  });
  say(`   起法：${_started.note}`);
  proc = _started.proc;
  proc.stdout.on('data', (d) => daemonLogs.push(String(d)));
  proc.stderr.on('data', (d) => daemonLogs.push(String(d)));
  const h = await waitHealth(120);
  if (!h) {
    say(`   [${label}] ✘ daemon 没起来。它最后的输出：`);
    say(tail(daemonLogs, 40));
    // §11：起不来也要按 pid 把它收干净，否则它会占着端口毒化下一条腿
    killTree(proc?.pid);
    throw new Error('daemon did not start');
  }
  say(`   [${label}] 起来了：pid=${h.pid} dataDir=${h.dataDir} version=${h.version}`);
  return h;
}

/** 等 `/api/health` 到 200 且 `ready`。**判据是 ready，不是端口通** —— 见 server.ts 的 503 分支。 */
async function waitHealth(maxTries = 120, expectPidNot = null) {
  for (let i = 0; i < maxTries; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = await res.json();
        if (body.ready === true && (expectPidNot === null || body.pid !== expectPidNot))
          return body;
      }
    } catch {
      /* 还没起来 */
    }
  }
  return null;
}

/** 走产品自己的重启端点。**不 kill 进程** —— 用户点的就是这个按钮。 */
async function restartViaHttp(reason) {
  const before = await j('/api/health');
  const oldPid = before.body?.pid ?? null;
  const r = await j('/api/daemon/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (r.status !== 202) throw new Error(`POST /api/daemon/restart → HTTP ${r.status}`);
  /*
   * 新进程是 `detached` 起的（main.ts 的 restart()），所以我们的 stdio 管子接不到它。
   * 这不是缺陷，是产品的真实形态 —— 判据换成"pid 变了且 ready"，那本来就是更强的判据。
   */
  proc = null;
  const h = await waitHealth(120, oldPid);
  if (!h) throw new Error(`重启后 daemon 没有回来（旧 pid=${oldPid}）`);
  return { oldPid, newPid: h.pid, health: h };
}

/** 走产品自己的关停端点。**PROTOCOL 明令禁止 `pkill -f`**，这里也不需要它。 */
async function shutdownViaHttp() {
  try {
    await j('/api/daemon/shutdown', { method: 'POST' });
  } catch {
    /* 已经死了 */
  }
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    } catch {
      return true;
    }
  }
  /*
   * §11 兜底：HTTP 关不掉就**按 pid 收整棵树**。
   * 留一个占着端口的孤儿，下一条腿（或下一次 CI）就会拿到一个
   * 追溯不到自己启动过程的"绿灯"。
   */
  killTree(proc?.pid);
  await sleep(500);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (arr, n) =>
  arr
    .join('')
    .split('\n')
    .slice(-n)
    .map((l) => `      ${l}`)
    .join('\n');

/**
 * HTTP 客户端。带重试是因为 Node 全局 fetch 的 keep-alive socket 被对端回收后复用
 * 会偶发 `fetch failed`（cold-start-audit 真跑里出现过，daemon 是活着的）。
 * 重试的是**客户端的脆弱**，不是在掩盖产品失败：5 次都失败仍然抛出去。
 */
async function j(path, init) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw new Error(`${path}: ${lastErr?.message ?? 'fetch failed'}（已重试 5 次）`);
}

/**
 * 等一个 job 到终态。
 * ★ 字段叫 **`jobId`**（不是 `id`/`uid`）—— cold-start-audit 为此改了四版。
 *   三个名字都收，但**绝不回退到"随便哪个 job"**：认不出就如实报认不出。
 */
async function waitForJob(jobId, timeoutSec = 900) {
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(1000);
    const jr = await j(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (jr.status !== 200) return { state: 'poll-error', detail: `HTTP ${jr.status}` };
    const job = jr.body?.job ?? jr.body;
    const gotId = job?.jobId ?? job?.uid ?? job?.id;
    if (!job || gotId !== jobId) {
      return { state: 'wrong-job', detail: `要 ${jobId}，拿到 ${gotId}` };
    }
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      return {
        state: job.state,
        detail: job.error ? JSON.stringify(job.error).slice(0, 400) : '',
        job,
      };
    }
  }
  return { state: 'timeout', detail: `${timeoutSec}s 内没到终态` };
}

/* ── SSE：`freedBytes` 只在事件里，HTTP 204 没有 body ──────────────────────── */

/**
 * `DELETE /api/models/:id` 返回 **204 无 body**，`freedBytes` 只出现在
 * `model.removed` 事件里。也就是说：**不订阅 SSE 就根本看不到这个值**，
 * 而"它是不是编的"正是本轮要回答的问题之一。
 */
function openEvents() {
  const ac = new AbortController();
  const events = [];
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.startsWith('data:')) {
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch {
              /* 心跳之类的非 JSON 行，忽略 */
            }
          }
        }
      }
    } catch {
      /* abort 是正常收尾 */
    }
  })();
  return { events, close: () => (ac.abort(), done) };
}

/* ── 地面真相：不听产品自述，自己去 stat ──────────────────────────────────── */

/**
 * 递归实测字节数。**这是 `freedBytes` 那条断言的对照组** —— 判据不能来自被测方。
 *
 * ★ **必须按 inode 去重**，否则这个"地面真相"自己就是错的。
 *   产品把 blob 硬链到 `by-name/<role>/<id>/…`（一份内容、两个路径），
 *   而"释放了多少磁盘空间"问的是**内容**，不是路径数。
 *   第一版没去重，于是实测减少量恰好是 `freedBytes` 的两倍，
 *   把一个**正确**的 `freedBytes` 判成了"编的" —— 一次差点被写进报告的假红。
 *   （`du` 默认就按 inode 去重，所以手工核对时看不出这个差异 ——
 *     这正是"两个工具答案不同、而我以为它们在回答同一个问题"的经典形状。）
 *   Windows 上 `ino` 不可靠（常为 0），那里退回按路径求和：
 *   该平台上 store 不建硬链，两者本来就相等。
 */
function duBytes(dir) {
  let total = 0;
  const seen = new Set();
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const st = statSync(p);
          if (st.ino) {
            const key = `${st.dev}:${st.ino}`;
            if (seen.has(key)) continue;
            seen.add(key);
          }
          total += st.size;
        } catch {
          /* 正在被删 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function listDir(d) {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 主流程                                                                      */
/* ══════════════════════════════════════════════════════════════════════════ */

// 末尾三条分支必然给它赋值（普通模式 / 变异被抓住 / 变异存活），所以刻意不给初值：
// 给了初值反而会让"某条路径忘了赋值"变成静默的 0 —— 那正是最不该默认成功的地方。
let exitCode;
const state = {
  installedPackIds: [],
  cpuPackId: null,
  accelPackId: null,
  probePath: null,
  backendDir: null,
};

async function main() {
  hdr('0. 本轮跑的是什么');
  say(`   平台        ${process.platform}/${process.arch}`);
  say(`   模式        ${BUNDLE_DIR ? '预编译包' : '⚠️ 源码树 dist（不是交付物，仅供本地调试）'}`);
  if (BUNDLE_DIR) {
    say(`   包目录      ${BUNDLE_DIR}`);
    say(`   解释器      ${NODE_BIN}`);
    say(`               （**不是**宿主的 ${process.execPath} —— 用户机器上没有 node）`);
  }
  say(`   临时根      ${ROOT}`);
  say(`   指针        ${POINTER}`);
  say(`   假 HOME     ${FAKE_HOME}`);
  say(`   真实指针    ${POINTER_BEFORE.path}`);
  say(
    `               ${POINTER_BEFORE.exists ? `存在 sha256=${POINTER_BEFORE.sha256.slice(0, 16)}… mtime=${POINTER_BEFORE.mtimeMs}` : '不存在（判据变成"跑完仍然不存在"）'}`,
  );
  if (mutation) say(`   ⚠️ 变异模式  ${mutation.id}（语义反过来：目标断言不红 = 失败）`);

  setUpMasking();
  if (mutation) applyMutation();

  /* ─────────────────────── boot ─────────────────────── */
  hdr('2. 冷启动（全新数据目录，什么都没装）');
  seedPointer(DATA_DIR);
  say(`   指针已写入 ${POINTER} → ${DATA_DIR}`);
  say('   ★ 刻意**不传** --data-dir、也不设 OPENMEMO_DATA_DIR：');
  say('     那样才是走产品真实的 pointer 机制，后面"搬完重启去哪"这个问题才有意义。');
  const h0 = await startDaemon('cold');
  assert(
    'A-BOOT-HEALTH',
    h0.ready === true && h0.dataDir === DATA_DIR,
    `ready=${h0.ready} dataDir=${h0.dataDir}`,
  );
  assert(
    'A-BOOT-VERSION',
    typeof h0.version === 'string' && h0.version.length > 0,
    `version=${h0.version} build.commit=${h0.build?.commit ?? 'UNKNOWN'}`,
  );

  /*
   * ★ `A-POINTER-EXTERNAL`：**产品自己报出来的指针位置**必须在临时根里。
   *   这条断言守的是本脚本的隔离本身 —— 重定向被简化掉时它当场红，
   *   而不是等用户的 demo 挂了才知道（PROTOCOL §9-bis 那条"覆盖要有人守"）。
   */
  const dd0 = await j('/api/settings/data-dir');
  const ext0 = (dd0.body?.externalFiles ?? [])[0]?.path ?? '';
  /*
   * ★ 判据是**逐字等于我设的那个路径**，不是"落在临时根里就行"。
   *
   * 这一条是被自己的变异改出来的。第一版写的是 `ext0.startsWith(ROOT)`，
   * 而 `M-pointer-hardcoded`（让 `pointerFile()` 忽略环境变量）**照样是绿的** ——
   * 因为本脚本的第 2 层防线把假 HOME 也放在 ROOT 底下，
   * 于是"覆盖生效"和"覆盖失效但被兜底接住"这两件事在断言眼里长得一模一样。
   *
   * 那正是用户点名的第二种假绿灯：**断言的是"报出来的值"，不是"实际用的值"**。
   * 改成全等之后，覆盖一旦失效就当场红，而假 HOME 仍然照常保护机器 ——
   * 两层防线各自独立，谁也不再替谁掩盖。
   */
  const samePath = (a, b) =>
    IS_WIN ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  const pointerExact = ext0.length > 0 && samePath(ext0, POINTER);
  assert(
    'A-POINTER-EXTERNAL',
    pointerExact,
    pointerExact
      ? `产品报告的指针位置逐字等于 OPENMEMO_POINTER_FILE：${ext0}`
      : `产品报告的指针位置 = ${ext0 || '(空)'}，而我设的是 ${POINTER} —— **覆盖没有生效**（哪怕它碰巧还在临时根里，那也只是兜底接住了）`,
  );

  if (wantPhase('hw')) await phaseHardware();
  if (wantPhase('backends')) await phaseBackends();
  if (wantPhase('breaker')) await phaseBreaker();
  if (wantPhase('models')) await phaseModels();
  if (wantPhase('datadir')) await phaseDataDir();
  if (wantPhase('diag')) await phaseDiagnostics();
}

/* ════════════════════════ 2.1 ① 硬件探测 / 推荐 ═══════════════════════════ */

async function phaseHardware() {
  hdr('3. 要求 2.1 ①：网页检测硬件 → 推荐后端（GET /api/runtime/hardware）');
  const r = await j('/api/runtime/hardware');
  const hw = r.body?.hardware;
  const rt = r.body?.runtime;
  assert(
    'A-HW-SHAPE',
    !!hw && Array.isArray(hw.backends) && hw.backends.length > 0,
    `HTTP ${r.status}，backends ${hw?.backends?.length ?? 0} 条`,
  );
  if (!hw) return;

  say('');
  say(`   CPU     ${hw.cpu?.brand ?? 'UNKNOWN'}（${hw.cpu?.logicalCores ?? '?'} 逻辑核）`);
  say(`   RAM     ${hw.ram?.totalMB ?? '?'} MB`);
  say(
    `   GPU     ${(hw.gpus ?? []).length === 0 ? '(探测到 0 块)' : (hw.gpus ?? []).map((g) => `${g.vendor}/${g.name}`).join(', ')}`,
  );
  say(`   推荐后端 selectedBackend = ${hw.selectedBackend}`);
  say('');
  say('   逐后端（这才是"检测硬件"的实际输出，不是一个总数）：');
  for (const b of hw.backends) {
    say(
      `     ${String(b.id).padEnd(8)} available=${String(b.available).padEnd(5)} installed=${String(b.installed).padEnd(5)} probed=${String(b.probed).padEnd(5)} ${String(b.unavailableReason ?? '').slice(0, 90)}`,
    );
  }
  assert(
    'A-HW-RECOMMEND',
    typeof hw.selectedBackend === 'string' && hw.selectedBackend.length > 0,
    `推荐后端 = ${hw.selectedBackend}`,
  );
  say('');
  say(
    `   探针诊断 ran=${rt?.probe?.ran} ok=${rt?.probe?.ok} probeExists=${rt?.probe?.probeExists} path=${rt?.probe?.probePath ?? 'UNKNOWN'}`,
  );

  /*
   * ★★ 全新安装上断路器就已经跳闸了 —— 这是本轮**实测发现的第一条缺陷**。
   *   探针装在后端包里，一个包都没装时它当然不存在；而"不存在"被记成了
   *   断路器的一次失败，两次检测就够跳闸，于是**用户第一次打开诊断页**
   *   看到的就是「加速后端断路器」告警 + 5 个加速后端全被停用。
   *   这与 T-168 修掉的那句谎话是同一族：**没有证据不该被报成故障。**
   */
  /*
   * ★ 这一发 `?refresh=1` 是**判据的一部分，不是顺手多问一句**：
   *   它模拟用户在运行时页点「重新检测」。全新安装上探针还不存在，
   *   于是这一发必然又记一次失败 —— 而阈值是 2。下面那条 finding 要成立，
   *   前提就得像用户那样真的点第二下，否则它会变成"有时候能复现"的传说。
   */
  await j('/api/runtime/hardware?refresh=1');
  const rt2 = (await j('/api/runtime/breaker')).body;
  if (rt2) {
    say('');
    say(
      `   断路器（用户点一次「重新检测」之后）verdict=${rt2.verdict} consecutiveFailures=${rt2.breaker?.consecutiveFailures} blacklisted=[${(rt2.blacklistedBackends ?? []).join(',')}]`,
    );
    say(`   lastError=${String(rt2.breaker?.lastError ?? '').slice(0, 140)}`);
    if (
      rt2.verdict !== 'closed' &&
      /probe executable not found|探针/i.test(String(rt2.breaker?.lastError ?? ''))
    ) {
      finding(
        '全新安装（一个后端包都没装）时，断路器因为"探针还没装"就跳闸',
        [
          `verdict=${rt2.verdict}，lastError=${rt2.breaker?.lastError}`,
          '成因：探针 openmemo-probe 随后端包出厂，冷启动时必然不存在；而',
          '`recordProbeOutcome()` 把"文件不存在"和"驱动挂死"记成同一类失败，阈值 2 次即跳闸。',
          '用户可见后果：第一次打开诊断页就看到「加速后端断路器」告警、5 个加速后端全标停用，',
          '而他什么都还没做错。判据与 T-168 同族：**没测过 ≠ 坏了**。',
          '缓解（实测）：装上任意后端包后 backendDir 会从 <data>/bin/runtime 变成包目录，',
          '断路器按 backendDir 分片，于是那条坏记录被**遗弃**而不是被治好 —— 症状消失但成因还在。',
        ].join('\n'),
      );
    }
  }
}

/* ════════════════════ 2.1 ②③④⑤ 装 / 重启 / 卸载 / 切换 ═══════════════════ */

async function phaseBackends() {
  hdr('4. 要求 2.1 ②：网页装后端包（POST /api/backends/install）');
  const cat = await j('/api/backends/catalog');
  const packs = cat.body?.packs ?? [];
  const applicable = packs.filter((p) => p.applicable === true);
  say(`   目录共 ${packs.length} 个包；本机适用 ${applicable.length} 个：`);
  for (const p of packs) {
    if (p.os !== (IS_WIN ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux')) continue;
    say(
      `     ${String(p.id).padEnd(32)} backend=${String(p.backend).padEnd(7)} applicable=${String(p.applicable).padEnd(5)} kind=${String(p.inapplicableKind ?? '').padEnd(12)} ${String(p.inapplicableReason ?? '').slice(0, 60)}`,
    );
  }
  assert('A-CATALOG-APPLICABLE', applicable.length > 0, `本机适用包 ${applicable.length} 个`);
  if (applicable.length === 0) return;

  /* 挑一个 whisper.cpp 的 CPU 包（最小、且带 openmemo-probe，后面全靠它） */
  const whisperPacks = applicable.filter((p) => String(p.id).startsWith('whispercpp-'));
  const cpuPack = whisperPacks.find((p) => p.backend === 'cpu') ?? applicable[0];
  state.cpuPackId = cpuPack.id;
  say('');
  say(`   → 装 ${cpuPack.id}（${((cpuPack.totalSizeBytes ?? 0) / 1048576).toFixed(1)} MB）`);

  const t0 = Date.now();
  const inst = await j('/api/backends/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: cpuPack.id }),
  });
  const jobId = inst.body?.jobId;
  assert(
    'A-INSTALL-ACCEPTED',
    inst.status === 202 && !!jobId,
    `HTTP ${inst.status} jobId=${jobId ?? '(无)'}`,
  );
  if (!jobId) return;
  const res = await waitForJob(jobId);
  assert(
    'A-INSTALL-JOB',
    res.state === 'succeeded',
    `job=${res.state} ${res.detail} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  /* ★ 地面真相：不信 job 的自述，直接问"到底装上了哪些"。 */
  const got = await j('/api/backends/installed');
  const ids = (got.body?.packs ?? []).map((p) => p.id);
  state.installedPackIds = ids;
  assert(
    'A-INSTALL-GROUNDTRUTH',
    ids.includes(cpuPack.id),
    `/api/backends/installed = [${ids.join(', ')}]`,
  );

  /* ── 装完之后：探针到底能不能跑 ── */
  const hw1 = await j('/api/runtime/hardware?refresh=1');
  const probe = hw1.body?.runtime?.probe;
  state.probePath = probe?.probePath ?? null;
  state.backendDir = probe?.backendDir ?? null;
  assert(
    'A-PROBE-AFTER-INSTALL',
    probe?.probeExists === true && probe?.ok === true,
    `probeExists=${probe?.probeExists} ok=${probe?.ok} devicesFound=${probe?.devicesFound} ${probe?.durationMs}ms ${String(probe?.message ?? '')}`,
  );

  /*
   * ★★ 这一问必须在**重启之前**发生 —— 那正是用户所处的时刻：
   *   他刚在网页上点完「安装 CPU 基础包」，页面刷新一下，然后去看加速包那一格。
   *   重启之后再问就问不到这个缺陷了（本轮实测：重启后理由会变成另一句），
   *   而"重启之后就好了"对一个还没被告知需要重启的用户没有任何意义。
   */
  const catBeforeRestart = await j('/api/backends/catalog');
  const staleAdvice = (catBeforeRestart.body?.packs ?? []).filter(
    (p) => p.applicable === false && /先安装 CPU/.test(String(p.inapplicableReason ?? '')),
  );
  if (staleAdvice.length > 0 && probe?.ok === true) {
    finding(
      '刚在网页上装完 CPU 基础包，目录却仍然叫用户"请先安装 CPU 基础包"',
      [
        `此刻 /api/backends/installed 里确实有 ${cpuPack.id}，探针也确实跑通了（ok=true, devicesFound=${probe?.devicesFound}），`,
        `而 /api/backends/catalog 对 ${staleAdvice.map((p) => p.id).join(', ')} 给出的理由仍是：`,
        `  「${staleAdvice[0].inapplicableReason}」`,
        '成因：applicability 读的是 `RestState.hardware`，那是 **daemon 启动时的快照**；',
        '装完包不会触发重新探测（全仓只有 /api/backends/select 会改写它，且只改 selectedBackend）。',
        '而运行时页问的就是这个端点。用户可见后果：他被要求去做一件他刚做完的事，',
        '而且页面上没有任何东西告诉他"重启一下就好了" —— 这是要求 2.1 主路径上的死胡同。',
        '（重启后本轮实测理由会变，所以它是"会话内不刷新"，不是"永远错"。）',
      ].join('\n'),
    );
  }

  /* ────────────── 2.1 ③：重启生效 ────────────── */
  hdr('5. 要求 2.1 ③：重启生效（POST /api/daemon/restart —— 用户点的那个按钮）');
  const rs = await restartViaHttp('e2e-runtime: 装完后端包');
  assert(
    'A-RESTART-EFFECT',
    rs.newPid !== rs.oldPid && rs.health.dataDir === DATA_DIR,
    `pid ${rs.oldPid} → ${rs.newPid}，dataDir 未漂移 = ${rs.health.dataDir}`,
  );
  const after = await j('/api/backends/installed');
  assert(
    'A-RESTART-PERSIST',
    (after.body?.packs ?? []).some((p) => p.id === cpuPack.id),
    `重启后 ${cpuPack.id} 仍在已安装列表里`,
  );

  /*
   * ★★ 实测缺陷：`/api/backends/catalog` 的适用性判定**在同一次会话里不刷新**。
   *   `RestState.hardware` 是 daemon 启动时的快照，装完包不会重新探测；
   *   而运行时页问的就是这个端点。症状：刚在网页上装完 CPU 基础包，
   *   加速包那一格仍然写着「请先安装 CPU 基础包」—— 让用户去做他刚做完的事。
   */
  const catAfterRestart = await j('/api/backends/catalog');
  const accelAfter = (catAfterRestart.body?.packs ?? []).filter(
    (p) =>
      p.applicable === false &&
      p.inapplicableKind === 'undetermined' &&
      /先安装 CPU/.test(String(p.inapplicableReason ?? '')),
  );
  if (accelAfter.length > 0) {
    finding(
      '装完 CPU 基础包后，目录仍然叫用户"请先安装 CPU 基础包"',
      [
        `重启后仍有 ${accelAfter.length} 个包给出这条理由：${accelAfter.map((p) => p.id).join(', ')}`,
        '（重启前必现；本轮在重启后又抓到一次，说明不只是缓存一次的问题）',
      ].join('\n'),
    );
  }

  /* ────────────── 2.1 ④：卸载 ────────────── */
  hdr('6. 要求 2.1 ④：网页卸载（DELETE /api/backends/:id）');
  const del = await j(`/api/backends/${encodeURIComponent(cpuPack.id)}`, { method: 'DELETE' });
  assert('A-UNINSTALL-ACCEPTED', del.status === 204, `HTTP ${del.status}`);
  const afterDel = await j('/api/backends/installed');
  const idsAfterDel = (afterDel.body?.packs ?? []).map((p) => p.id);
  assert(
    'A-UNINSTALL-GONE',
    !idsAfterDel.includes(cpuPack.id),
    `卸载后 /api/backends/installed = [${idsAfterDel.join(', ') || '(空)'}]`,
  );
  const delAgain = await j(`/api/backends/${encodeURIComponent(cpuPack.id)}`, { method: 'DELETE' });
  assert(
    'A-UNINSTALL-IDEMPOTENT',
    delAgain.status === 404,
    `再删一次 → HTTP ${delAgain.status}（应为 404，而不是假装成功）`,
  );

  /* ────────────── 2.1 ⑤：装另一个后端 + 切换 ────────────── */
  hdr('7. 要求 2.1 ⑤：装另一个后端并切换（POST /api/backends/select）');

  // 装回 CPU 包（它是 L1 底座，后面每一步都依赖它带来的探针）
  const re = await j('/api/backends/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: cpuPack.id }),
  });
  if (re.body?.jobId) await waitForJob(re.body.jobId);

  const cat2 = await j('/api/backends/catalog');
  const accel = (cat2.body?.packs ?? []).find(
    (p) => p.applicable === true && p.backend !== 'cpu' && String(p.id).startsWith('whispercpp-'),
  );

  if (!accel) {
    /*
     * 本平台/本 runner 上装不了加速包。**这是正确行为，不是缺陷** ——
     * L2 要求真实硬件证据（probe 枚举到设备，或 advisory 看到对应的 GPU）。
     * 但"这一格没验到"必须**说出来**，不能让它长得像绿的。
     */
    const cands = (cat2.body?.packs ?? []).filter(
      (p) => p.backend !== 'cpu' && p.applicable === false,
    );
    unknown(
      'A-ACCEL-INSTALL',
      `本 runner 上没有任何加速包适用 —— 逐个理由：${cands.map((p) => `${p.id}=${p.inapplicableKind}:${String(p.inapplicableReason ?? '').slice(0, 40)}`).join(' | ') || '(目录里没有本平台的加速包)'}`,
    );
    unknown('A-ACCEL-SWITCH', '前提（装上一个加速后端）不成立，切换无从谈起');
  } else {
    state.accelPackId = accel.id;
    say(
      `   → 装加速包 ${accel.id}（backend=${accel.backend}，${((accel.totalSizeBytes ?? 0) / 1048576).toFixed(1)} MB）`,
    );
    const ai = await j('/api/backends/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: accel.id }),
    });
    const ajob = ai.body?.jobId;
    const ares = ajob
      ? await waitForJob(ajob)
      : { state: `HTTP ${ai.status}`, detail: JSON.stringify(ai.body).slice(0, 200) };
    assert(
      'A-ACCEL-INSTALL',
      ares.state === 'succeeded',
      `${accel.id} → ${ares.state} ${ares.detail}`,
    );

    const sw = await j('/api/backends/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: accel.backend }),
    });

    /*
     * ── 判据要分清「拒绝」和「**用假理由**拒绝」──────────────────────────────
     *
     * 托管 runner 上没有真 GPU，所以探针**如实**枚举不到设备，
     * 「本机无法使用 vulkan/metal」是一句**真话** —— 这一格在这里
     * 结构上就走不完，应当是 UNKNOWN，不是红。
     *
     * 但它必须与那个真缺陷区分开：`[CI 实测 run 31250730491]` 当时的 409 说的是
     * **「backend package not installed」**，而那个包就是上一步刚装的 ——
     * 陈旧快照让 `installed` 恒为 false。同样是 409，一句是测出来的结论，
     * 一句是编的。**只有后者是缺陷。**
     *
     * `[CI 实测 run 31252071989]` 修完之后同一格的措辞变成了
     * 「installed but enumerated no devices」—— 说明快照真的跟上了：
     * 它现在知道包装着、也知道自己探过了。
     */
    const zh = String(sw.body?.error?.messageZh ?? '');
    const en = String(sw.body?.error?.message ?? '');
    const claimsNotInstalled = /not installed|未安装|没有安装/i.test(`${zh} ${en}`);
    const installedNow = (await j('/api/backends/installed')).body?.packs ?? [];
    const reallyInstalled = installedNow.some((p) => p.id === accel.id);

    if (sw.status === 200 && sw.body?.selectedBackend === accel.backend) {
      assert('A-ACCEL-SWITCH', true, `切到 ${accel.backend} 成功（HTTP 200）`);
    } else if (claimsNotInstalled && reallyInstalled) {
      assert(
        'A-ACCEL-SWITCH',
        false,
        `**用假理由拒绝**：包 ${accel.id} 此刻确实在已安装列表里，而 select 回 HTTP ${sw.status}「${zh || en}」。` +
          `这正是陈旧硬件快照那条死胡同 —— 用户装完点"启用"，被告知"你没装"。`,
      );
    } else {
      unknown(
        'A-ACCEL-SWITCH',
        `本 runner 上没有真 GPU，select 回 HTTP ${sw.status}「${zh || en}」——` +
          `这是**测出来的真结论**（包装着、也探过了），不是那句假话。` +
          `「装完能不能真的切过去并跑起来」需要一台有真实 GPU 的机器才答得了。`,
      );
    }
  }

  /* 切回 CPU：它是 L1 兜底，**选它永远合法**（ADR-014 决策 1） */
  const toCpu = await j('/api/backends/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'cpu' }),
  });
  assert(
    'A-SELECT-CPU',
    toCpu.status === 200 && toCpu.body?.selectedBackend === 'cpu',
    `切回 cpu → HTTP ${toCpu.status}`,
  );

  const bogus = await j('/api/backends/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'definitely-not-a-backend' }),
  });
  assert(
    'A-SELECT-INVALID',
    bogus.status === 400,
    `乱填 backend → HTTP ${bogus.status}（应 400，不许被当成某个默认值）`,
  );

  /* ────────────── 别退化：显式选 CPU 时不许污蔑已装的加速包 ────────────── */
  hdr('8. ★ 别退化：用户显式选 CPU 时，已装的加速包不能被报成「驱动缺失或过旧」(T-168)');
  say(
    '   前提：一个加速包**装着**，而这一次探测**没有加载它**（backendDir 单值，一次只扫一个目录）。',
  );
  say('   那是"没测过"，不是"不支持" —— 报成驱动故障会把用户支去修一个不存在的问题。');

  /* ─────────────────────────────────────────────────────────────────────────
   * ★ 登记：**CI 到不了的现场**（Manager 2026-08-10 裁决 ②）
   *
   * 这条守卫要的状态是 `installed === true && probed === false` ——
   * 「后端包装着，而这一轮探测没有加载它」。
   *
   * ⚠️ **它不是坏的，也不是在工作的。它是第三种：在等一个 CI 给不了的现场。**
   *   · 不是坏的：判据本身有牙齿，`M-driver-lie` 变异在能构造前提的机器上会抓住它；
   *   · 不是在工作的：托管 runner 上每个装上的后端都**探得到**（探针如实回报
   *     "枚举不到设备"），于是 `probed` 恒为 true，这个状态**合法地**不出现。
   *
   * 真机上它才会出现：驱动装了但探不出来 / GPU 被别的进程占住 / 驱动版本过老。
   * **不要为了让它变绿去改探测层** —— 那是把守卫改成它自己的形状。
   *
   * **过期谓词（可执行）**：当 `unprobedInstalled.length > 0` 时（下面 `else` 分支），
   * 脚本会打印一句"这条登记已过期，请回来划掉"。
   * 也就是说：**有了能构造这个状态的 runner 或注入手段，这条登记会自己喊出来**，
   * 不用靠谁记得。
   * ───────────────────────────────────────────────────────────────────────── */
  const hw2 = await j('/api/runtime/hardware?refresh=1');
  const backends2 = hw2.body?.hardware?.backends ?? [];
  const unprobedInstalled = backends2.filter((b) => b.installed === true && b.probed !== true);
  say('');
  for (const b of backends2) {
    say(
      `     ${String(b.id).padEnd(8)} installed=${String(b.installed).padEnd(5)} probed=${String(b.probed).padEnd(5)} ${String(b.unavailableReason ?? '').slice(0, 100)}`,
    );
  }

  if (unprobedInstalled.length === 0) {
    /*
     * ★★ 2026-08-10：这条 UNKNOWN 详情**原来写的是一句假话**，代价很大，留着当教训。
     *
     * 原文：「要构造它需要同一台机器上装得下两个后端包，**而加速包在这里装不上**
     *        （没有 GPU 硬件证据）」。
     *
     * `[CI 实测 darwin-arm64, run 31365414371]` **同一次运行、同一份日志、往上三行**：
     *     → 装加速包 whispercpp-metal-macos-arm64（backend=metal，1.9 MB）
     *     ✔ A-ACCEL-INSTALL   whispercpp-metal-macos-arm64 → succeeded
     * 加速包**装上了**。而且 `applicability.ts` 把 metal-on-darwin 硬编码成 L1
     * （`[本机实测]` 合成 darwin 输入下三种探针状态一律 `{applicable:true,tier:'l1'}`），
     * 它根本不看 GPU 硬件证据 —— 那半句连机制都是错的。
     *
     * ⚠️ 这句假话**先误导分诊者、再误导我、再经 Manager 转述到用户**，
     * 并且据它产出过一条错误的工程建议（"去改 harness 的安装逻辑，2 MB 挡不住"）。
     * **一句写在诊断里的假话，比一个红灯贵得多**：红灯让人来看，假话让人走开。
     *
     * 真实前提是另一件事，见下面的措辞。
     */
    unknown(
      'A-CPU-NO-DRIVER-LIE',
      `本 runner 上构造不出前提。这条断言要的是一个「**装了、而这一轮探测没有加载它**」的后端` +
        `（installed=true 且 probed=false）。当前每个已装后端都被探到了：` +
        `${backends2.map((b) => `${b.id}(installed=${b.installed},probed=${b.probed})`).join(' ') || '(空)'}。` +
        `⚠️ **不是"加速包装不上"** —— 托管 runner 上加速包装得上（同一轮 A-ACCEL-INSTALL 就是绿的），` +
        `装上之后也**探得到**（探针如实回报"枚举不到设备"），于是 probed=true，` +
        `「装了却没被探」这个状态在这里不会出现。` +
        `它是**真机才有的现场**（驱动装了但探不出来 / GPU 被别的进程占住 / 驱动版本过老），` +
        `CI 结构性给不了 —— 详见本条断言上方的「CI 到不了的现场」登记。`,
    );
  } else {
    /*
     * ★ 过期谓词（两个方向都要有人管）
     *
     * 走到这个分支 = **前提构造出来了**（有后端 installed=true 且 probed=false）。
     * 那么上面那条"CI 结构性到不了"的登记**就过期了**，必须有人回来划掉它 ——
     * 否则它会像所有烂在原地的登记一样，把一件**已经变了**的事继续说成现状。
     * 这和 `e2e-browser` 那个钉住集合是同一套语义：**清单之内被修好了也要有人知道。**
     */
    say('');
    say(
      '   ★ 注意：`installed && !probed` 这次**构造出来了** —— 上面那条「CI 到不了的现场」登记已过期，请回来划掉它。',
    );
    /*
     * ★ 2026-08-10：判据从**黑名单**翻成**白名单**。失败方向从绿翻成红。
     *
     * 旧判据：`LIE = /driver missing or too old|驱动缺失|驱动.*过旧/i`，命中即红。
     * 它要求产品**逐字**说出这几种措辞之一才抓得到。产品换个说法
     * （「显卡驱动版本太低」「未检测到可用的图形驱动」）——正则落空、`liars` 为空、
     * **这条断言变绿，而产品正在撒同一个谎**。
     *
     * `[实测 A/B，见本轮回执]` 同一份事故数据
     * `{installed:true, probed:false, unavailableReason:'显卡驱动版本太低，请更新驱动'}`：
     *     旧判据 → liars=0 → **绿（假过）**
     *     新判据 → 不在白名单 → **红**
     *
     * ⚠️ 黑名单在这类判定上**结构性地不成立**：要穷举"所有可能的撒谎说法"，
     * 而产品每改一次文案就多一种。白名单反过来 ——
     * **只列举"允许出现的、代表『没测过』的说法"，任何新措辞都落到红**，
     * 逼人来这里显式分类。这就是 Manager 那条：
     * **失败方向是红的守卫，坏了会有人来烦你；失败方向是绿的，坏了没有人知道。**
     *
     * 契约本身也是这么设计的（`packages/shared/src/hardware.ts` 的 `probed` 注释）：
     * 「Why this is a separate field, and not prose in `unavailableReason`」——
     * `probed` 就是为了让这件事**不必靠读句子**。产品侧 `backends.ts:117` 已经照做
     * （`if (status?.installed === true && status.probed !== true) return 'undetermined'`），
     * 这条腿是最后一处还在嗅字符串的。
     */
    const NOT_MEASURED = [
      /^$/,
      /^probe did not complete\b/i,
      /^probe skipped\b/i,
      /^disabled after repeated failures\b/i,
      /*
       * ★ 2026-08-10 新增（linux + win32 实测同一句，只有路径不同；darwin 构造不出前提）。
       *
       * 产品原句（`packages/runtime/src/backends/manager.ts:262`，`!probed` 那条分支）：
       *   "installed, but this detection run did not load it: only the backend directory
       *    currently in use is scanned (<path>), and this backend's library is not in it.
       *    This is not a driver or hardware fault — nothing was measured about it.
       *    Select this backend, or run the self-test on that pack, to get a real answer."
       *
       * **为什么它算"没测过"而不是"测了且不行"** —— 这正是本断言存在的全部意义：
       * 这条分支的进入条件是 `!probed`，即**探测这一轮根本没加载这个包的库**。
       * `backendDir` 是单值的：一次探测只扫一个包目录，别的已装包对它完全不可见。
       * 所以这里没有任何测量发生 —— 句子本身也只字不提驱动/硬件/是否支持，
       * 末句还明确写着 "nothing was measured about it"。**没有证据被如实报成没有证据。**
       *
       * 对照：**最后一条分支** `'installed but enumerated no devices (driver missing or
       * too old)'` **绝不能进这张白名单** —— 那句是**挣来的结论**（库确实在被扫的目录里、
       * 或 dlopen 因缺驱动库失败，枚举仍为空）。产品哪天把它说给一个 `!probed` 的后端听，
       * 那就正是这条腿要抓的谎。
       *
       * 锚在句首、逐字前缀：路径与后续文案可变，进入条件不可变。
       */
      /^installed, but this detection run did not load it\b/i,
    ];
    const liars = unprobedInstalled.filter((b) => {
      const why = String(b.unavailableReason ?? '').trim();
      return !NOT_MEASURED.some((re) => re.test(why));
    });
    assert(
      'A-CPU-NO-DRIVER-LIE',
      liars.length === 0,
      liars.length === 0
        ? `${unprobedInstalled.length} 个「装了但这次没探它」的后端，措辞都属于"没测过"那一类：${unprobedInstalled.map((b) => b.id).join(', ')}`
        : `**退化或新措辞**：${liars.map((b) => `${b.id} → "${b.unavailableReason}"`).join(' | ')}\n` +
            `      这几条不在"没测过"白名单里。它要么真的在替一次**没做过的探测**下结论（缺陷），\n` +
            `      要么是一句新的、合法的"没测过"说法 —— 那就把它加进上面的 NOT_MEASURED 并说明理由。\n` +
            `      **不许因为"看起来没问题"就放宽成模糊匹配**：那正是这条判据被翻掉的原因。`,
    );

    const cat3 = await j('/api/backends/catalog');
    const mislabeled = (cat3.body?.packs ?? []).filter(
      (p) =>
        unprobedInstalled.some((b) => b.id === p.backend) && p.inapplicableKind === 'unsupported',
    );
    assert(
      'A-CPU-NO-UNSUPPORTED-LABEL',
      mislabeled.length === 0,
      mislabeled.length === 0
        ? '目录里也没有把这类包标成「本机不支持」'
        : `**退化**：${mislabeled.map((p) => p.id).join(', ')} 被标成 unsupported`,
    );
  }
}

/* ══════════════════ 断路器：跳闸 → 冷却 → 半开 → 自愈 ═══════════════════ */

async function phaseBreaker() {
  hdr('9. ★ 别退化：断路器跳闸后能自愈（60s 冷却 + 半开，T-173）');

  /*
   * ★ 探针路径**现问一次**，绝不用 phaseBackends 存下来的那个。
   *
   * `[CI 实测 run 31249873183]` 用旧值在 macOS / Windows 上直接把这一整段变成了空转：
   * phaseBackends 后半段会卸载再重装、还可能装上一个加速包，
   * 而 `backendDir` 是**单值**的 —— 装完 metal 之后 daemon 用的是 metal 包里的探针，
   * 我却对着 cpu 包里那个旧路径注入故障。结果探测一路成功、断路器根本没跳，
   * 三条断言一起红，而红的原因与断路器毫无关系。
   *
   * 教训与本文件里其它几处同源：**别把"刚才看到的值"当成"现在的值"**。
   */
  const hwNow = await j('/api/runtime/hardware');
  const probePath = hwNow.body?.runtime?.probe?.probePath ?? null;
  const b0 = await j('/api/runtime/breaker');
  if (!probePath || !existsSync(probePath)) {
    unknown(
      'A-BREAKER-TRIP',
      `找不到探针二进制（probePath=${probePath ?? 'null'}）—— 前提是先装上一个后端包`,
    );
    unknown('A-BREAKER-RETRYAT', '同上');
    unknown('A-BREAKER-QUIET', '同上');
    unknown('A-BREAKER-HEAL', '同上');
    return;
  }

  /*
   * ── 故障注入：为什么必须**保持 size 与 mtime 不变** ──────────────────────
   *
   * 断路器有**两个**出口：冷却到期（我们要测的那个）和**指纹变化**
   * （`driverFingerprint` = 内核版本 + 探针 size/mtime + backendDir 里的动态库清单）。
   * 随便改一下探针再改回来，指纹就变了 —— 那时 `breakerVerdict()` 会走
   * "驱动换了 ⇒ 裁决作废"这条捷径直接返回 `closed`，而我们会误以为
   * **测到了自愈**。那正是本仓要防的假绿灯：绿是真的，证明的却是另一件事。
   *
   * 所以：写同样长度的零字节（一执行就 ENOEXEC），恢复时把原始字节写回去
   * **并用 utimes 把 mtime 恢复到原值**。指纹从头到尾一个字符没变，
   * 于是唯一可能的出口只剩冷却 + 半开 —— 这条断言才真的在测它声称在测的东西。
   */
  const orig = readFileSync(probePath);
  const st = statSync(probePath);
  const origAtime = st.atime;
  const origMtime = st.mtime;

  const fp0 = b0.body?.breaker?.driverFingerprint ?? null;
  say(`   探针        ${probePath}（${orig.length} B）`);
  say(`   注入前指纹  ${fp0 ?? '(null)'}`);

  const restoreProbe = () => {
    writeFileSync(probePath, orig);
    try {
      chmodSync(probePath, 0o755);
    } catch {
      /* Windows 上是空操作 */
    }
    utimesSync(probePath, origAtime, origMtime);
  };

  try {
    // 注入：同样长度的零字节 ⇒ 不是合法可执行文件，但 size 不变
    writeFileSync(probePath, Buffer.alloc(orig.length, 0));
    utimesSync(probePath, origAtime, origMtime);
    say('   已注入：探针内容置零（size / mtime 保持不变 ⇒ 指纹不变）');

    /*
     * ── 先确认前提真的成立，再谈跳没跳闸 ────────────────────────────────────────
     *
     * `[CI 实测 run 31250206184]` macOS / Windows 上这三条一起红，而**根本原因
     * 不是断路器**：两发 `?refresh=1` 在 0.5 秒内返回，`runtime.probe.ran` 是
     * `undefined`，`consecutiveFailures` 从 0 到 0 —— 也就是说**那两发压根没探**。
     * 探针路径是对的、注入也做了，但这一轮"注了故障还成功"的形态与
     * 「断路器坏了」长得一模一样，于是红灯指向了错误的方向。
     *
     * 判据补一层：**注入之后必须观测到"探测真的跑了并且失败了"**。
     *   · 观测得到 → 前提成立，下面的跳闸/冷却/半开才有意义；
     *   · 观测不到 → 这台 runner 上构造不出前提，如实报 UNKNOWN 并**把原始
     *     runtime 块打出来**，让下一轮有据可查 —— 而不是留一个方向错误的红。
     */
    let probedAndFailed = false;
    let lastRuntime = null;
    for (let i = 0; i < 2; i++) {
      const r = await j('/api/runtime/hardware?refresh=1');
      lastRuntime = r.body?.runtime ?? null;
      if (lastRuntime?.probe?.ran === true && lastRuntime?.probe?.ok === false)
        probedAndFailed = true;
      say(
        `   第 ${i + 1} 发 refresh：HTTP ${r.status} probe.ran=${lastRuntime?.probe?.ran} ok=${lastRuntime?.probe?.ok} kind=${lastRuntime?.probe?.failureKind ?? '-'}`,
      );
    }
    if (!probedAndFailed) {
      unknown(
        'A-BREAKER-TRIP',
        `注入故障后没有观测到"探测真的跑了并且失败了" —— 前提不成立，跳闸与否说明不了断路器的死活。原始 runtime.probe=${JSON.stringify(lastRuntime?.probe ?? null).slice(0, 300)}`,
      );
      unknown('A-BREAKER-RETRYAT', '前提不成立（见上）');
      unknown('A-BREAKER-QUIET', '前提不成立（见上）');
      unknown('A-BREAKER-HEAL', '前提不成立（见上）');
      return;
    }
    const b1 = await j('/api/runtime/breaker');
    const br = b1.body?.breaker ?? {};
    say('');
    say(
      `   跳闸后 verdict=${b1.body?.verdict} open=${b1.body?.open} consecutiveFailures=${br.consecutiveFailures}`,
    );
    say(`          blacklistedBackends=[${(b1.body?.blacklistedBackends ?? []).join(', ')}]`);
    say(`          lastError=${String(br.lastError ?? '').slice(0, 120)}`);

    assert(
      'A-BREAKER-TRIP',
      b1.body?.verdict === 'open' && (b1.body?.blacklistedBackends ?? []).length > 0,
      `verdict=${b1.body?.verdict}，停用 ${(b1.body?.blacklistedBackends ?? []).length} 个加速后端`,
    );

    /*
     * ★ 出口本身：`blacklistedAt !== null ⇒ retryAt !== null`，且第一次跳闸的
     *   冷却期是 60s。这条不变式就是"死锁没有出口"的反面 —— 它一旦不成立，
     *   拉黑就是永久的，而用户不会收到任何报错。
     */
    const bAt = Date.parse(br.blacklistedAt ?? '');
    const rAt = Date.parse(br.retryAt ?? '');
    const gap = rAt - bAt;
    assert(
      'A-BREAKER-RETRYAT',
      Number.isFinite(gap) && gap === 60_000,
      `retryAt − blacklistedAt = ${Number.isFinite(gap) ? `${gap}ms` : 'UNKNOWN（有一个不是合法时刻）'}（BREAKER_COOLDOWN_MS 应为 60000）`,
    );

    // 冷却期内**一发都不该探**：这才是断路器省下的那笔钱
    const before = br.consecutiveFailures;
    const hwq = await j('/api/runtime/hardware?refresh=1');
    const b2 = await j('/api/runtime/breaker');
    assert(
      'A-BREAKER-QUIET',
      b2.body?.breaker?.consecutiveFailures === before && hwq.body?.runtime?.probe?.ran === false,
      `冷却期内再请求一次：probe.ran=${hwq.body?.runtime?.probe?.ran} consecutiveFailures ${before}→${b2.body?.breaker?.consecutiveFailures}`,
    );

    // 修好"故障"，但**指纹保持原样**
    restoreProbe();
    const b3 = await j('/api/runtime/breaker');
    const fpNow = b3.body?.breaker?.driverFingerprint ?? null;
    assert(
      'A-BREAKER-FINGERPRINT-STABLE',
      fpNow === b1.body?.breaker?.driverFingerprint,
      `恢复探针后指纹仍是 ${fpNow}（与跳闸时相同）⇒ 下面的自愈只可能来自冷却+半开，不是"驱动变了"那条捷径`,
    );

    // 等冷却到期，然后让它半开
    const waitMs = Math.max(0, rAt - Date.now()) + 2000;
    say('');
    say(`   等冷却到期：${(waitMs / 1000).toFixed(1)}s（这段等待是判据的一部分，不能跳过）`);
    await sleep(waitMs);

    let healed = null;
    for (let i = 0; i < 40; i++) {
      await j('/api/runtime/hardware?refresh=1'); // 触发半开那一发（后台 + 单飞）
      await sleep(1500);
      const bb = await j('/api/runtime/breaker');
      const s = bb.body?.breaker ?? {};
      if (
        bb.body?.verdict === 'closed' &&
        s.consecutiveFailures === 0 &&
        s.blacklistedAt === null
      ) {
        healed = bb.body;
        break;
      }
      if (i === 0)
        say(
          `   半开：recovering=${bb.body?.recovering} recoveryStartedAt=${bb.body?.recoveryStartedAt} recoveryTimeoutMs=${bb.body?.recoveryTimeoutMs}`,
        );
    }

    /*
     * 判据是 **`consecutiveFailures === 0 && blacklistedAt === null`**，
     * 不是 `verdict === 'closed'` —— 后者靠指纹变化也能拿到，
     * 而只有 `recordProbeOutcome(ok)` 那条路径会把计数清零。
     * 这一条就是"真的自愈"与"看起来自愈"的分界线。
     */
    assert(
      'A-BREAKER-HEAL',
      healed !== null,
      healed
        ? `冷却到期后半开那一发成功，断路器彻底复位：consecutiveFailures=0 blacklistedAt=null（指纹全程未变）`
        : `**没有自愈**：60s 冷却到期后 60s 内没能回到 closed+计数清零`,
    );
  } finally {
    // 无论如何把探针放回去。（注意：这只是礼貌 —— 整个 ROOT 都在 mkdtemp 里，
    // 按 §9-bis 的判据，就算这里被 kill -9，机器上也不会留下任何坏状态。）
    try {
      restoreProbe();
    } catch {
      /* ignore */
    }
  }
}

/* ════════════════════════ 要求 2.2：模型 ═════════════════════════════════ */

async function phaseModels() {
  hdr('10. 要求 2.2 ①：网页浏览模型目录（GET /api/models/catalog）');
  const mc = await j('/api/models/catalog');
  const groups = mc.body?.groups ?? [];
  const models = groups.flatMap((g) =>
    (g.variants ?? []).map((v) => ({ ...v, role: v.role ?? g.role, tags: v.tags ?? g.tags ?? [] })),
  );
  say(`   ${groups.length} 个分组，展平后 ${models.length} 个模型条目`);
  if (models.length === 0) {
    // 空集必须出声：先怀疑 unwrap 写错了，别当成"目录里没有模型"（本仓同一形状已发生四次）
    say(`   ⚠️ 展平后是空的 —— 原始 top-level keys: ${JSON.stringify(Object.keys(mc.body ?? {}))}`);
  }
  assert('A-MODEL-CATALOG', models.length > 0, `目录里 ${models.length} 个模型条目`);
  if (models.length === 0) return;

  const sizeOf = (m) => (m.files ?? []).reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  const vads = models.filter((m) => m.role === 'vad').sort((a, b) => sizeOf(a) - sizeOf(b));
  say(
    `   role=vad 的模型 ${vads.length} 个：${vads.map((m) => `${m.id}(${(sizeOf(m) / 1048576).toFixed(1)}MB)`).join(', ')}`,
  );
  if (vads.length < 2) {
    unknown('A-MODEL-SWITCH', `目录里 role=vad 的模型只有 ${vads.length} 个，构造不出"切换"的前提`);
  }

  /* ── 下载 ── */
  hdr('11. 要求 2.2 ②：网页下载模型（POST /api/models/pull）');
  const first = vads[0] ?? models.sort((a, b) => sizeOf(a) - sizeOf(b))[0];
  const p1 = await j('/api/models/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: first.id }),
  });
  const j1 = p1.body?.jobId;
  const r1 = j1
    ? await waitForJob(j1)
    : { state: `HTTP ${p1.status}`, detail: JSON.stringify(p1.body).slice(0, 200) };
  assert('A-MODEL-PULL', r1.state === 'succeeded', `${first.id} → ${r1.state} ${r1.detail}`);

  const inst1 = await j('/api/models/installed');
  const instIds = (inst1.body?.models ?? []).map((m) => m.id);
  assert(
    'A-MODEL-PULL-GROUNDTRUTH',
    instIds.includes(first.id),
    `/api/models/installed = [${instIds.join(', ')}]`,
  );

  /* ── 磁盘占用统计 ── */
  const stor1 = await j('/api/models/storage');
  const used1 = stor1.body?.usedBytes ?? 0;
  const realUsed = duBytes(join(DATA_DIR, 'models'));
  say('');
  say(
    `   /api/models/storage：usedBytes=${used1}，breakdown ${(stor1.body?.breakdown ?? []).length} 条`,
  );
  for (const b of stor1.body?.breakdown ?? [])
    say(`     ${String(b.id).padEnd(30)} ${b.bytes} B  active=${b.active}`);
  say(`   实测（自己 stat 整棵 models/ 树）= ${realUsed} B`);
  assert(
    'A-STORAGE-STATS',
    used1 > 0 && used1 <= realUsed,
    `usedBytes=${used1} ≤ 实测 ${realUsed}（统计的是 blob，必然不大于整棵树）`,
  );

  /* ── sha256 校验失败的处理 ── */
  hdr('12. 要求 2.2 ②b：sha256 校验失败怎么处理（POST /api/models/verify）');
  const blobDir = join(DATA_DIR, 'models', 'blobs');
  /*
   * ★ 受害 blob 必须是**被校验的那个模型自己的**。
   *
   * 这里原本取 `listDir(blobDir).sort()[0]` —— 而 `models/blobs/` 是全局共用的：
   * `phaseBackends()` 装的后端包、启动时 `modelReconcile` 导入的三个随包模型，
   * blob 全落在同一个目录里。字典序最小的那个是谁，由 manifest 里写死的 sha256
   * 决定，**与被校验的模型无关**：
   *   blobs.sort()[0] = sha256-1c556ea5…  → asr/sherpa-streaming-zh-14m
   *   而这一段验的是                        → vad/silero-vad-ggml（最小的 role=vad）
   * 于是"改坏一个字节"改的是另一个模型的权重，verify 如实回答 succeeded。
   * 摘要因此三个平台一模一样地红 —— digest 是写死的，跨平台完全确定。
   *
   * 判据不变：**改坏之后端点必须说不通过**。改的是"改坏谁"。
   */
  const ownBlobs = ((inst1.body?.models ?? []).find((m) => m.id === first.id)?.files ?? []).map(
    (f) => `sha256-${f.sha256}`,
  );
  const blobs = listDir(blobDir).filter(
    (f) => /^sha256-[a-f0-9]{64}$/.test(f) && ownBlobs.includes(f),
  );
  if (blobs.length === 0) {
    unknown(
      'A-MODEL-SHA256-FAIL',
      `${blobDir} 里找不到属于 ${first.id} 的 blob（记录声明 ${ownBlobs.length} 个：${ownBlobs.join(', ') || '无'}），构造不出"内容被改坏"的前提`,
    );
  } else {
    const victim = join(blobDir, blobs[0]);
    const backup = readFileSync(victim);
    try {
      // 改坏**一个字节**：长度不变，只有哈希变了 —— 校验若只看大小就会放过它
      const bad = Buffer.from(backup);
      bad[Math.floor(bad.length / 2)] ^= 0xff;
      writeFileSync(victim, bad);
      say(`   已篡改 1 字节：${victim}（属于 ${first.id}，即下面要校验的那个模型）`);
      const v = await j('/api/models/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: first.id }),
      });
      const vjob = v.body?.jobId;
      const vres = vjob
        ? await waitForJob(vjob, 300)
        : { state: `HTTP ${v.status}`, detail: JSON.stringify(v.body).slice(0, 200) };
      assert(
        'A-MODEL-SHA256-FAIL',
        vres.state === 'failed',
        `内容被改坏后 verify → ${vres.state}${vres.detail ? `：${vres.detail.slice(0, 200)}` : ''}（必须 failed —— 报成功就是把损坏的权重当好的用）`,
      );
    } finally {
      writeFileSync(victim, backup);
    }
  }

  /*
   * ── 空集假绿：一份"没有任何文件可核"的安装记录，不许报"校验通过" ──
   *
   * 上面那条只能证明"坏字节会被抓到"。它抓不到另一种假绿：**一个字节都没核过**
   * 也返回 succeeded。`[实测 2026-08-10]` 把记录改成 `files: []` 之前，
   * `POST /api/models/verify` → `succeeded`，端点对一份空记录回答"完好"。
   * 判据是**终态必须不是 succeeded**，不是"某个函数被调用过"。
   */
  const manDir = join(DATA_DIR, 'models', 'manifests');
  const manPath = listDir(manDir)
    .flatMap((k) => listDir(join(manDir, k)).map((f) => join(manDir, k, f)))
    .find((p) => {
      try {
        return JSON.parse(readFileSync(p, 'utf8')).id === first.id;
      } catch {
        return false;
      }
    });
  if (!manPath) {
    unknown('A-MODEL-VERIFY-EMPTY', `找不到 ${first.id} 的安装记录，构造不出"空记录"的前提`);
  } else {
    const manBackup = readFileSync(manPath);
    try {
      const rec = JSON.parse(manBackup.toString('utf8'));
      rec.files = [];
      writeFileSync(manPath, JSON.stringify(rec));
      const v2 = await j('/api/models/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: first.id }),
      });
      const vjob2 = v2.body?.jobId;
      const vres2 = vjob2
        ? await waitForJob(vjob2, 120)
        : { state: `HTTP ${v2.status}`, detail: JSON.stringify(v2.body).slice(0, 200) };
      assert(
        'A-MODEL-VERIFY-EMPTY',
        vres2.state !== 'succeeded',
        `空记录（files: []）verify → ${vres2.state}${vres2.detail ? `：${vres2.detail.slice(0, 160)}` : ''}（不许 succeeded —— 一个字节都没核过不等于完好）`,
      );
    } finally {
      writeFileSync(manPath, manBackup);
    }
  }

  /* ── 断点续传 ── */
  if (!RESUME_TEST) {
    unknown(
      'A-MODEL-RESUME',
      '本轮没开 --resume-test（它要真的把一个下到一半的大包打断，只在带宽便宜的那条腿上跑）',
    );
  } else {
    await resumeProbe();
  }

  /* ── 切换 ── */
  hdr('13. 要求 2.2 ③：网页切换模型（POST /api/models/activate）');
  const act0 = await j('/api/models/active');
  say(`   切换前 active = ${JSON.stringify(act0.body?.active ?? {})}`);
  let second = null;
  if (vads.length >= 2) {
    second = vads.find((m) => m.id !== first.id);
    const p2 = await j('/api/models/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: second.id }),
    });
    if (p2.body?.jobId) await waitForJob(p2.body.jobId);
    const sw = await j('/api/models/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'vad', id: second.id }),
    });
    assert(
      'A-MODEL-SWITCH',
      sw.status === 200 && sw.body?.active === second.id && sw.body?.previous === first.id,
      `${sw.body?.previous} → ${sw.body?.active}（HTTP ${sw.status}，reloadRequired=${sw.body?.reloadRequired}）`,
    );

    /*
     * ★★ **切换必须扛得住重启** —— 这条是本轮实测抓到的真缺陷补上的守卫。
     *
     * `persistActive()` 写全部 7 个 role，而 `loadPersisted()` 原本只读回 asr / llm，
     * 于是用户选的 VAD 每次重启都被静默清空（`apps/daemon/src/http/rest/state.ts`）。
     * 而产品在装完组件之后**还会主动请用户重启** —— 这条路几乎必然被走到。
     *
     * 光断言 `POST /activate` 回 200 是抓不到它的：那一步完全正确。
     * 判据必须是「**重启之后再问一次**」—— 这也是"断言报出来的值 vs 断言实际生效的值"
     * 那类假绿灯的又一个实例。
     */
    const beforeRestart = (await j('/api/models/active')).body?.active?.vad ?? null;
    const rs = await restartViaHttp('e2e-runtime: 验证模型切换能不能扛住重启');
    const afterRestart = (await j('/api/models/active')).body?.active?.vad ?? null;
    assert(
      'A-MODEL-SWITCH-PERSISTS',
      afterRestart === second.id,
      `重启前 active.vad=${beforeRestart}；重启后（pid ${rs.oldPid}→${rs.newPid}）=${afterRestart}` +
        (afterRestart === second.id ? '' : ' —— **用户的选择在重启中丢了**'),
    );
  }

  /* ── 删除 ── */
  hdr('14. 要求 2.2 ④：网页删除模型 + freedBytes 是不是真的');

  /*
   * ★ 先验"正在用的模型删不掉"。这条不是锦上添花：
   *   删掉正在用的权重，报错会出现在**下一次转写**，离用户的动作已经很远了。
   */
  const activeNow = (await j('/api/models/active')).body?.active?.vad ?? null;
  if (activeNow) {
    const bad = await j(`/api/models/${encodeURIComponent(activeNow)}`, { method: 'DELETE' });
    assert(
      'A-MODEL-DELETE-ACTIVE-REFUSED',
      bad.status === 409 && bad.body?.error?.code === 'MODEL_IN_USE',
      `删正在用的 ${activeNow} → HTTP ${bad.status} code=${bad.body?.error?.code ?? '(无)'}`,
    );
  } else {
    unknown('A-MODEL-DELETE-ACTIVE-REFUSED', '没有处于 active 的 vad 模型，构造不出前提');
  }

  const victimId = second ? first.id : null;
  if (!victimId) {
    unknown('A-MODEL-DELETE', '没有第二个模型可切换，无法在不影响 active 的前提下删除');
    unknown('A-FREEDBYTES-REAL', '同上');
  } else {
    const rec = (await j('/api/models/installed')).body?.models?.find((m) => m.id === victimId);
    const declaredSize = rec?.totalSizeBytes ?? null;
    const duBefore = duBytes(join(DATA_DIR, 'models'));
    /*
     * ★ 基线必须**紧挨着删除动作**取。
     *   第一版拿的是第 11 节那个 `used1` —— 而两者之间还装了第二个模型，
     *   于是 usedBytes 合理地上升了，断言却把它读成"删除没有释放空间"。
     *   一条拿陈旧基线做比较的断言，红起来说的是别的事。
     */
    const usedBeforeDelete = (await j('/api/models/storage')).body?.usedBytes ?? 0;
    const ev = openEvents();
    await sleep(800); // 让 SSE 真的连上，否则事件会错过

    const del = await j(`/api/models/${encodeURIComponent(victimId)}`, { method: 'DELETE' });
    assert('A-MODEL-DELETE', del.status === 204, `DELETE ${victimId} → HTTP ${del.status}`);
    await sleep(2500);
    await ev.close();

    const duAfter = duBytes(join(DATA_DIR, 'models'));
    const realDelta = duBefore - duAfter;
    const removed = ev.events.find((e) => e.type === 'model.removed' && e.modelId === victimId);
    const freed = removed?.freedBytes ?? null;

    say('');
    say(`   清单声明的体积      ${declaredSize ?? 'UNKNOWN'} B`);
    say(`   事件里的 freedBytes ${freed ?? 'UNKNOWN（没收到 model.removed 事件）'} B`);
    say(`   实测磁盘减少        ${realDelta} B（自己 stat 整棵 models/ 树，前后各一次）`);

    if (freed === null) {
      unknown(
        'A-FREEDBYTES-REAL',
        '没有收到 model.removed 事件 —— 拿不到 freedBytes，无从判断真假',
      );
    } else {
      /*
       * 判据分两半，缺一半都能被糊弄过去：
       *   ① `freedBytes` 不能超过**实测**减少量 —— 超了就是编的（虚报"帮你省了多少"）；
       *   ② 两者的差要很小 —— 差太多说明它统计的根本不是被删掉的那些字节。
       * 允许的差是 manifest 与索引文件那点开销（实测 1218 B），这里给 64 KB 上限。
       * **不写成 `freed === realDelta`**：那会因为无关的日志写入而随机变红，
       *   而一条随机变红的断言等于一条没人信的断言。
       */
      const withinCap = freed <= realDelta && realDelta - freed < 65536;
      assert(
        'A-FREEDBYTES-REAL',
        withinCap,
        withinCap
          ? `freedBytes=${freed} ≤ 实测 ${realDelta}，差 ${realDelta - freed} B（manifest/索引开销），**是真的量出来的**`
          : `freedBytes=${freed} 与实测 ${realDelta} 对不上（差 ${realDelta - freed} B）—— 这个数不可信`,
      );
    }

    const stor2 = await j('/api/models/storage');
    assert(
      'A-STORAGE-AFTER-DELETE',
      (stor2.body?.usedBytes ?? 0) < usedBeforeDelete,
      `删除后 usedBytes ${usedBeforeDelete} → ${stor2.body?.usedBytes}（必须真的下降）`,
    );
  }
}

/** 断点续传：**打断不成就报未验证**，绝不把"没打断成功"写成"续传通过"。 */
async function resumeProbe() {
  hdr('12b. 要求 2.2 ②c：断点续传（真的把下载打断，再续上）');
  const cat = await j('/api/backends/catalog');
  const big = (cat.body?.packs ?? [])
    .filter((p) => p.applicable === true)
    .sort((a, b) => (b.totalSizeBytes ?? 0) - (a.totalSizeBytes ?? 0))[0];
  if (!big || (big.totalSizeBytes ?? 0) < 20 * 1048576) {
    unknown(
      'A-MODEL-RESUME',
      `本平台没有足够大的适用包可供"下到一半打断"（最大 ${big?.id ?? '无'} = ${((big?.totalSizeBytes ?? 0) / 1048576).toFixed(1)} MB）`,
    );
    return;
  }
  say(`   用 ${big.id}（${((big.totalSizeBytes ?? 0) / 1048576).toFixed(0)} MB）`);
  const start = await j('/api/backends/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: big.id }),
  });
  const jid = start.body?.jobId;
  if (!jid) {
    unknown('A-MODEL-RESUME', `安装没有排上队：HTTP ${start.status}`);
    return;
  }
  let interrupted = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const jr = await j(`/api/jobs/${encodeURIComponent(jid)}`);
    const job = jr.body?.job ?? jr.body;
    if (job?.state === 'succeeded' || job?.state === 'failed') break;
    if ((job?.completedBytes ?? 0) > 1_000_000) {
      say(`   已下到 ${job.completedBytes} B，现在打断（走 /api/daemon/shutdown，不是 kill）`);
      await shutdownViaHttp();
      interrupted = true;
      break;
    }
  }
  if (!interrupted) {
    unknown('A-MODEL-RESUME', '没能在下载完成前打断它 —— 那样测的是我手快不快，不是产品');
    await waitHealth(30);
    return;
  }
  const partials = listDir(join(DATA_DIR, 'models', 'blobs')).filter((f) => f.includes('.partial'));
  say(`   打断后 blobs/ 里的半成品：${partials.join(', ') || '(没有)'}`);
  await startDaemon('resume');
  const again = await j('/api/backends/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: big.id }),
  });
  const r = again.body?.jobId
    ? await waitForJob(again.body.jobId, 1200)
    : { state: `HTTP ${again.status}`, detail: '' };
  const got = await j('/api/backends/installed');
  const ok = (got.body?.packs ?? []).some((p) => p.id === big.id);
  assert(
    'A-MODEL-RESUME',
    r.state === 'succeeded' && ok,
    `打断后重新下载 → ${r.state}；打断时留下半成品 ${partials.length} 个；最终装上=${ok}（sha256 由产品自己校验，失败它会 failed）`,
  );
}

/* ════════════════════════ 数据目录 ═══════════════════════════════════════ */

async function phaseDataDir() {
  hdr('15. 数据目录 ①：查看 + 逐目录统计（GET /api/settings/data-dir）');
  const v = await j('/api/settings/data-dir');
  const entries = v.body?.entries ?? [];
  say(`   dataDir = ${v.body?.dataDir}`);
  say(`   usage   = ${JSON.stringify(v.body?.usage ?? null)}`);
  say('   逐目录（用户要的"统计各部分大小"，不是一个总数）：');
  for (const e of entries)
    say(
      `     ${String(e.name).padEnd(14)} ${String(e.bytes).padStart(12)} B  ${e.files} 个文件  ${e.purposeZh ?? ''}`,
    );
  assert(
    'A-DATADIR-VIEW',
    entries.length > 0 &&
      entries.every((e) => typeof e.bytes === 'number' && typeof e.purposeZh === 'string'),
    `${entries.length} 个条目，每条都有 bytes 与中文说明`,
  );

  /* ── 信封校验：这四条守的是 T-174 那个真 bug 的成因本身 ── */
  hdr('16. 数据目录 ②：请求信封（T-174 —— 复选框曾经"在传输层上根本不存在"）');
  const dst = join(ROOT, 'moved');
  const dry0 = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dst, moveExisting: false, dryRun: true }),
  });
  const dry1 = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dst, moveExisting: true, dryRun: true }),
  });
  assert(
    'A-DATADIR-DRYRUN',
    dry0.body?.willMove === false && dry1.body?.willMove === true,
    `试算 willMove：moveExisting=false → ${dry0.body?.willMove}，true → ${dry1.body?.willMove}（两者必须不同，否则复选框又一次不存在）`,
  );

  const unk = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dst, moveExisting: false, movExisting: false }),
  });
  assert(
    'A-DATADIR-UNKNOWN-FIELD',
    unk.status === 400 && unk.body?.error?.code === 'UNKNOWN_FIELD',
    `写错字段名 → HTTP ${unk.status} code=${unk.body?.error?.code ?? '(无)'}（忽略它 = 让缺省值替用户做不可逆决定）`,
  );

  const badFlag = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dst, moveExisting: 'false' }),
  });
  assert(
    'A-DATADIR-BAD-FLAG',
    badFlag.status === 400 && badFlag.body?.error?.code === 'BAD_MOVE_FLAG',
    `字符串 "false" → HTTP ${badFlag.status} code=${badFlag.body?.error?.code ?? '(无)'}（不许做真值转换）`,
  );

  /*
   * ★ 缺省 = **不搬**。判据是两种缺省的失败代价不对称：
   *   缺省不搬，最坏是指针指向一个不是数据目录的地方 → 当场 409、一个字节没动；
   *   缺省搬，最坏是几十 GB 跨盘搬迁 + 不可逆。
   */
  const emptyTarget = join(ROOT, 'not-a-datadir');
  mkdirSync(emptyTarget, { recursive: true });
  const omitted = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: emptyTarget }),
  });
  const srcIntact = existsSync(join(DATA_DIR, 'openmemo.db'));
  assert(
    'A-DATADIR-DEFAULT-NOMOVE',
    omitted.status === 409 && omitted.body?.error?.code === 'NOT_A_DATA_DIR' && srcIntact,
    `字段缺席 → HTTP ${omitted.status} code=${omitted.body?.error?.code ?? '(无)'}；源目录 openmemo.db 仍在=${srcIntact}`,
  );

  /* ── 真搬 ── */
  hdr('17. 数据目录 ③：真的搬（moveExisting:true）');
  const srcBefore = listDir(DATA_DIR);
  const bytesBefore = duBytes(DATA_DIR);
  say(`   搬之前：源 ${srcBefore.length} 个顶层条目、${bytesBefore} B`);
  /*
   * ★ **必须先记下旧 pid**。
   *
   * 搬完 daemon 会自我重启，而**老进程在交接期间仍然在应答** ——
   * 直接 `waitHealth()` 会拿到老进程那份「dataDir 还是旧路径」的回答，
   * 然后把一次**成功的搬迁**判成失败。第一版就是这么红的，
   * 而那条红看起来完全像产品的问题（"搬了但重启没生效"）。
   * 判据换成"**pid 变了**的那一份 health"，这个竞态就不存在了。
   */
  const pidBeforeMove = (await j('/api/health')).body?.pid ?? null;
  const mv = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dst, moveExisting: true }),
  });
  say(`   POST → HTTP ${mv.status} ${JSON.stringify(mv.body).slice(0, 260)}`);
  const h = await waitHealth(120, pidBeforeMove);
  const srcAfter = listDir(DATA_DIR);
  const dstAfter = listDir(dst);
  say(`   搬之后：源 [${srcAfter.join(' ')}]`);
  say(`           新 [${dstAfter.join(' ')}]`);
  say(`   重启后 health.dataDir = ${h?.dataDir}`);
  /*
   * ── 判据是「界面说的和实际发生的一致」，**不是**「必须走 rename」───────────
   *
   * Manager 2026-08-08 裁定：跨卷 rename 在 Windows 上本来就会失败，`copy` 是
   * 必要退路；所以不许拿"源目录空没空"单独当红线。
   *
   * `[CI 实测 run 31250730491，windows-2025]` 真正的缺陷是**那句话**：
   * copy 走完、`fs.rm(from)` 失败（删不掉仍被打开的 openmemo.db），
   * 而返回里照旧写着「已移动 54 个文件到新位置」——
   * 数据被复制了一份留在原地，其中含明文 `secrets.json`，用户以为旧位置空了。
   *
   * 所以这里查三件事：
   *   ① 数据真的到了新位置、重启后 daemon 也挂在那儿（这条无论哪种策略都必须成立）；
   *   ② `sourceRemoved` 必须**如实**反映源目录还在不在；
   *   ③ 源目录还在时，文案**不许**出现"已移动"，而且要点名旧目录的位置。
   */
  const srcEmpty = srcAfter.length === 0;
  /*
   * ★ 2026-08-10：从"文案里有没有『已移动』这三个字"改成**数据核对**。
   *
   * 旧判据 `claimsMoved = messageZh.includes('已移动')`。产品把话改成
   * 「已搬迁」「迁移完成」「转移到新位置」—— `claimsMoved` 变 false，
   * `honest` 变 true，**这条断言绿，而它正在对一次不可逆操作撒谎**。
   * `[实测 A/B]` 同一份事故数据（源目录还在、文案写着「已搬迁 54 个文件到新位置」）：
   *     旧判据 → claimsMoved=false → honest=true → **绿（假过）**
   *     新判据 → 残留清单没被念出来 → **红**
   *
   * 新判据不读措辞，只核对**数据**：
   *   ① `sourceRemoved` 与磁盘一致（原有，结构）；
   *   ② 源目录还在时，`sourceResidue` 必须与磁盘上真实剩下的东西一致 —— 这是"诚实"本身；
   *   ③ 且这些**文件名**必须逐个出现在给用户的那句话里。
   * 文件名是**数据不是措辞**：句子怎么重写，它们都得在，否则用户不知道去哪儿找。
   * （产品侧 `rest/storage.ts:298` 的注释亲口写着「旧目录里剩什么，必须照着念，不许照着猜」——
   *  这条腿现在核对的正是那句话。）
   */
  const residue = Array.isArray(mv.body?.sourceResidue) ? mv.body.sourceResidue.map(String) : [];
  const msgZh = String(mv.body?.messageZh ?? '');
  const residueMatchesDisk =
    srcEmpty ||
    (residue.length > 0 &&
      residue.every((r) => srcAfter.some((f) => String(f).includes(r) || r.includes(String(f)))));
  const residueSpokenOut = srcEmpty || residue.every((r) => msgZh.includes(r));
  const landed =
    mv.status === 202 &&
    mv.body?.moved === true &&
    dstAfter.includes('openmemo.db') &&
    h?.dataDir === dst;
  const honest = mv.body?.sourceRemoved === srcEmpty && residueMatchesDisk && residueSpokenOut;
  assert(
    'A-DATADIR-MOVE',
    landed && honest,
    `strategy=${mv.body?.strategy} files=${mv.body?.files}；数据到位=${landed}；` +
      `源已空=${srcEmpty}，sourceRemoved=${mv.body?.sourceRemoved}（两者必须一致）；` +
      `残留清单与磁盘一致=${residueMatchesDisk}（sourceResidue=${JSON.stringify(residue)}，磁盘上=${JSON.stringify(srcAfter)}）；` +
      `残留逐个念给了用户=${residueSpokenOut}` +
      (srcEmpty ? '' : `（源目录还在，就必须点名剩下的是什么 —— 不许只说"完成了"）`) +
      `；重启后挂在 ${h?.dataDir}`,
  );
  if (!srcEmpty) {
    note(
      `ⓘ 本平台走的是 copy 且源目录没删掉（Windows 删不掉仍被打开的 openmemo.db）——` +
        `只要产品如实说了，这**不是**缺陷。产品的原话：${String(mv.body?.messageZh ?? '').slice(0, 160)}`,
    );
  }

  /* ── 只切换不搬 ── */
  hdr('18. 数据目录 ④：★ 只切换不搬（moveExisting:false）—— 别让 T-174 退化');
  say('   这一条守的是用户实际撞到的那个 bug：**取消勾选「把现有数据一并移动过去」，');
  say('   系统照样把几十 GB 搬走了**，因为前端发 `moveExisting`、daemon 读 `move`，');
  say('   两个名字从来没对上过，而缺省是"搬"。');

  const switched = join(ROOT, 'switched');
  cpSync(dst, switched, { recursive: true });
  try {
    rmSync(join(switched, 'daemon.lock'), { force: true });
  } catch {
    /* 没有就算了 */
  }
  const beforeSwitchSrc = duBytes(dst);
  const pidBeforeSwitch = (await j('/api/health')).body?.pid ?? null;
  const sw = await j('/api/settings/data-dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: switched, moveExisting: false }),
  });
  say(`   POST → HTTP ${sw.status} ${JSON.stringify(sw.body).slice(0, 260)}`);
  const h2 = await waitHealth(120, pidBeforeSwitch);
  const srcStillDb = existsSync(join(dst, 'openmemo.db'));
  const srcStillBytes = duBytes(dst);
  say(
    `   源目录（${dst}）现在：openmemo.db 在=${srcStillDb}，${srcStillBytes} B（切换前 ${beforeSwitchSrc} B）`,
  );
  say(`   重启后 health.dataDir = ${h2?.dataDir}`);

  /*
   * 判据刻意是「源目录里 openmemo.db **还在**」而不是「条目数一模一样」：
   * daemon 干净关库时会 checkpoint 掉 `-wal` / `-shm` 并删掉 `daemon.lock`，
   * 那是正常的，按条目数比会**随机变红** —— 而随机变红的断言等于没人信的断言。
   */
  assert(
    'A-DATADIR-SWITCH-ONLY',
    sw.status === 202 && sw.body?.moved === false && srcStillDb && h2?.dataDir === switched,
    `moved=${sw.body?.moved}；**源目录数据仍在**（openmemo.db 存在=${srcStillDb}）；重启后挂在 ${h2?.dataDir}`,
  );

  /* ── 删掉数据目录之后还能不能起来 ── */
  hdr('19. 数据目录 ⑤：删掉数据目录之后，程序仍能启动并重建');
  await shutdownViaHttp();
  rmSync(switched, { recursive: true, force: true });
  say(`   已删除 ${switched}（指针仍然指着它 —— 这正是用户"手动删掉文件夹"之后的状态）`);
  say(`   指针此刻的内容：${readFileSync(POINTER, 'utf8').replace(/\s+/g, ' ')}`);
  say('   ★ 起 daemon 时**只给 --port** —— 它去哪只能由指针决定，这才是在测那条机制。');
  const h3 = await startDaemon('rebuilt');
  const rebuilt = existsSync(join(switched, 'openmemo.db'));
  assert(
    'A-DATADIR-REBUILD',
    h3.ready === true && rebuilt,
    `daemon 重新起来了（pid=${h3.pid}），并在 ${h3.dataDir} 重建了空库（openmemo.db 存在=${rebuilt}）`,
  );
}

/* ════════════════════════ 自检 ═══════════════════════════════════════════ */

async function phaseDiagnostics() {
  hdr('20. 自检：/diagnostics 那套的数据源（GET /api/selfcheck）—— 逐项贴出来');
  const r = await j('/api/selfcheck');
  const checks = r.body?.results ?? r.body?.checks ?? [];
  assert(
    'A-DIAG-REACHABLE',
    r.status === 200 && checks.length > 0,
    `HTTP ${r.status}，${checks.length} 项`,
  );
  if (checks.length === 0) return;

  say('');
  say('   layer      id                        status  required  detail');
  say('   ' + '-'.repeat(104));
  for (const c of checks) {
    say(
      `   ${String(c.layer ?? '').padEnd(10)} ${String(c.id).padEnd(25)} ${String(c.status).padEnd(7)} ${String(c.required ?? '').padEnd(9)} ${String(
        c.detail ?? '',
      )
        .replace(/\s+/g, ' ')
        .slice(0, 120)}`,
    );
  }
  const by = (s) => checks.filter((c) => c.status === s).length;
  say('');
  say(
    `   合计：ok=${by('ok')} warn=${by('warn')} fail=${by('fail')}（counts=${JSON.stringify(r.body?.counts ?? null)}，ok 字段=${r.body?.ok}）`,
  );

  /* ── ★ "借宿主工具几个" —— 用产品自己的判据，不另发明一套 ── */
  hdr('21. ★ 借了宿主几个工具（判据用产品自己的 selfcheck 分类）');
  const tools = checks.filter((c) => String(c.id).startsWith('tool.'));
  const own = tools.filter((c) => c.status === 'ok');
  const borrowed = tools.filter((c) => c.status === 'warn' && /PATH/i.test(String(c.detail ?? '')));
  const missing = tools.filter(
    (c) => c.status === 'fail' || (c.status === 'warn' && !/PATH/i.test(String(c.detail ?? ''))),
  );
  say(`   ✅ 产品自己下载并校验的 (${own.length})：${own.map((c) => c.id).join(', ') || '(无)'}`);
  say(
    `   ⚠️ 借宿主 PATH 的       (${borrowed.length})：${borrowed.map((c) => c.id).join(', ') || '(无)'}`,
  );
  say(
    `   ❌ 装不上/不可用        (${missing.length})：${missing.map((c) => c.id).join(', ') || '(无)'}`,
  );
  for (const c of borrowed)
    say(`      借用明细：${c.id} → ${String(c.detail ?? '').slice(0, 140)}`);

  /*
   * ── 判据要分成两句话，混成一句必然错 ───────────────────────────────────────
   *
   * 屏蔽的手法是**在 PATH 最前面放同名假二进制**（照抄 cold-start-audit），
   * 它的设计意图是「让借用**可见**，而不是被消除」——
   * 所以屏蔽一旦生效，产品**必然**会解析到那些 shim。
   *
   * 于是「借用数 == 0」是个**永远达不到、方向也不对**的判据：第一版就是这么写的，
   * 而它红的时候，说的其实是"屏蔽成功了"。
   *
   * 拆成两句：
   *   ① **红线**：有没有解析到 shim 之外的**真宿主路径**。有 = 屏蔽被绕过去了
   *      （比如产品哪天改成扫绝对路径而不查 PATH），那才是真的"借了宿主的东西"。
   *   ② **报数**：几个工具落在 shim 上 —— 这就是用户要的那个「借宿主工具几个」：
   *      **不屏蔽的话，产品会去借的就是这几个**。它不改红绿，因为在没装
   *      media-tools / ytdlp 包的这一轮里，产品去 PATH 上找是**正确行为**
   *      （它还没有自己的那一份）。
   */
  const detailOf = (c) => String(c.detail ?? '');
  const onShim = borrowed.filter((c) => detailOf(c).includes(MASK_BIN));
  /*
   * ★★ 「包**自己带的**工具」不是「借宿主的」—— 这条判据被 0.4.0 那批包证伪了。
   *
   * ── 此前的预期，以及它为什么曾经成立 ────────────────────────────────────
   *
   * 原判据是：**selfcheck 归到 `warn`(来自 PATH) 且路径不在 shim 目录里 ⇒ 借了宿主的**。
   * 它当时是对的，因为那个世界里**包里一个工具都不带** ——
   * storeRoot 之外的路径必然来自宿主机器。
   *
   * ── 哪次改动让它过期 ────────────────────────────────────────────────────
   *
   * `[CI 实测 run 31272189218，三平台全中同一条]` 0.4.0 起
   * **CPU 基线转写链随包出厂**，与探针共用一份 ggml，落在包内 `runtime/probe/`
   * （`scripts/build-bundle.mjs:855-861` 明写把 `whisper-vad-speech-segments`
   * 与 `whisper-cli` 塞进去，理由是"为了不长出第二份 ggml"）。于是：
   *
   *   ✘ A-NO-HOST-BORROW-REAL 屏蔽被绕过：tool.whisperVad →
   *     <解压出来的包>/runtime/probe/whisper-vad-speech-segments
   *
   * 那个路径**在包里面**：既不是宿主的东西，也不是屏蔽被绕过 ——
   * 就是产品自己带的那一份。**红的是判据，不是产品。**
   *
   * ── 判据改成什么（守的东西一个字没松）────────────────────────────────────
   *
   * 真正的"借宿主" = 解析到的路径**既不在 shim 里、也不在包里**。
   * （storeRoot 里的 selfcheck 本来就归 `ok`，进不到 `borrowed`。）
   * **产品去够宿主机器上的东西，仍然当场红。**
   */
  const inBundle = (c) => BUNDLE_DIR !== null && detailOf(c).includes(BUNDLE_DIR);
  const fromBundle = borrowed.filter((c) => !detailOf(c).includes(MASK_BIN) && inBundle(c));
  const realHost = borrowed.filter((c) => !detailOf(c).includes(MASK_BIN) && !inBundle(c));
  say('');
  if (fromBundle.length > 0) {
    say('');
    say(`   ⓘ 包自己带的工具 ${fromBundle.length} 个（**不算借宿主**）：`);
    for (const c of fromBundle) say(`      ${c.id} → ${detailOf(c).slice(0, 110)}`);
  }
  say(`   ★ 借宿主工具几个：**${MASK ? onShim.length : borrowed.length}** 个`);
  say('     （屏蔽下它们落在 shim 上；不屏蔽的话，产品会去借的就是这几个：');
  say(
    `      ${(MASK ? onShim : borrowed).map((c) => c.id.replace(/^tool\./, '')).join(', ') || '(无)'}）`,
  );
  assert(
    'A-NO-HOST-BORROW-REAL',
    realHost.length === 0,
    realHost.length === 0
      ? `屏蔽了 ${HOST_TOOLS.length} 个名字；没有任何工具解析到 shim 以外的真宿主路径`
      : `**屏蔽被绕过**：${realHost.map((c) => `${c.id} → ${detailOf(c).slice(0, 80)}`).join(' | ')}`,
  );

  /*
   * ★ 反过来也要有人守：**shim 必须真的被产品看见**。
   *
   * 如果一个工具都没落在 shim 上，只有两种可能：产品自己装齐了（那 `own` 会非空），
   * 或者**屏蔽根本没生效**（PATH 没传进去 —— 本轮真发生过一次）。
   * 没有这一条，上面那条红线会在"屏蔽失效且宿主也恰好没装"时静静地绿着，
   * 而那正是 GitHub ubuntu runner 的样子。
   */
  if (MASK && tools.length > 0) {
    assert(
      'A-MASK-EFFECTIVE',
      onShim.length > 0 || own.length + fromBundle.length === tools.length,
      onShim.length > 0
        ? `${onShim.length} 个工具解析到了 shim ⇒ 屏蔽确实传到 daemon 里了`
        : own.length + fromBundle.length === tools.length
          ? '所有工具都由产品自己提供（storeRoot 内或包内），没有东西需要去 PATH 上找'
          : '**没有任何工具落在 shim 上，产品也没有自己装齐** —— 屏蔽很可能压根没生效',
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 收尾                                                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

try {
  await main();
} catch (e) {
  say('');
  say(`✘ 审计中断：${e.message}`);
  if (proc) say(`   daemon 进程：exitCode=${proc.exitCode} signal=${proc.signalCode}`);
  if (daemonLogs.length) {
    /*
     * ★★ 这份缓冲区**不是"当前失败现场"的日志** —— 它是本轮最早那个被
     * `proc.stdout.on('data', …)` 接住的进程的输出。自重启起的继任者是
     * `detached`，`proc` 一旦被 `restartViaHttp()` 置空就再也没有新数据流进来，
     * 所以只要发生过至少一次重启，这里 dump 出来的就是**一个更早、可能已经
     * 退出的进程**的尾巴，跟这次失败是不是同一个进程无关（Manager 2026-08-11
     * 裁决，#77 runtime 复检：之前这里的标签"daemon 最后 60 行"没说清楚是谁的
     * 日志，查错的人会在一份看似相关、实则来自另一个进程的日志上推理）。
     */
    say(
      proc === null
        ? '   本轮发生过至少一次自重启：以下不是失败现场那个进程的日志，' +
            '是重启前那个（更早、可能已退出的）进程冻结在缓冲区里的尾部——'
        : '   daemon 最后 60 行（当前唯一存在过的进程，没发生过自重启）：',
    );
    say(tail(daemonLogs, 60));
  }
  /*
   * 继任者自己的账——见 main.ts 的 captureConsoleToFile()：接班者起来后会在一个
   * 有界窗口内（接班等待窗口 + 余量）把自己的 console.{log,warn,error,info}
   * 抄一份到 `<dataDir>/logs/restart.log`（每次重启覆盖，不追加；窗口外不再变化，
   * 不会跟迁移搬迁校验之类后续操作打架——这是吃过一次亏才这样设计的）。
   * 这是失败现场唯一可能反映"继任者自己说了什么"的地方。
   */
  const restartLogPath = join(DATA_DIR, 'logs', 'restart.log');
  if (existsSync(restartLogPath)) {
    say(`   继任者自己的日志（落盘：${restartLogPath}）：`);
    say(
      readFileSync(restartLogPath, 'utf8')
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  /*
   * ★★ #77 finding① 分段打点（Manager 2026-08-11 裁决）：前任自己的账——
   * 同一个 captureConsoleToFile()，前任在调用 stop() 之前给自己也挂一份
   * 有界窗口抄写，写到同一个 dataDir 下的 `logs/restart-predecessor.log`
   * （文件名不同，不会跟继任者那份互相覆盖）。stop() 分 6 段各打一条
   * 时间戳，server.close() 之前还单独记一次"还有几条连接、来自谁"——
   * 这是唯一能看出 15s 接班窗口到底卡在哪一段（还是根本没卡在 stop()
   * 里、是 pidAlive() 的 Windows 语义问题）的地方。
   */
  const restartPredecessorLogPath = join(DATA_DIR, 'logs', 'restart-predecessor.log');
  if (existsSync(restartPredecessorLogPath)) {
    say(`   前任自己的账（落盘：${restartPredecessorLogPath}）：`);
    say(
      readFileSync(restartPredecessorLogPath, 'utf8')
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  results.push({ id: 'A-RUN-COMPLETED', status: 'FAIL', detail: e.message });
} finally {
  await shutdownViaHttp();
}

/* ── 真实机器指针核对（PROTOCOL §9，这一条是**最后一道**，也是最重的一道）── */
hdr('22. ★ 真实机器指针有没有被碰过（PROTOCOL §9）');
const POINTER_AFTER = pointerSnapshot();
say(`   路径      ${POINTER_AFTER.path}`);
say(
  `   跑之前    ${POINTER_BEFORE.exists ? `sha256=${POINTER_BEFORE.sha256} mtime=${POINTER_BEFORE.mtimeMs} size=${POINTER_BEFORE.size}` : '(不存在)'}`,
);
say(
  `   跑之后    ${POINTER_AFTER.exists ? `sha256=${POINTER_AFTER.sha256} mtime=${POINTER_AFTER.mtimeMs} size=${POINTER_AFTER.size}` : '(不存在)'}`,
);
const pointerSame =
  POINTER_BEFORE.exists === POINTER_AFTER.exists &&
  POINTER_BEFORE.sha256 === POINTER_AFTER.sha256 &&
  POINTER_BEFORE.mtimeMs === POINTER_AFTER.mtimeMs;
assert(
  'A-POINTER-UNTOUCHED',
  pointerSame,
  pointerSame
    ? POINTER_BEFORE.exists
      ? 'sha256 与 mtime 都没变'
      : '本来就不存在，跑完仍然不存在'
    : '**真实机器指针被改动了** —— 这正是 T-142 那场事故的形态，立刻查',
);

/* ── 汇总 ── */
hdr('23. 汇总');
const fails = results.filter((r) => r.status === 'FAIL');
const unknowns = results.filter((r) => r.status === 'UNKNOWN');
const passes = results.filter((r) => r.status === 'PASS');
say(`   PASS ${passes.length}   FAIL ${fails.length}   UNKNOWN ${unknowns.length}`);
/*
 * ★ 覆盖面落盘（仅非变异模式）。变异模式下面还有一段完全不同的汇总
 * （targets/wentRed/allUnknown），回答的是另一个问题（"这条变异会不会被抓住"），
 * 与"这条腿本轮有多少条断言无从判断"不是同一件事，所以这里显式排掉它。
 * 不看 fails.length —— 这是展示用的覆盖面计数，不是判定，红也要如实落盘。
 */
if (!mutation && UNDECIDED_OUT) {
  mkdirSync(dirname(UNDECIDED_OUT), { recursive: true });
  writeFileSync(UNDECIDED_OUT, `${JSON.stringify({ unknowns: unknowns.length }, null, 2)}\n`);
  say(`   覆盖面已写到 ${UNDECIDED_OUT}（unknowns=${unknowns.length}）`);
}
if (fails.length) {
  say('');
  say('   红的：');
  for (const f of fails) say(`     ✘ ${f.id.padEnd(30)} ${f.detail}`);
}
if (unknowns.length) {
  say('');
  say('   UNKNOWN（前提在本 runner 上构造不出来 —— **不是通过**）：');
  for (const u of unknowns) say(`     ? ${u.id.padEnd(30)} ${u.detail}`);
}
if (findings.length) {
  say('');
  say('   ⚠ 本轮发现的真实缺陷（不改退出码 —— 它们是产品的问题，不是本脚本的判据）：');
  for (const f of findings) say(`     · ${f.title}`);
}

if (mutation) {
  /*
   * ★ 变异模式：**语义反过来**。
   *   这一轮存在的全部意义是回答「把这个安全性质拿掉，那条断言会不会红」。
   *   红了 → 那条断言真的在守东西；没红 → 它证明不了任何事，必须当场说出来。
   */
  hdr('24. 变异判定');
  const targets = results.filter((r) => mutation.proves.includes(r.id));
  say(`   变异 ${mutation.id}`);
  say(`   目标断言 ${mutation.proves.join(', ')}`);
  for (const t of targets) say(`     ${t.status.padEnd(8)} ${t.id}  ${t.detail}`);
  const missingTargets = mutation.proves.filter((id) => !results.some((r) => r.id === id));
  for (const id of missingTargets) say(`     ABSENT   ${id}（本轮根本没跑到这条断言）`);

  const wentRed = targets.some((t) => t.status === 'FAIL');
  const allUnknown = targets.length > 0 && targets.every((t) => t.status === 'UNKNOWN');
  if (wentRed) {
    say('');
    say('   ✔ 变异被抓住了 —— 这条断言是有牙齿的。');
    exitCode = 0;
  } else if (allUnknown) {
    say('');
    say(
      '   ? 目标断言在本 runner 上是 UNKNOWN（前提构造不出来），所以这条变异在这里什么都证明不了。',
    );
    say('     **如实报为未验证**，不当成通过，也不当成失败。');
    /*
     * ★ 这里原本是 `exitCode = 0`。
     *
     * 屏幕上写着"什么都证明不了"，退出码却说通过 —— **只看退出码的调用方会把它读成
     * "守卫已验证"，而 CI 恰恰就是这种调用方**。文字与退出码不同调，等于把结论交给
     * "有没有人读日志"这件靠不住的事。
     *
     * 但也不能改成 1：那样它就和"变异存活"（真有东西坏了）混在一起，
     * 排查的人会去修一个根本没坏的东西 —— 那正是本轮另一条教训的形状
     * （`ERR_MODULE_NOT_FOUND` 也是 exit=1，差点被当成锚点失配）。
     *
     * 所以给它**单独一个码 3 = 跑起来了但什么都没证明**（见文件头的退出码表）。
     * 想容忍这一档的调用方显式判 `=== 3`；只判"非 0"的调用方会当失败 ——
     * **那个默认方向是对的**：没验到就不该算验过。
     */
    exitCode = 3;
  } else {
    say('');
    say('   ✘ **变异存活** —— 把这个安全性质拿掉，断言照样是绿的。');
    say(`     坏了会怎样：${mutation.why}`);
    say('     这条断言现在等于不存在，修它比修产品更急。');
    exitCode = 1;
  }
} else {
  exitCode = fails.length > 0 ? 1 : 0;
}

say('');
say(`   临时根 ${ROOT} 留在 runner 上，随 runner 一起销毁。`);
say(`   指针用的是 ${POINTER}（不是全局那个）—— PROTOCOL §9。`);
/*
 * ★ 把退出码连同它的含义一起打出来。
 * 「屏幕上说的」和「退出码说的」必须能被同一眼看到 —— 这两者不同调过一次（allUnknown → 0），
 * 而只看其中一个的人（人看屏幕、CI 看码）会得出相反的结论。
 */
say(
  `   退出码 ${exitCode} —— ${
    {
      0: '通过',
      1: '失败（有断言 FAIL / 变异存活）',
      2: '跑不起来（前提没成立）',
      3: '跑起来了，但什么都没证明（目标断言全 UNKNOWN）',
    }[exitCode] ?? '未定义'
  }`,
);
process.exit(exitCode);
