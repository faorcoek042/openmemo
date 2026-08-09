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

let proc = null;
const events = [];
let t0;

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
  const ac = new AbortController();
  const sseDone = (async () => {
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
  // 默认挑最小（量阶段耗时不是带宽）；`--largest` 挑最大（验"大包是不是也毫秒级"）
  const pick = LARGEST ? packs[packs.length - 1] : packs[0];
  say(`   选中：${pick.id}（${((pick.totalSizeBytes ?? 0) / 1e6).toFixed(2)} MB，来自产品目录）`);

  t0 = Date.now();
  const res = await fetch(`${BASE}/api/backends/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: pick.id }),
  });
  say(`   POST /api/backends/install → ${res.status}`);
  if (res.status >= 400) {
    say(`✘ 安装请求被拒（${res.status}）—— **量不到就是量不到**，不许渲染成成功。`);
    say(`   响应：${(await res.text()).slice(0, 400)}`);
    process.exitCode = 1;
  }

  // 等终态（最多 10 分钟 —— 如果 Windows 真的要几分钟，这里必须等得起）
  const deadline = Date.now() + 600_000;
  for (;;) {
    const done = events.some(
      (e) =>
        e.ev?.type === 'job.state' &&
        (e.ev.state === 'succeeded' || e.ev.state === 'failed' || e.ev.state === 'blocked'),
    );
    if (done) break;
    if (Date.now() > deadline) {
      say('   ⚠️ 10 分钟没等到终态 —— 那本身是重要结论，如实记下');
      break;
    }
    await sleep(250);
  }
  await sleep(1200);
  ac.abort();
  await sseDone;

  // ── 输出：完整序列 + 那一段的数 ───────────────────────────────────────────
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
    say(`t=${t}ms  ${String(kind).padEnd(13)} ${extra}`);
  }

  const firstInstalling = events.find(
    (e) => e.ev?.type === 'job.progress' && e.ev.step === 'installing',
  );
  const terminal = events.find(
    (e) => e.ev?.type === 'job.state' && ['succeeded', 'failed', 'blocked'].includes(e.ev.state),
  );

  say('\n──── 本腿要回答的那一格 ────');
  if (!firstInstalling) {
    say('✘ 整段里**没有** step=installing —— 与 linux 基准不同，这本身是结论。');
    process.exitCode = 1;
  } else if (!terminal) {
    say('✘ 没等到终态 —— installing 之后确实没有终点（这正是"卡住"的形状）。');
    process.exitCode = 1;
  } else {
    const between = events.filter(
      (e) => e.at > firstInstalling.at && e.at < terminal.at && e.ev?.type === 'job.progress',
    );
    const ms = terminal.at - firstInstalling.at;
    say(`平台：${process.platform}-${process.arch}   包：${pick.id}`);
    say(
      `installing → ${terminal.ev.state}：**${ms} ms**，其间 job.progress **${between.length} 条**`,
    );
    say(`（linux-x64 基准：0 条 / 14ms）`);
    for (const b of between)
      say(`    · +${b.at - firstInstalling.at}ms step=${b.ev.step} pct=${b.ev.pct ?? 'null'}`);
  }
} finally {
  if (proc?.pid) {
    say(`\n收尾：${killTree(proc.pid)}`);
    await sleep(800);
    if (proc.exitCode === null) killTreeHard(proc.pid);
  }
}
