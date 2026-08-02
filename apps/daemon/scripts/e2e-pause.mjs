#!/usr/bin/env node
/**
 * D1 验证：**暂停必须可逆**（不是"接口回 204 但任务被永久取消"）。
 *
 * 用法：node apps/daemon/scripts/e2e-pause.mjs <url> <token> <audio> [lang]
 */
import process from 'node:process';

const [, , base, token, audio, language = 'en'] = process.argv;
if (!base || !token || !audio) {
  console.error('用法: node apps/daemon/scripts/e2e-pause.mjs <url> <token> <audio> [lang]');
  process.exit(2);
}
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobOf = async (uid) => {
  const r = await fetch(`${base}/api/daemon/status`, { headers: H });
  const d = await r.json();
  return d.jobs ?? {};
};
const segs = async (noteUid) => {
  const r = await fetch(`${base}/api/notes/${noteUid}/transcript`, { headers: H });
  const d = await r.json();
  return d.segments?.length ?? 0;
};

const imp = await (
  await fetch(`${base}/api/notes/import`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ input: audio, title: '暂停验证', language }),
  })
).json();
console.log(`[1] 导入 note=${imp.noteUid} job=${imp.jobUid}`);

// 等它跑起来并落几段
let n = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  n = await segs(imp.noteUid);
  if (n >= 3) break;
}
console.log(`[2] 暂停前已落段=${n}  jobs=${JSON.stringify(await jobOf())}`);

const pauseRes = await fetch(`${base}/api/jobs/${imp.jobUid}/pause`, { method: 'POST', headers: H });
console.log(`[3] POST /api/jobs/:uid/pause → HTTP ${pauseRes.status}`);

await sleep(4000);
const afterPause = await jobOf();
const segAfterPause = await segs(imp.noteUid);
console.log(`[4] 暂停后 jobs=${JSON.stringify(afterPause)} 段数=${segAfterPause}`);
const isPaused = (afterPause['paused'] ?? 0) >= 1;
console.log(`    ★ 状态是 paused（不是 cancelled）: ${isPaused ? '✅' : '❌'}`);

// ---- 关键：resume 必须真的恢复 ----
const resumeRes = await fetch(`${base}/api/jobs/${imp.jobUid}/resume`, { method: 'POST', headers: H });
console.log(`\n[5] POST /api/jobs/:uid/resume → HTTP ${resumeRes.status}`);

let grew = false;
let n2 = segAfterPause;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  n2 = await segs(imp.noteUid);
  if (n2 > segAfterPause) {
    grew = true;
    break;
  }
}
console.log(`[6] resume 后段数: ${segAfterPause} → ${n2}  ${grew ? '✅ 真的继续跑了' : '❌ 没有恢复'}`);

console.log(`\n=== D1 结论 ===`);
console.log(`  暂停后状态为 paused : ${isPaused ? '✅' : '❌'}`);
console.log(`  已完成段落保留      : ${segAfterPause >= n && segAfterPause > 0 ? '✅' : '❌'}`);
console.log(`  resume 真的恢复     : ${grew ? '✅' : '❌'}`);
process.exitCode = isPaused && grew ? 0 : 1;
