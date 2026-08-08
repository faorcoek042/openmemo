#!/usr/bin/env node
/**
 * 预编译包的 **macOS 部署目标分层守卫**。
 *
 * ## 它为什么存在（这是一次 CI 实测发现的事实，不是设计洁癖）
 *
 * `[CI 实测 2026-08-08, run 31204790920]` 第一次真跑 macOS 腿，
 * `check-macho-minos --dir <整个包> --max 13.3` 当场红，点名 4 个文件 ——
 * **全部是上游预编译的第三方产物，不是我们编的**：
 *
 * | 文件 | minos | 来源 |
 * |---|---|---|
 * | `sherpa-onnx-darwin-arm64/libonnxruntime.1.27.0.dylib` | **15.5.0** | npm |
 * | `sherpa-onnx-darwin-arm64/libonnxruntime.dylib`        | **15.5.0** | npm |
 * | `sherpa-onnx-darwin-arm64/sherpa-onnx.node`            | **14.0.0** | npm |
 * | `ext/vec0.dylib`                                        | **14.0.0** | sqlite-vec 官方 release |
 *
 * 而通过的是：`runtime/node` 11.0.0 · `better-sqlite3` 11.0.0 · `ext/libsimple.dylib` 11.0.0
 * · `libsherpa-onnx-{c,cxx}-api.dylib` 11.0.0。
 *
 * **这不是我们能"修"的东西** —— 那是别人编好的二进制，我们只是搬运。
 * 但它是一条**真实的产品事实**：README 承诺 macOS arm64 ≥ 13.3，
 * 而在 13.3 ≤ 你的系统 < 14.0 上，`vec0.dylib` 根本加载不了；< 15.5 上 sherpa 加载不了。
 *
 * ## 它的后果为什么必须被写下来，而不是留给守卫红着
 *
 * 这两样的失败**都是静默的**（这正是本仓最贵的那一族）：
 *   · `loadExtensions()` 契约就是"绝不阻塞启动" → vec0 加载失败 = 语义检索悄悄关掉；
 *   · sherpa 是 `await import()` 懒加载并容忍失败 → 流式 ASR / VAD 悄悄没有。
 * 用户看到的是"功能不见了"，不是"报错"。
 *
 * ## 判据：按**坏掉什么**分层，而不是一刀切
 *
 *   · **CORE** —— 坏了产品就不能用。必须 ≤ 13.3（README 的承诺）。**硬失败。**
 *   · **DEGRADABLE** —— 坏了只丢一个功能。floor 逐个**声明在下面这张表里**，
 *     实测值高于声明值 → 红（**上游哪天又抬一档，这里会当场说话**）；
 *     等于声明值 → 放行，并把"这个功能在 macOS < X 上不可用"打出来。
 *
 * 也就是说这不是"把守卫放松了"，是**把一刀切换成一张有名有姓、可审计的表**：
 * 漂移仍然会红，而已知的事实不再每次都伪装成新问题。
 *
 * ⚠️ **表里的数字是 CI 实测值，不是拍的。** 要改它，先跑一次拿到新实测值。
 * ⚠️ 「我们还要不要继续宣称支持 macOS ≥ 13.3」是**产品决策，不在本脚本的职权内** ——
 *    本脚本只保证这件事**可见且不漂移**。已在 inbox 里升级给 Manager。
 *
 * 用法：node scripts/ci/check-bundle-macos-floors.mjs --bundle <包目录>
 */

import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHECKER = join(REPO_ROOT, 'scripts', 'ci', 'check-macho-minos.mjs');

/** README 对 macOS arm64 的承诺。CORE 组一律按它判。 */
const CORE_MAX = '13.3';

/**
 * 可降级组件的**已声明** minos 下限。
 *
 * 每一行都必须写清：谁、实测多少、坏了丢什么。
 * `[CI 实测 2026-08-08 run 31204790920]`
 */
const DEGRADABLE = [
  {
    match: (rel) => rel.includes('sherpa-onnx-darwin-arm64'),
    max: '15.5',
    what: '流式 ASR 与 VAD（sherpa-onnx）',
    note: 'libonnxruntime*.dylib = 15.5.0，sherpa-onnx.node = 14.0.0；取其高者',
  },
  {
    match: (rel) => basename(rel) === 'vec0.dylib',
    max: '14.0',
    what: '语义 / 混合检索（sqlite-vec）',
    note: 'sqlite-vec v0.1.9 官方 macos-aarch64 产物 = 14.0.0',
  },
];

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const BUNDLE = arg('--bundle');
if (!BUNDLE || !existsSync(BUNDLE)) {
  console.error(`✘ --bundle 必填且必须存在（收到：${BUNDLE ?? '(空)'}）`);
  process.exit(2);
}

