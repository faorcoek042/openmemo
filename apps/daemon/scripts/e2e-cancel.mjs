#!/usr/bin/env node
/**
 * 取消一个**正在转写**的任务 —— 经 daemon 走完整链路。
 *
 * `gpu-runtime` 在 pipeline 层验过取消，但没验过**经 daemon 取消**；
 * 中间那段（REST → Scheduler → AbortController → SubprocessRunner）正是反复栽的地方。
 *
 * 验四件事（D-07 的复合失败逐条排除）：
 *   1. 子进程真的死了（无孤儿吃 CPU）
 *   2. 已完成的 chunk **保留**（不是全丢重来）
 *   3. lane permit **不泄漏**（泄漏会死锁掉之后所有 GPU 任务）
 *   4. 续跑能**接上**（不从第 0 块重来）
 *
 * 用法：node apps/daemon/scripts/e2e-cancel.mjs <url> <token> <audio> [language]
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const [, , base, token, audio, language = 'zh'] = process.argv;
if (!base || !token || !audio) {
  console.error('用法: node apps/daemon/scripts/e2e-cancel.mjs <url> <token> <audio> [lang]');
  process.exit(2);
}

const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找当前活着的 ASR 子进程（whisper-cli / sherpa）。 */
function asrChildren() {
  try {
    const out = execFileSync('bash', ['-lc', 'pgrep -a whisper-cli 2>/dev/null || true'], {
      encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function status() {
  const r = await fetch(`${base}/api/daemon/status`, { headers: H });
  return r.json();
}
async function transcript(noteUid) {
  const r = await fetch(`${base}/api/notes/${noteUid}/transcript`, { headers: H });
  return r.json();
}

console.log('=== 取消正在转写的任务（经 daemon）===\n');
console.log(`[0] 开始前的 ASR 子进程: ${asrChildren().length} 个`);

// ---- 起一个长转写 ----
const impRes = await fetch(`${base}/api/notes/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ input: audio, title: '取消验证', language }),
});
const imp = await impRes.json();
console.log(`[1] 导入 → HTTP ${impRes.status} note=${imp.noteUid} job=${imp.jobUid}`);

// ---- 等它真的跑起来并且已经落了几段 ----
let ranChildren = [];
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const tr = await transcript(imp.noteUid);
  const seenSegments = tr.segments?.length ?? 0;
  const kids = asrChildren();
  if (kids.length > 0) ranChildren = kids;
  if (seenSegments >= 2 && kids.length > 0) break;
  if (i % 10 === 0) {
    console.log(`    等待中… 已落段=${seenSegments} ASR 子进程=${kids.length}`);
  }
}
const before = await transcript(imp.noteUid);
const segBefore = before.segments?.length ?? 0;
const laneBefore = (await status()).lanes;
console.log(`[2] 取消前: 已落段=${segBefore}  ASR 子进程=${asrChildren().length}`);
console.log(
  `    lanes gpu.asr=${JSON.stringify(laneBefore['gpu.asr'])} gpu.exclusive=${JSON.stringify(laneBefore['gpu.exclusive'])}`,
);
if (segBefore === 0) {
  console.log('❌ 还没落任何段就到时限了，无法验证"保留已完成 chunk"');
}

// ---- 取消 ----
const t0 = Date.now();
const cancelRes = await fetch(`${base}/api/jobs/${imp.jobUid}/cancel`, {
  method: 'POST',
  headers: H,
});
console.log(`\n[3] POST /api/jobs/${imp.jobUid}/cancel → HTTP ${cancelRes.status}`);

// ---- 验证 1：子进程真的死了 ----
let childrenGone = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (asrChildren().length === 0) {
    childrenGone = true;
    break;
  }
}
const killMs = Date.now() - t0;
console.log(
  `\n【验证 1】子进程回收: ${childrenGone ? `✅ 已全部退出（${killMs}ms）` : '❌ 仍有存活'}`,
);
if (!childrenGone) console.log(`    残留: ${asrChildren().join(' | ')}`);
console.log(`    （取消前观察到的 ASR 进程: ${ranChildren[0] ?? '(未捕获)'}）`);

// ---- 验证 2：已完成的 chunk 保留 ----
await sleep(1500);
const after = await transcript(imp.noteUid);
const segAfter = after.segments?.length ?? 0;
console.log(
  `\n【验证 2】已完成 chunk 保留: ${segAfter >= segBefore && segAfter > 0 ? '✅' : '❌'} ` +
    `取消前 ${segBefore} 段 → 取消后 ${segAfter} 段`,
);
if (segAfter > 0) {
  console.log(`    首段: "${after.segments[0].text.slice(0, 42)}"`);
  console.log(`    末段: "${after.segments[segAfter - 1].text.slice(0, 42)}"`);
}

// ---- 验证 3：permit 不泄漏 ----
let lanes = (await status()).lanes;
for (let i = 0; i < 20 && lanes['gpu.asr'].inUse !== 0; i++) {
  await sleep(500);
  lanes = (await status()).lanes;
}
const noLeak = lanes['gpu.asr'].inUse === 0 && lanes['gpu.exclusive'].inUse === 0;
console.log(
  `\n【验证 3】lane permit 不泄漏: ${noLeak ? '✅' : '❌'} ` +
    `gpu.asr.inUse=${lanes['gpu.asr'].inUse} gpu.exclusive.inUse=${lanes['gpu.exclusive'].inUse}`,
);

// ---- 验证 4：续跑接得上（同 note 重跑 → 复用未完成的稿、跳过已完成 chunk）----
console.log(`\n[4] 续跑：POST /api/notes/${imp.noteUid}/retranscribe`);
const resumeRes = await fetch(`${base}/api/notes/${imp.noteUid}/retranscribe`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({}),
});
console.log(`    HTTP ${resumeRes.status}`);
let segResume = segAfter;
let grew = false;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const tr = await transcript(imp.noteUid);
  segResume = tr.segments?.length ?? 0;
  if (segResume > segAfter) {
    grew = true;
    break;
  }
}
console.log(
  `    续跑后段数: ${segAfter} → ${segResume}  ${grew ? '✅ 在原有基础上增长（没有从 0 重来）' : '⚠️ 未观察到增长'}`,
);
// 关键判据：段数只增不减 = 已完成的没被丢掉
const resumeKept = segResume >= segAfter;
console.log(`    已完成段落未被重置: ${resumeKept ? '✅' : '❌'}`);

console.log(`\n=== 汇总 ===`);
const pass1 = childrenGone;
const pass2 = segAfter >= segBefore && segAfter > 0;
const pass3 = noLeak;
console.log(`  1 子进程回收        : ${pass1 ? '✅' : '❌'}`);
console.log(`  2 已完成 chunk 保留 : ${pass2 ? '✅' : '❌'}`);
console.log(`  3 permit 不泄漏     : ${pass3 ? '✅' : '❌'}`);
const pass4 = resumeRes.status === 202 && resumeKept;
console.log(
  `  4 续跑接得上        : ${pass4 ? '✅' : '❌'}（HTTP ${resumeRes.status}, ${segAfter}→${segResume} 段）`,
);
process.exitCode = pass1 && pass2 && pass3 && pass4 ? 0 : 1;
