#!/usr/bin/env node
/**
 * F5 全文检索端到端验收（Manager 指出的缺口：DDL 与扩展验过，但从没真搜过一次）。
 *
 * 只走 HTTP —— 扮演浏览器。
 * 用法：node apps/daemon/scripts/e2e-search.mjs <url> <token> [查询词...]
 */
import process from 'node:process';

const [, , base, token, ...queries] = process.argv;
if (!base || !token) {
  console.error('用法: node apps/daemon/scripts/e2e-search.mjs <url> <token> [查询词...]');
  process.exit(2);
}

const sessRes = await fetch(`${base}/api/auth/session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
const sid = /om_sid=([^;]+)/.exec(sessRes.headers.get('set-cookie') ?? '')?.[1] ?? '';
const cookie = `om_sid=${sid}`;

const notesRes = await fetch(`${base}/api/notes`, { headers: { Cookie: cookie } });
const { notes } = await notesRes.json();
console.log(`库中笔记数: ${notes.length}`);
for (const n of notes.slice(0, 6)) {
  console.log(`  ${n.uid}  status=${n.status.padEnd(10)} "${n.title}"`);
}

const terms = queries.length ? queries : ['Africa', 'organization', '组织'];
console.log(`\n=== 真实检索（GET /api/search）===`);
for (const q of terms) {
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=5`, {
    headers: { Cookie: cookie },
  });
  const body = await res.json();
  if (res.status !== 200) {
    console.log(`  「${q}」 → HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    continue;
  }
  console.log(`\n  查询「${q}」 → ftsQuery=${body.ftsQuery}  命中 ${body.hits.length} 条`);
  for (const h of body.hits.slice(0, 4)) {
    const t = h.startMs !== null ? `[${(h.startMs / 1000).toFixed(1)}s]` : '[笔记]';
    console.log(
      `      ${h.source.padEnd(8)} ${t.padEnd(10)} bm25=${h.score.toFixed(4)}  ${h.snippet.trim().slice(0, 58)}`,
    );
  }
  if (body.hits.length === 0) console.log('      （无命中）');
}

const modesRes = await fetch(`${base}/api/search?q=x`, { headers: { Cookie: cookie } });
const modes = (await modesRes.json()).modes;
console.log(`\n=== 检索能力如实报告 ===`);
console.log(`  关键词检索: ${modes.keyword ? '✅' : '❌'}`);
console.log(`  中文分词(libsimple): ${modes.chineseTokenizer ? '✅' : '❌ 降级为 trigram'}`);
console.log(`  语义检索: ${modes.semantic ? '✅' : '❌'} —— ${modes.semanticReason}`);
console.log(`  混合检索(RRF): ${modes.hybrid ? '✅' : '❌'}`);