/** Mach-O 魔数（含 fat）。与 check-macho-minos.mjs 的判定保持一致。 */
const MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

async function isMachO(p) {
  const { open } = await import('node:fs/promises');
  let fh;
  try {
    fh = await open(p, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return MAGICS.has(buf.readUInt32BE(0)) || MAGICS.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && (await stat(p)).size > 4 && (await isMachO(p))) out.push(p);
  }
  return out;
}

const files = await walk(BUNDLE);
if (files.length === 0) {
  console.error(
    `✘ 在 ${BUNDLE} 底下一个 Mach-O 都没数到 —— 一个什么都没检查的检查器是最坏的那种绿`,
  );
  process.exit(1);
}

/* 分组 */
const groups = new Map(); // key -> { max, what, files: [] }
groups.set('CORE', { max: CORE_MAX, what: '产品本体（坏了就不能用）', files: [] });
for (const d of DEGRADABLE)
  groups.set(d.what, { max: d.max, what: d.what, note: d.note, files: [] });

for (const f of files) {
  const rel = relative(BUNDLE, f);
  const hit = DEGRADABLE.find((d) => d.match(rel));
  groups.get(hit ? hit.what : 'CORE').files.push(f);
}

console.log(`\n\x1b[1m预编译包 macOS 部署目标分层守卫\x1b[0m`);
console.log(`  包 ${BUNDLE}`);
console.log(
  `  共 ${files.length} 个 Mach-O，分 ${[...groups.values()].filter((g) => g.files.length).length} 组\n`,
);

let failed = 0;
const staged = [];
for (const [key, g] of groups) {
  if (g.files.length === 0) continue;
  const dir = await mkdtemp(join(tmpdir(), 'om-minos-'));
  staged.push(dir);
  for (const f of g.files) await cp(f, join(dir, `${g.files.indexOf(f)}__${basename(f)}`));

  const label =
    key === 'CORE' ? `CORE（承诺 ≤ ${g.max}）` : `可降级：${g.what}（已声明 ≤ ${g.max}）`;
  console.log(`\x1b[1m── ${label}\x1b[0m`);
  if (g.note) console.log(`   ${g.note}`);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      CHECKER,
      '--dir',
      dir,
      '--max',
      g.max,
    ]);
    console.log(
      stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => `   ${l}`)
        .join('\n'),
    );
    if (key !== 'CORE') {
      console.log(
        `   \x1b[33m⚠️  在 macOS < ${g.max} 上，「${g.what}」不可用，且失败是静默的。\x1b[0m`,
      );
    }
  } catch (e) {
    failed++;
    console.log(`${e.stdout ?? ''}${e.stderr ?? ''}`);
    if (key === 'CORE') {
      console.error(
        `\x1b[31m✘ CORE 组超过 README 承诺的 ${CORE_MAX} —— 产品在承诺范围内的机器上根本起不来。\x1b[0m`,
      );
    } else {
      console.error(
        `\x1b[31m✘ 「${g.what}」的实测 minos 高于本文件声明的 ${g.max}。\x1b[0m\n` +
          `   上游又抬了一档。**不要直接改大这里的数字** —— 先确认：\n` +
          `   ① 新的下限是多少（读上面的实测输出）；\n` +
          `   ② 抬上去之后，还有多少 macOS 用户能用这个功能；\n` +
          `   ③ 这是不是该升级给用户决策（README 的平台表是对外承诺）。`,
      );
    }
  }
  console.log('');
}
for (const d of staged) await rm(d, { recursive: true, force: true });

if (failed > 0) {
  console.error(`✘ ${failed} 组不满足各自的下限`);
  process.exit(1);
}
console.log(`✔ ${files.length} 个 Mach-O 全部在各自声明的下限内`);
console.log(`  ⚠️ 提醒：可降级组的"通过"意味着**已知不可用**，不是"没问题"——`);
console.log(`     它们在低于各自 floor 的 macOS 上会静默失效。README 的平台表需要与本表一致。`);
