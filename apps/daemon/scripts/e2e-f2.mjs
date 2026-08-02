#!/usr/bin/env node
/**
 * F2 端到端验收：HTTP 导入 → daemon → ffmpeg → VAD → whisper → SQLite → SSE。
 *
 * 这个脚本扮演"浏览器"的角色：只用 HTTP + EventSource 协议，
 * **不 import 任何 daemon 内部模块** —— 否则就不算端到端。
 *
 * 用法：node apps/daemon/scripts/e2e-f2.mjs <daemon-url> <token> <本地音频绝对路径>
 */
import process from 'node:process';

const [, , base, token, audioPath] = process.argv;
if (!base || !token || !audioPath) {
  console.error('用法: node apps/daemon/scripts/e2e-f2.mjs <url> <token> <audio>');
  process.exit(2);
}

const events = [];
let sseRaw = '';

// ---- 1) 用 Bearer 换 session cookie（浏览器就是这么做的）----
const sessRes = await fetch(`${base}/api/auth/session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
const setCookie = sessRes.headers.get('set-cookie') ?? '';
const sid = /om_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
const { csrf, csrfHeader } = await sessRes.json();
const cookie = `om_sid=${sid}`;
console.log(`[1] 换取 session: HTTP ${sessRes.status}  cookie=${sid ? '✅' : '❌'}  csrf=${csrf ? '✅' : '❌'}`);

// ---- 2) 打开全局 SSE 流（一条，所有主题复用）----
const ac = new AbortController();
const ssePromise = (async () => {
  const res = await fetch(`${base}/api/events`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: ac.signal,
  });
  console.log(`[2] SSE 连接: HTTP ${res.status}  content-type=${res.headers.get('content-type')}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        sseRaw += frame + '\n\n';
        const evLine = /^event:\s*(.+)$/m.exec(frame);
        const dataLine = /^data:\s*(.+)$/m.exec(frame);
        if (evLine && dataLine) {
          try {
            events.push({ event: evLine[1].trim(), data: JSON.parse(dataLine[1]) });
          } catch { /* 半截帧，忽略 */ }
        }
      }
    }
  } catch { /* aborted */ }
})();
await new Promise((r) => setTimeout(r, 400));

// ---- 3) 发起导入（202 + jobUid，不阻塞）----
const impRes = await fetch(`${base}/api/notes/import`, {
  method: 'POST',
  headers: {
    Cookie: cookie,
    'Content-Type': 'application/json',
    [csrfHeader]: csrf,
  },
  body: JSON.stringify({ input: audioPath, title: 'E2E 本地导入' }),
});
const imp = await impRes.json();
console.log(`[3] POST /api/notes/import → HTTP ${impRes.status}  ${JSON.stringify(imp)}`);
if (impRes.status !== 202) { ac.abort(); process.exit(1); }

// ---- 4) 等 transcribe.done ----
const deadline = Date.now() + 300_000;
let done = false;
while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 500));
  done = events.some((e) => e.event === 'transcribe.done' || e.event === 'job.failed');
}
await new Promise((r) => setTimeout(r, 800));
ac.abort();
await ssePromise.catch(() => {});

