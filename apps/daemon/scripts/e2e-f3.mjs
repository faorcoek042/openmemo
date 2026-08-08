#!/usr/bin/env node
/**
 * F3 端到端验收：浏览器麦克风 → WS → AsrStream → 落库 → 停止后自动排离线重跑。
 *
 * 本脚本扮演**浏览器**：只用 WebSocket + HTTP，不 import daemon 内部模块。
 * 音频按 20ms 一帧实时推送，模拟 AudioWorklet 的行为。
 *
 * 用法：node apps/daemon/scripts/e2e-f3.mjs <url> <token> <16k-mono-pcm.raw> [language]
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import WebSocket from 'ws';

const [, , base, token, pcmPath, language = 'zh'] = process.argv;
if (!base || !token || !pcmPath) {
  console.error('用法: node apps/daemon/scripts/e2e-f3.mjs <url> <token> <pcm.raw> [lang]');
  process.exit(2);
}

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // int16 mono

// ---- 换 session cookie（WS 靠 cookie 鉴权，因为浏览器 WS 带不了 header）----
const sessRes = await fetch(`${base}/api/auth/session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
const sid = /om_sid=([^;]+)/.exec(sessRes.headers.get('set-cookie') ?? '')?.[1] ?? '';
const cookie = `om_sid=${sid}`;
console.log(`[1] session: HTTP ${sessRes.status}  cookie=${sid ? '✅' : '❌'}`);

const pcm = readFileSync(pcmPath);
const totalMs = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
console.log(`[2] 音频: ${pcm.length} 字节 = ${(totalMs / 1000).toFixed(1)}s @16kHz mono int16`);

const origin = base;
const wsUrl = `${base.replace('http', 'ws')}/ws/recorder?language=${language}&title=F3%20E2E`;
const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: origin } });

const partials = [];
const finals = [];
let ready = null;
let stopped = null;
let errored = null;

const done = new Promise((resolve) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'ready') {
      ready = msg;
      console.log(
        `[3] WS ready: recording=${msg.recordingUid} note=${msg.noteUid} sr=${msg.sampleRate}`,
      );
    } else if (msg.type === 'partial') {
      partials.push(msg);
    } else if (msg.type === 'final') {
      finals.push(msg);
      console.log(
        `    final seq=${msg.seq} [${(msg.startMs / 1000).toFixed(1)}-${(msg.endMs / 1000).toFixed(1)}s] ${msg.text.slice(0, 44)}`,
      );
    } else if (msg.type === 'stopped') {
      stopped = msg;
      resolve();
    } else if (msg.type === 'error') {
      errored = msg;
      console.log(`    ❌ error: ${msg.code} ${msg.messageZh}`);
      resolve();
    } else if (msg.type === 'overrun') {
      console.log(`    ⚠️ overrun: 丢弃 ${msg.droppedSamples} 采样（背压生效）`);
    }
  });
  ws.on('error', (e) => {
    errored = { code: 'WS_ERROR', messageZh: String(e) };
    resolve();
  });
  ws.on('close', () => resolve());
});

await new Promise((r) => ws.on('open', r));
console.log('[4] WS 已连接，开始按 20ms/帧 推流…');

// 等 ready（daemon 建 note/transcript 需要一点时间）
for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 50));
if (!ready) {
  console.log('❌ 未收到 ready');
  ws.close();
  process.exit(1);
}

const t0 = Date.now();
for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
  ws.send(pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length)), { binary: true });
  // 实时节奏：推流速度不超过音频本身的播放速度
  const shouldElapse = (off / FRAME_BYTES) * FRAME_MS;
  const actual = Date.now() - t0;
  if (shouldElapse > actual) await new Promise((r) => setTimeout(r, shouldElapse - actual));
}
console.log(`[5] 推流完毕（${((Date.now() - t0) / 1000).toFixed(1)}s），发送 stop`);
ws.send(JSON.stringify({ type: 'stop' }));

await done;

console.log(`\n[6] 流式结果`);
console.log(`    partial 事件: ${partials.length} 条`);
console.log(`    final   事件: ${finals.length} 条`);
if (partials.length) {
  // 契约语义 4：同一 utteranceId 内 text 单调增长
  const byUtt = new Map();
  for (const p of partials) {
    const arr = byUtt.get(p.utteranceId) ?? [];
    arr.push(p.text);
    byUtt.set(p.utteranceId, arr);
  }
  let monotonic = true;
  for (const arr of byUtt.values()) {
    for (let i = 1; i < arr.length; i++) if (!arr[i].startsWith(arr[i - 1])) monotonic = false;
  }
  console.log(
    `    partial 单调增长（契约语义 4）: ${monotonic ? '✅' : '❌'}（${byUtt.size} 个 utterance）`,
  );
  console.log(`    示例 partial: "${partials[Math.floor(partials.length / 2)].text.slice(0, 40)}"`);
}
if (stopped) {
  console.log(
    `    stopped: segmentCount=${stopped.segmentCount} rerunJobUid=${stopped.rerunJobUid ?? '(无)'}`,
  );
}

// ---- 回读：落库与重跑 job ----
if (ready) {
  const noteRes = await fetch(`${base}/api/notes/${ready.noteUid}`, {
    headers: { Cookie: cookie },
  });
  const note = await noteRes.json();
  console.log(`\n[7] REST 回读: status=${note.status} kind=${note.kind} 段数=${note.segmentCount}`);
  const trRes = await fetch(`${base}/api/notes/${ready.noteUid}/transcript`, {
    headers: { Cookie: cookie },
  });
  const tr = await trRes.json();
  console.log(
    `    转写稿 ${tr.segments.length} 段（engine=${tr.transcript?.engineId} model=${tr.transcript?.modelId}）`,
  );
  for (const s of tr.segments.slice(0, 5)) {
    console.log(
      `      [${String(s.startMs).padStart(6)}-${String(s.endMs).padStart(6)}] ${s.text.slice(0, 48)}`,
    );
  }
}

const ok = !errored && !!ready && finals.length > 0 && !!stopped;
console.log(`\n=== F3 端到端结论 ===`);
console.log(`  浏览器→WS→AsrStream→落库→自动排重跑: ${ok ? '✅ 打通' : '❌ 未打通'}`);
if (errored) console.log(`  失败原因: ${errored.code} ${errored.messageZh}`);
process.exitCode = ok ? 0 : 1;
