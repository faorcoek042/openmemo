#!/usr/bin/env node
/**
 * 量一次后端包安装的**真实事件序列**，重点是 `installing → succeeded` 这一段。
 *
 * ## 为什么要有这条腿
 *
 * 用户报「任务中心停在**正在安装**」。SSE 实测已排除三种解释
 * （事件没发 / 被终态超车 / 真的卡住），**是第四种**：
 *
 * > `installing` 只有"开始"这一个点。`[实测 linux-x64]` 它与 `succeeded` 之间
 * > **0 个事件、14ms** —— 也就是说「正在安装」的显示时长 ≡ 解包 + chmod + 写清单
 * > 的耗时，而那一整段是**全黑的**。
 *
 * Linux 上 14ms 没人看得见。**Windows 上要解开归档、且每个解出的文件会被
 * Defender 实时扫** —— 推断是几十秒到数分钟，期间零事件，与"真卡住"无法区分。
 *
 * ⚠️ **但那是推断，不是实测。** 这条腿就是来把它变成数的。
 * **如果 Windows 上也是毫秒级，那用户的卡住另有原因** ——
 * 这条腿的产出会直接推翻"解包慢"这个假设，而不是替它背书。
 *
 * ## 它不是门禁
 *
 * 本脚本**只测量、不判红绿**（拿不到数才失败）。阈值目前无人知道该定在哪 ——
 * 先有数，再谈判据。
 *
 * ## 纪律
 *
 * - 端口与进程收尾一律用 `launcher-spawn.mjs` 的共享实现
 *   （`assertPortFree` 判据是"能不能被我占住"，不是"有没有人答话"；`killTree` 按进程组收）。
 * - **绝不硬编码包 id**：装哪个包由产品自己的目录回答，
 *   目录里没有可装的 —— **那本身就是结论**，不是换个 id 再试。
 */
import { assertPortFree, killTree, killTreeHard, spawnDaemon } from './launcher-spawn.mjs';

const args = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BUNDLE = argOf('--bundle');
const REPO = argOf('--repo', process.cwd());
const PORT = Number(argOf('--port', '19741'));
/*
 * `--largest`：挑本平台**最大**的那个包。
 * 理由：`[CI 实测 run 31309026824]` 用 4.0 MB / 18 个文件的 cpu 包量到 5ms，
 * 但 Windows 的 CUDA 包是 **677.9 MB** —— 170 倍。
 * 「小包毫秒级」**不能**推出「大包也毫秒级」，要下结论就得把大的那个也量一遍。
 */
const LARGEST = args.includes('--largest');
/*
 * `--model`：量**模型**那条路（`POST /api/models/pull`），而不是后端包那条。
 *
 * 为什么必须单独量：`[CI 实测]` 后端包是 4–25 MB，而 `ggml-large-v3` 约 **3 GB**
 * —— 差三个数量级。**用 A 的测量替 B 背书，是这一轮最贵的几次错的共同形状。**
 * `--model-max-mb` 用来降档（CI 上 3 GB 太贵），降了必须在结论里说清降到哪一档。
 */
const MODEL_MODE = args.includes('--model');
const MODEL_MAX_MB = Number(argOf('--model-max-mb', '2000'));
const BASE = `http://127.0.0.1:${PORT}`;
const say = (s) => console.log(s);