// ---- 5) 打印真实 SSE 事件序列 ----
console.log(`\n[4] 真实 SSE 事件序列（共 ${events.length} 条）`);
const counts = {};
for (const e of events) counts[e.event] = (counts[e.event] ?? 0) + 1;
console.log('    类型统计:', JSON.stringify(counts));
console.log('    首 12 条:');
for (const e of events.slice(0, 12)) {
  const d = e.data;
  let extra = '';
  if (e.event === 'job.progress') extra = `phase=${d.phase} fraction=${d.fraction?.toFixed(3)}`;
  else if (e.event === 'transcribe.segment') extra = `seq=${d.seq} ${d.startSec}s "${(d.text ?? '').trim().slice(0, 42)}"`;
  else if (e.event === 'transcribe.started') extra = `dur=${d.durationSec}s`;
  else if (e.event === 'media.ready') extra = `mediaUid=${d.mediaUid} dur=${d.durationSec}s`;
  else if (e.event === 'transcribe.done') extra = `segments=${d.segmentCount} rtf=${d.rtf}`;
  else if (e.event === 'note.created') extra = `title="${d.title}"`;
  else if (e.event === 'job.failed') extra = `${d.code}: ${d.messageZh}`;
  else extra = JSON.stringify(d).slice(0, 60);
  console.log(`      ${e.event.padEnd(20)} ${extra}`);
}
const seg = events.filter((e) => e.event === 'transcribe.segment');
if (seg.length > 3) {
  console.log(`    ... 共 ${seg.length} 条 transcribe.segment，末 2 条:`);
  for (const e of seg.slice(-2)) {
    console.log(`      transcribe.segment  seq=${e.data.seq} ${e.data.startSec}s "${e.data.text.trim().slice(0, 42)}"`);
  }
}
for (const e of events.filter((x) => ['transcribe.done', 'job.done', 'note.updated'].includes(x.event))) {
  console.log(`      ${e.event.padEnd(20)} ${JSON.stringify(e.data).slice(0, 90)}`);
}

// ---- 6) 回读 REST：转写稿 ----
const noteRes = await fetch(`${base}/api/notes/${imp.noteUid}`, { headers: { Cookie: cookie } });
const note = await noteRes.json();
console.log(`\n[5] GET /api/notes/${imp.noteUid} → status=${note.status} 段数=${note.segmentCount} 时长=${note.durationMs}ms`);
console.log(`    assets: ${note.assets.map((a) => `${a.role}→${a.url}`).join('  ')}`);

const trRes = await fetch(`${base}/api/notes/${imp.noteUid}/transcript`, { headers: { Cookie: cookie } });
const tr = await trRes.json();
console.log(`\n[6] GET .../transcript → ${tr.segments.length} 段, rtf=${tr.transcript?.rtf}`);
for (const s of tr.segments.slice(0, 5)) {
  console.log(`      [${String(s.startMs).padStart(6)}-${String(s.endMs).padStart(6)}] ${s.text.trim().slice(0, 60)}`);
}

// ---- 7) /media Range 字节流 ----
const audioAsset = note.assets.find((a) => a.role === 'audio16k') ?? note.assets[0];
if (audioAsset) {
  const full = await fetch(`${base}${audioAsset.url}`, { method: 'HEAD', headers: { Cookie: cookie } });
  const rng = await fetch(`${base}${audioAsset.url}`, {
    headers: { Cookie: cookie, Range: 'bytes=0-1023' },
  });
  const buf = await rng.arrayBuffer();
  console.log(`\n[7] /media Range 字节流`);
  console.log(`      HEAD  → ${full.status}  Content-Length=${full.headers.get('content-length')}  Accept-Ranges=${full.headers.get('accept-ranges')}`);
  console.log(`      Range → ${rng.status}  Content-Range=${rng.headers.get('content-range')}  实收 ${buf.byteLength} 字节`);
  const bad = await fetch(`${base}/media/asset/../../etc/passwd`, { headers: { Cookie: cookie } });
  console.log(`      路径穿越尝试 → HTTP ${bad.status}（应为 400）`);
}

console.log(`\n=== 端到端结论 ===`);
const ok =
  impRes.status === 202 &&
  events.some((e) => e.event === 'note.created') &&
  events.some((e) => e.event === 'transcribe.segment') &&
  events.some((e) => e.event === 'transcribe.done') &&
  tr.segments.length > 0;
console.log(`  浏览器→daemon→ffmpeg→whisper→SQLite→SSE→回读: ${ok ? '✅ 打通' : '❌ 未打通'}`);
process.exitCode = ok ? 0 : 1;
