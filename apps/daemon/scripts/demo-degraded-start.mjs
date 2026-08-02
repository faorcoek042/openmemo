#!/usr/bin/env node
/**
 * 演示：**扩展加载失败时 daemon 仍能启动**（T-016 验收要求）。
 *
 * 做法就是 Manager 要求的"把 .so 改名模拟"：
 *   ① 扩展齐全      → tokenizer=simple、向量检索可用
 *   ② 把 .so 改名   → daemon 照常启动，降级为 tokenizer=trigram、向量检索关闭
 *   ③ 改回来        → 指纹变化触发索引重建，自动升回 simple
 *
 * 用法：
 *   node apps/daemon/scripts/demo-degraded-start.mjs <扩展目录>
 * 扩展目录需含 libsimple.so / dict/ / vec0.so（各平台后缀不同）。
 */
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon } from '../dist/main.js';

const srcExtDir = process.argv[2];
if (!srcExtDir || !existsSync(srcExtDir)) {
  console.error('用法: node apps/daemon/scripts/demo-degraded-start.mjs <扩展目录>');
  console.error('扩展目录需含 libsimple.<so|dylib|dll> / dict/ / vec0.<so|dylib|dll>');
  process.exit(2);
}

const SUFFIX =
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

const root = mkdtempSync(join(tmpdir(), 'om-degraded-'));
const extDir = join(root, 'ext');
const dataDir = join(root, 'data');
cpSync(srcExtDir, extDir, { recursive: true });

const libsimple = join(extDir, `libsimple${SUFFIX}`);
const vec = join(extDir, `vec0${SUFFIX}`);

let port = 19500;

async function boot(label) {
  process.env['OPENMEMO_EXT_DIR'] = extDir;
  const d = await startDaemon({ port: port++, dataDir, maxPort: port + 5 });
  const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
  const health = await res.json();
  const ext = health.db.extensions;

  console.log(`\n=== ${label} ===`);
  console.log(`  daemon 启动         : ✅ 成功（http ${res.status}）`);
  console.log(`  业务 schema 版本    : v${health.db.schemaVersion}`);
  console.log(`  libsimple           : ${ext.libsimple ? '✅ 已加载' : '❌ 未加载'}`);
  console.log(`  sqlite-vec          : ${ext.sqliteVec ? '✅ 已加载' : '❌ 未加载'}`);
  console.log(`  FTS5 分词器         : ${ext.tokenizer}`);
  console.log(`  搜索层              : ${health.db.search.ok ? '✅ 可用' : '❌ 不可用'}`);
  if (Object.keys(ext.failures).length) {
    for (const [k, v] of Object.entries(ext.failures)) {
      console.log(`  失败原因 [${k}]: ${String(v).slice(0, 100)}`);
    }
  }
  await d.stop();
  return { ok: res.status === 200, tokenizer: ext.tokenizer, vec: ext.sqliteVec };
}

try {
  const a = await boot('① 扩展齐全');

  renameSync(libsimple, `${libsimple}.disabled`);
  renameSync(vec, `${vec}.disabled`);
  const b = await boot('② 两个 .so 都被改名（模拟丢失/损坏）');

  renameSync(`${libsimple}.disabled`, libsimple);
  renameSync(`${vec}.disabled`, vec);
  const c = await boot('③ 扩展恢复');

  console.log('\n=== 结论 ===');
  const pass =
    a.ok &&
    b.ok &&
    c.ok &&
    a.tokenizer === 'simple' &&
    b.tokenizer === 'trigram' &&
    c.tokenizer === 'simple' &&
    a.vec === true &&
    b.vec === false &&
    c.vec === true;
  console.log(`  三种情况下 daemon 均成功启动 : ${a.ok && b.ok && c.ok ? '✅' : '❌'}`);
  console.log(`  分词器 simple→trigram→simple : ${a.tokenizer}→${b.tokenizer}→${c.tokenizer}`);
  console.log(`  向量检索 on→off→on           : ${a.vec}→${b.vec}→${c.vec}`);
  console.log(`  总体: ${pass ? '✅ 降级路径符合预期' : '❌ 不符合预期'}`);
  process.exitCode = pass ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
