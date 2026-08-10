#!/usr/bin/env node
/**
 * T-061 验证：**daemon 自我重启**。
 *
 * ## ⚠️ 手动脚本，没有自动调用方 —— 而且**差点被我误删**
 *
 * `[实测 2026-08-11]` 全仓审计时它一度被判成"已被 `e2e-runtime-audit.mjs` 取代、可删"。
 * **那个判断只对了三分之一。** 逐条核过：
 *
 * - 「重启接口回 202、真的换了进程」→ `e2e-runtime-audit.mjs:782-787` **已覆盖** ✓
 * - 「**端口没漂**」→ **没覆盖**（runtime-audit 里 port 相关那段是"启动前端口必须是空的"，
 *   不是"重启前后是同一个端口"）
 * - 「**在途任务跨重启自动续跑**」→ **没覆盖**。runtime-audit 的 `--resume-test`
 *   是**断点续传一个下到一半的大包**，和"转写任务跨进程重启接上"是两回事。
 *
 * **所以它留下来。** 如果当初照着"看起来被取代了"就删，会悄无声息地丢掉两条性质 ——
 * 这正是本仓一直在治的那个病，只是换了个方向（不是删测试文件，是删覆盖）。
 *
 * 接不进链的原因：要一个**外部已经跑着、且能自己 respawn** 的 daemon + 真音频。
 * 改动重启/续跑链路时请手动跑一次。
 *
 * 背景：SQLite 扩展（libsimple 中文分词 / sqlite-vec）在**打开 DB 的那个连接**上加载，
 * 装完没法对已开连接补加载。要让"网页上装完就生效"成立，只能换一个进程 ——
 * 于是让 daemon 自己重启，用户只点一下按钮，不必开终端。
 *
 * 这个脚本要证明的**不是**「接口回了 202」，而是四件真事：
 *   1. 真的换了进程（pid 变了、instanceId 变了）
 *   2. **端口没漂**（漂了 = 浏览器麦克风授权按 origin 失效，用户要重新授权一次）
 *   3. 在途转写任务没被杀掉，重启后**自动续跑**（段数越过重启点继续涨）
 *   4. 数据没坏（note 还在，转写文本还在）
 *
 * 用法：node apps/daemon/scripts/e2e-restart.mjs <url> <token> <audio> [lang]
 */
import process from 'node:process';

const [, , base, token, audio, language = 'en'] = process.argv;
if (!base || !token || !audio) {
  console.error('用法: node apps/daemon/scripts/e2e-restart.mjs <url> <token> <audio> [lang]');
  process.exit(2);
}
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = async () => {
  const r = await fetch(`${base}/api/health`, { headers: H });
  return r.json();
};
const segs = async (noteUid) => {
  const r = await fetch(`${base}/api/notes/${noteUid}/transcript`, { headers: H });
  if (!r.ok) return -1;
  const d = await r.json();
  return d.segments?.length ?? 0;
};
const jobs = async () => {
  const r = await fetch(`${base}/api/daemon/status`, { headers: H });
  const d = await r.json();
  return d.jobs ?? {};
};

const before = await health();
console.log(`[1] 重启前 pid=${before.pid} instanceId=${before.instanceId} port=${before.port}`);

const imp = await (
  await fetch(`${base}/api/notes/import`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ input: audio, title: '自我重启验证', language }),
  })
).json();
console.log(`[2] 导入 note=${imp.noteUid} job=${imp.jobUid}`);
if (!imp.noteUid) {
  // 不许在导入就失败的情况下继续 —— 后面的断言会拿 undefined 跟 undefined 比，
  // 一路绿灯却什么都没验证到（这个脚本第一版就是这么骗了我一次）
  console.log(`❌ 导入失败，后续断言无意义：${JSON.stringify(imp)}`);
  process.exit(2);
}

// 等它真的跑起来并落几段 —— 必须在**转写进行中**重启，否则测不到在途任务
let n = 0;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  n = await segs(imp.noteUid);
  if (n >= 3) break;
}
const segBefore = n;
console.log(`[3] 重启前已落段=${segBefore} jobs=${JSON.stringify(await jobs())}`);
if (segBefore < 1) {
  console.log('    ⚠️ 转写还没落段就重启，测不到"在途"，结果不作数');
}

const t0 = Date.now();
const res = await fetch(`${base}/api/daemon/restart`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ reason: 'e2e-test' }),
});
console.log(
  `[4] POST /api/daemon/restart → HTTP ${res.status} ${JSON.stringify(await res.json())}`,
);

// ---- 关键：在**同一个端口**上等它回来 ----
let after = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const h = await health();
    if (h.pid && h.pid !== before.pid) {
      after = h;
      break;
    }
  } catch {
    /* 重启窗口内连不上是正常的，前端此时靠 SSE 自动重连 */
  }
}
if (!after) {
  console.log('[5] ❌ 超时：同端口上没等回来新进程');
  process.exit(1);
}
const backMs = Date.now() - t0;
console.log(
  `[5] 重启后 pid=${after.pid} instanceId=${after.instanceId} port=${after.port} 用时=${backMs}ms`,
);

const pidChanged = after.pid !== before.pid;
const idChanged = after.instanceId !== before.instanceId;
const samePort = after.port === before.port;
console.log(`    ★ 真的换了进程（pid 变）: ${pidChanged ? '✅' : '❌'}`);
console.log(`    ★ instanceId 变了: ${idChanged ? '✅' : '❌'}`);
console.log(
  `    ★ 端口没漂（麦克风授权保住）: ${samePort ? '✅' : `❌ ${before.port} → ${after.port}`}`,
);

// ---- 在途任务必须自动续跑 ----
/*
 * 基准必须是**重启前**的段数 segBefore，不能是"刚回来那一刻读到的数"。
 * 刚回来时 transcript 端点可能还没就绪、返回 -1，拿 -1 当基准的话
 * 任何一次成功读取都 > -1，于是"没续跑"也会显示✅ —— 这个脚本第二版就是这么绿的。
 */
console.log(`\n[6] 刚回来 jobs=${JSON.stringify(await jobs())}（重启前段数=${segBefore}）`);
let grew = false;
let last = -1;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const c = await segs(imp.noteUid);
  if (c < 0) continue; // 端点还没就绪，这次读数不作数
  last = c;
  if (c > segBefore) {
    grew = true;
    break;
  }
}
console.log(`[7] 续跑后段数=${last}（必须 > ${segBefore} 才算真的续跑）`);
console.log(`    ★ 在途任务自动续跑（段数越过重启点继续涨）: ${grew ? '✅' : '❌'}`);

// ---- 数据没坏 ----
const detailRes = await fetch(`${base}/api/notes/${imp.noteUid}`, { headers: H });
const detail = await detailRes.json();
const dataOk = detailRes.ok && typeof detail?.uid === 'string' && detail.uid === imp.noteUid;
console.log(`    ★ note 重启后仍可读: ${dataOk ? '✅' : `❌ HTTP ${detailRes.status}`}`);

// ---- 登录态必须活过重启（否则用户那一页直接废掉）----
// 用 cookie 会话而不是 Bearer 才测得准，这里退一步：至少证明 token 没换。
const tokenStillValid = detailRes.status !== 401;
console.log(
  `    ★ 重启后旧 token/会话仍有效（浏览器那页不会被踢）: ${tokenStillValid ? '✅' : '❌'}`,
);

const allOk = pidChanged && idChanged && samePort && grew && dataOk && tokenStillValid;
console.log(`\n结论：自我重启 ${allOk ? '✅ 可行' : '❌ 有问题'}`);
process.exit(allOk ? 0 : 1);