if (!BUNDLE) {
  console.error(
    '用法：node scripts/ci/measure-install-phases.mjs --bundle <解开的包根> [--port N]',
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}

/**
 * 等终态 → 打完整时间线 → **找"耗时 > 1s 且 0 事件"的段**。
 *
 * 最后那一项才是重点：用户盯着不动的那几秒，就是这种段。
 * 只报"某一步多久"不够 —— 慢不慢要看**它有没有在说话**。
 */
async function waitTerminalAndReport(label) {
  const deadline = Date.now() + 900_000;
  for (;;) {
    const done = events.some(
      (e) =>
        e.ev?.type === 'job.state' &&
        (e.ev.state === 'succeeded' || e.ev.state === 'failed' || e.ev.state === 'blocked'),
    );
    if (done) break;
    if (Date.now() > deadline) {
      say('   ⚠️ 15 分钟没等到终态 —— 那本身是重要结论，如实记下');
      process.exitCode = 1;
      break;
    }
    await sleep(250);
  }
  await sleep(1200);
  ac?.abort();
  await sseDone;

  say('\n──── 完整事件序列（相对提交时刻）────');
  for (const { at, ev } of events) {
    const t = String(at - (t0 ?? at)).padStart(7);
    const kind = ev.type ?? '?';
    const extra =
      kind === 'job.progress'
        ? `step=${ev.step ?? '?'} pct=${ev.pct ?? 'null'}`
        : kind === 'job.state'
          ? `state=${ev.state}`
          : '';
    say(`t=${t}ms  ${String(kind).padEnd(15)} ${extra}`);
  }

  /* ── 黑窗分析：相邻两个事件之间超过 1s 的空档 ───────────────────────────── */
  say('\n──── 黑窗（相邻事件间隔 > 1s，即"耗时长且 0 事件"的段）────');
  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    const dt = events[i].at - events[i - 1].at;
    if (dt > 1000) {
      const prev = events[i - 1].ev;
      const next = events[i].ev;
      gaps.push({
        ms: dt,
        from: `${prev.type ?? '?'}${prev.step ? `(step=${prev.step})` : ''}`,
        to: `${next.type ?? '?'}${next.step ? `(step=${next.step})` : ''}`,
      });
    }
  }
  if (gaps.length === 0) {
    say('   （无：没有任何相邻事件间隔超过 1 秒）');
  } else {
    gaps.sort((a, b) => b.ms - a.ms);
    for (const g of gaps) {
      say(`   ⚠️ ${String(g.ms).padStart(7)} ms  0 事件   ${g.from}  →  ${g.to}`);
    }
    say(`   合计 ${gaps.length} 段，最长 ${gaps[0].ms} ms —— **用户盯着不动的就是这些段**`);
  }

  const firstInstalling = events.find(
    (e) => e.ev?.type === 'job.progress' && e.ev.step === 'installing',
  );
  const terminal = events.find(
    (e) => e.ev?.type === 'job.state' && ['succeeded', 'failed', 'blocked'].includes(e.ev.state),
  );
  say('\n──── installing → 终态 ────');
  say(`平台：${process.platform}-${process.arch}   目标：${label}`);
  if (!firstInstalling) {
    say('✘ 整段里**没有** step=installing');
    process.exitCode = 1;
  } else if (!terminal) {
    say('✘ 没等到终态');
    process.exitCode = 1;
  } else {
    const between = events.filter(
      (e) => e.at > firstInstalling.at && e.at < terminal.at && e.ev?.type === 'job.progress',
    );
    say(
      `installing → ${terminal.ev.state}：**${terminal.at - firstInstalling.at} ms**，其间 job.progress **${between.length}** 条`,
    );
  }
  /* 各 step 停留多久 —— 回答"哪一步慢" */
  say('\n──── 每个 step 停留时长 ────');
  const steps = events.filter((e) => e.ev?.type === 'job.progress' && e.ev.step);
  for (let i = 0; i < steps.length; i++) {
    const cur = steps[i];
    const nextDifferent = steps.slice(i + 1).find((x) => x.ev.step !== cur.ev.step);
    if (i > 0 && steps[i - 1].ev.step === cur.ev.step) continue; // 只在该 step 第一次出现时算
    const end = nextDifferent ? nextDifferent.at : (terminal?.at ?? cur.at);
    const n = steps.filter(
      (x) => x.ev.step === cur.ev.step && x.at >= cur.at && x.at <= end,
    ).length;
    say(
      `   ${String(cur.ev.step).padEnd(12)} ${String(end - cur.at).padStart(7)} ms   ${n} 条事件`,
    );
  }
}

let proc = null;
const events = [];
let t0;
/* SSE 的收尾句柄要在模块级 —— `waitTerminalAndReport()` 要用它们停流。 */
let ac = null;
let sseDone = null;

