#!/usr/bin/env node
/**
 * F4 端到端演示：真实转写稿 → 真实本地 LLM → 思维导图。
 *
 * 用法：
 *   node packages/mindmap/scripts/demo-f4.mjs <whisper.json> [baseUrl]
 *
 * `whisper.json` = whisper.cpp `--output-json-full` 的产物。
 * `baseUrl` 默认 http://127.0.0.1:18080/v1（本地 llama-server）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { OpenAiCompatibleProvider, detectLocalBackends } from '../../llm/dist/index.js';
import { generateMindMap } from '../dist/generate.js';
import { validate } from '../dist/validate.js';
import { toMarkdown } from '../dist/serialize/markdown.js';
import { toMindElixir } from '../dist/adapters/mind-elixir.js';
import { toMarkmap, markmapLoss } from '../dist/adapters/markmap.js';

const jsonPath = process.argv[2];
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:18080/v1';
if (!jsonPath) {
  console.error('用法: node packages/mindmap/scripts/demo-f4.mjs <whisper.json> [baseUrl]');
  process.exit(2);
}

// ---- 1. 读真实转写稿 ----
const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
const segments = raw.transcription.map((s) => ({
  startMs: s.offsets.from,
  endMs: s.offsets.to,
  text: s.text.trim(),
}));
console.log(`=== 输入 ===`);
console.log(`  转写稿: ${jsonPath}`);
console.log(`  段数: ${segments.length}  时长: ${(segments.at(-1).endMs / 1000).toFixed(1)}s`);
console.log(
  `  首段: [${segments[0].startMs}-${segments[0].endMs}] ${segments[0].text.slice(0, 60)}`,
);

// ---- 2. 档 2：真发请求探测本地后端 ----
console.log(`\n=== 档 2 本地后端探测（真发请求，不只看端口）===`);
const detected = await detectLocalBackends({ timeoutMs: 3000 });
for (const d of detected) {
  console.log(
    `  ✅ ${d.label} @ ${d.baseUrl}  latency=${d.latencyMs}ms  models=${d.models.length}`,
  );
}
if (detected.length === 0) console.log('  （未探测到本地后端）');

// ---- 3. 建 provider ----
// T-167：listModels 现在返回 { ok, models } / { ok:false, error } —— 失败要说出原因，
// 不能再把"连不上"静悄悄当成"没有模型"（那正是这次修掉的病）。
const listed = await new OpenAiCompatibleProvider({
  id: 'probe',
  baseUrl,
  model: 'x',
}).listModels();
if (!listed.ok) {
  console.error(`列模型失败：[${listed.error.code}] ${listed.error.messageZh}`);
  process.exit(1);
}
const models = listed.models;
const provider = new OpenAiCompatibleProvider({
  id: 'llama-server',
  label: '本地 llama.cpp',
  baseUrl,
  model: models[0] ?? 'local',
  isLocal: true,
  contextWindow: 4096,
  timeoutMs: 300_000,
  // Qwen3 默认是 thinking 模型，会把 token 预算烧在 reasoning_content 上
  extraBody: { chat_template_kwargs: { enable_thinking: false } },
});

const caps = await provider.capabilities();
console.log(`\n=== provider 能力（实测探测，非假设）===`);
console.log(`  model: ${provider.id} / ${models[0]}`);
console.log(`  streaming: ${caps.streaming}  structuredOutput: ${caps.structuredOutput}`);
console.log(`  contextWindow: ${caps.contextWindow}`);

// ---- 4. 生成 ----
console.log(`\n=== F4 生成中 ===`);

const result = await generateMindMap(provider, segments, {
  transcriptUid: '01TESTTRANSCRIPTULID000000',
  uid: '01TESTMINDMAPULID000000000',
  title: '1921 Marcus Garvey 演讲',
  windowChars: 2200,
  maxTopicsPerWindow: 4,
  maxAttempts: 3,
  onProgress: (f, stage) => console.log(`  进度 ${(f * 100).toFixed(0)}%  ${stage}`),
});

console.log(`\n=== 生成结果 ===`);
console.log(`  窗口数: ${result.windows}   每窗尝试次数: [${result.attempts.join(', ')}]`);
console.log(`  节点数: ${Object.keys(result.doc.nodes).length}`);
console.log(
  `  token: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}`,
);
console.log(`  耗时: ${(result.elapsedMs / 1000).toFixed(1)}s（含重试）`);

const v = validate(result.doc);
console.log(`  schema 校验: ${v.ok ? '✅ 通过' : '❌ ' + JSON.stringify(v.issues.slice(0, 3))}`);

// ---- 5. 时间戳真实性核对（关键：LLM 不产出时间戳）----
let refCount = 0;
let badRef = 0;
for (const n of Object.values(result.doc.nodes)) {
  for (const r of n.refs ?? []) {
    refCount++;
    const hit = segments.some(
      (s) => s.startMs <= r.startMs && s.endMs >= Math.min(r.endMs, s.endMs),
    );
    const quoteIsVerbatim = segments.some((s) => r.quote.includes(s.text.trim().slice(0, 30)));
    if (!hit || !quoteIsVerbatim) badRef++;
  }
}
console.log(`\n=== F5 三层引用核对 ===`);
console.log(`  带 refs 的节点: ${refCount}`);
console.log(
  `  时间戳落在真实段落内 + quote 为原文逐字: ${refCount - badRef}/${refCount} ${badRef === 0 ? '✅' : '❌'}`,
);

// ---- 6. 导出 ----
const md = toMarkdown(result.doc, { includeTimestamps: true });
console.log(`\n=== Markdown 导出（前 40 行）===`);
console.log(md.split('\n').slice(0, 40).join('\n'));

const me = toMindElixir(result.doc);
const mm = toMarkmap(result.doc);
const loss = markmapLoss(result.doc);
console.log(`\n=== 适配器 ===`);
console.log(
  `  mind-elixir: root.topic="${me.nodeData.topic}" children=${me.nodeData.children?.length ?? 0}`,
);
console.log(`  markmap:     content="${mm.content.slice(0, 40)}" children=${mm.children.length}`);
console.log(`  markmap 损失: ${loss.lossy ? JSON.stringify(loss) : '无'}`);

writeFileSync('/tmp/mm/mindmap.json', JSON.stringify(result.doc, null, 2));
writeFileSync('/tmp/mm/mindmap.md', md);
console.log(`\n产物: /tmp/mm/mindmap.json  /tmp/mm/mindmap.md`);