try {
  await assertPortFree(PORT, { label: '量 installing 之前', log: say });

  const started = spawnDaemon({
    bundleDir: BUNDLE,
    repoRoot: REPO,
    args: ['--port', String(PORT)],
    env: { OPENMEMO_AUTH: 'none' },
  });
  proc = started.proc;
  say(`   daemon 启动方式：${started.note}`);
  if (!(await waitHealthy())) throw new Error('daemon 没能在 90s 内起来');

  // ── 接真事件流（不轮询：轮询会让"太短没抓到"变成一个解释）──────────────────
  ac = new AbortController();
  sseDone = (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try {
            events.push({ at: Date.now(), ev: JSON.parse(line.slice(5).trim()) });
          } catch {
            /* 心跳等非 JSON 行 */
          }
        }
      }
    } catch {
      /* abort = 正常收尾 */
    }
  })();
  await sleep(500);

  // ── 装哪个包，由产品自己的目录回答 ────────────────────────────────────────
  if (MODEL_MODE) {
    const mcat = await (await fetch(`${BASE}/api/models/catalog`)).json();
    const all = mcat.models ?? mcat.entries ?? [];
    const cands = all
      .filter(
        (m) =>
          (m.installed === false || m.installed === undefined) &&
          (m.totalSizeBytes ?? m.sizeBytes ?? 0) > 0,
      )
      .filter((m) => (m.totalSizeBytes ?? m.sizeBytes ?? 0) <= MODEL_MAX_MB * 1e6)
      .sort(
        (a, b) => (b.totalSizeBytes ?? b.sizeBytes ?? 0) - (a.totalSizeBytes ?? a.sizeBytes ?? 0),
      );
    if (cands.length === 0) {
      say(`目录里没有 ≤ ${MODEL_MAX_MB} MB 的可装模型 —— 量不到就是量不到。`);
      say(JSON.stringify(all.slice(0, 3)).slice(0, 600));
      process.exit(1);
    }
    // 取**上限之内最大的**：越大越能暴露"耗时长且零事件"的段
    const m = cands[0];
    const mb = ((m.totalSizeBytes ?? m.sizeBytes ?? 0) / 1e6).toFixed(1);
    say(`   选中模型：${m.id}（${mb} MB，上限 ${MODEL_MAX_MB} MB）`);
    t0 = Date.now();
    const r = await fetch(`${BASE}/api/models/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m.id }),
    });
    say(`   POST /api/models/pull → ${r.status}`);
    if (r.status >= 400) {
      say(`✘ 被拒（${r.status}）：${(await r.text()).slice(0, 300)} —— 量不到就是量不到。`);
      process.exit(1);
    }
    await waitTerminalAndReport(`${m.id}（${mb} MB）`);
    process.exit(process.exitCode ?? 0);
  }

  const cat = await (await fetch(`${BASE}/api/backends/catalog`)).json();
  /*
   * ⚠️ **必须按本平台过滤**。
   *
   * `[CI 实测 run 31308462522]` 第一版只按"最小"挑，于是三平台都挑中了
   * `whispercpp-metal-macos-arm64`（2.01 MB）—— 在 windows/linux 上
   * `POST /api/backends/install` 当场 **409**，脚本却等满 10 分钟然后报
   * 「整段里没有 step=installing」。**那是我的脚本的缺陷，不是产品的**，
   * 而且它长得和"产品真的不发 installing"一模一样。
   */
  const packs = (cat.packs ?? cat.available ?? []).filter(
    (p) =>
      p.engine === 'whisper.cpp' &&
      (p.installed === false || p.installed === undefined) &&
      (p.os === undefined || p.os === process.platform) &&
      (p.arch === undefined || p.arch === process.arch),
  );
  if (packs.length === 0) {
    say(
      `目录里没有适用于 ${process.platform}-${process.arch} 的 whisper.cpp 包 —— 这本身就是结论。`,
    );
    say(JSON.stringify(cat).slice(0, 800));
    process.exit(1);
  }
  packs.sort((a, b) => (a.totalSizeBytes ?? 0) - (b.totalSizeBytes ?? 0));
  /*
   * `--largest` 从最大往小试，**被 409 拒了就退一个**。
   *
   * `[CI 实测 run 31309232381]` 最大的那个是 `whispercpp-cuda-12.4-win-x64`（677.89 MB），
   * 在没有 N 卡的 runner 上被**正确地** 409 拒掉（适用性判定）——
   * 那不是缺陷，是产品该有的行为，但它让这一格量不到。
   * 退到次大的（Vulkan 25 MB）仍然比 cpu 包大 6 倍，足以回答"包变大会不会变慢"。
   */
  const order = LARGEST ? [...packs].reverse() : packs;
  let pick = null;
  let res = null;
  for (const cand of order) {
    say(`   试：${cand.id}（${((cand.totalSizeBytes ?? 0) / 1e6).toFixed(2)} MB，来自产品目录）`);
    t0 = Date.now();
    const r = await fetch(`${BASE}/api/backends/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: cand.id }),
    });
    say(`   POST /api/backends/install → ${r.status}`);
    if (r.status < 400) {
      pick = cand;
      res = r;
      break;
    }
    say(`   （被拒：${(await r.text()).slice(0, 200)}）`);
    if (!LARGEST) break; // 只有 --largest 才逐个退，默认那档不该悄悄换包
  }
  if (pick === null || res === null) {
    say('✘ 没有一个包能装上 —— **量不到就是量不到**，不许渲染成成功。');
    process.exit(1);
  }
  say(`   选中：${pick.id}（${((pick.totalSizeBytes ?? 0) / 1e6).toFixed(2)} MB）`);

  await waitTerminalAndReport(pick.id);
} finally {
  if (proc?.pid) {
    say(`\n收尾：${killTree(proc.pid)}`);
    await sleep(800);
    if (proc.exitCode === null) killTreeHard(proc.pid);
  }
}
