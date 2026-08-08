#!/usr/bin/env node
/**
 * 产出 **`bundles-complete.json`** —— 「这次 run 三个平台的包都真的造出来了」的**正面凭证**。
 *
 * ## 它回答的问题，以及为什么 `conclusion` 回答不了
 *
 * `build-bundles` 有 `legs` 输入，可以只跑一条腿。而 GitHub 的语义是：
 * **被 `if:` 跳过的 job 既不算成功也不算失败，整个 run 的 `conclusion` 仍然是 `success`。**
 *
 * `[实测 run 31249135458]` 那一次三条腿里**两条 skipped**（只跑了 macOS），
 * `conclusion` 照样 `success`。于是任何"取最近一次**成功**的 run"的消费方
 * 都会取到一个只有 `bundle-darwin-arm64` 的 run —— `e2e-import` 同一天就因此
 * 在 linux/windows 上拿到一句没头没尾的 `no artifact matches`；
 * 而 Manager 发 `v0.2.0` 时**正是从 build-bundles 的产物里取包的**，
 * 同一个陷阱下一次就可能发出一个**残缺的 release**。
 *
 * 这就是 PROTOCOL §11：**「跳过」不许渲染成「成功」**，零步骤的绿灯是它最便宜的发作方式。
 * §11 的判据是「一个绿灯必须能追溯到**是我这次启动的那个东西**给的」——
 * `conclusion` 是对 job 结果的汇总，它**在结构上**装不下"产物在不在"这件事；
 * 而 **artifact 就是这次 run 真的产出的东西本身**。所以判定必须落在 artifact 上。
 *
 * ## 为什么不是"让 skipped 也算失败"
 *
 * 手动只跑一条腿是**合法用法**（调试一个平台时没理由烧另外两个 runner，
 * `build-backends.yml` 的 `legs` 输入就是为此加的）。把它判成失败会训练所有人
 * 忽略红灯 —— 而那正是本仓最贵的那类失败得以长期存活的土壤。
 *
 * ## 所以：**这个 job 不带任何 `if:`**
 *
 * 它 `needs: [linux, macos, windows]`。GitHub 的语义是**只要有一个上游被跳过，
 * 它自己就被跳过** —— 于是"部分跑"的 run 里**根本不存在** `bundles-complete`
 * 这个 artifact。消费方问"你有没有完整的一套"，问的就是这个名字在不在。
 *
 * 这与 `build-backends.yml` 的 `merge-manifest` 是同一个形状与同一条理由
 * （那里的 C4：`if: always()` 曾让"三条腿全挂"写出一个 `packs: []` 然后报绿）。
 * `lint-workflows.mjs` 对那个 job 钉着「不许有任何 if:」，本 job 同理。
 *
 * ## 用法
 *
 *   node scripts/ci/emit-bundles-complete.mjs --from <各腿 artifact 汇合目录> --out <文件>
 *
 * 退出码：0 = 三个平台齐全并已写出；1 = 缺件（**不写文件**）。
 * 缺件时**绝不写一个"部分"的凭证** —— 一个说了半句真话的凭证比没有更糟。
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 三个平台，一个都不能少。与 `build-bundle.mjs` 的 TARGETS 对齐。 */
const REQUIRED = ['linux-x64', 'win-x64', 'darwin-arm64'];

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const FROM = arg('--from');
const OUT = arg('--out');
if (!FROM || !OUT) {
  console.error('用法: emit-bundles-complete.mjs --from <目录> --out <文件>');
  process.exit(2);
}

/** 递归找出所有 `openmemo-<version>-<target>.json`（各腿由 build-bundle.mjs 产出）。 */
async function findMeta(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await findMeta(p, acc);
    else if (/^openmemo-.+\.json$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = await findMeta(FROM);
const byTarget = new Map();
for (const f of files) {
  try {
    const j = JSON.parse(await readFile(f, 'utf8'));
    if (typeof j.target === 'string') byTarget.set(j.target, j);
  } catch {
    console.error(`  ⚠️ 读不动或不是合法 JSON，跳过：${f}`);
  }
}

console.log(`扫描 ${FROM}：找到 ${files.length} 份产物描述，识别出 ${byTarget.size} 个平台`);
for (const t of REQUIRED) {
  const m = byTarget.get(t);
  console.log(`  ${m ? '✔' : '✘'} ${t}${m ? `  ${m.archive?.file ?? '(无归档)'}` : '  缺失'}`);
}

const missing = REQUIRED.filter((t) => !byTarget.has(t));
if (missing.length > 0) {
  console.error('');
  console.error(`::error::缺 ${missing.join(', ')} —— 不写 bundles-complete 凭证。`);
  console.error('::error::这次 run 不是一套完整的三平台产物，不能当作可发布的来源。');
  console.error('::error::（PROTOCOL §11：「跳过」不许渲染成「成功」。要完整的一套请跑 legs=all。）');
  process.exit(1);
}

/*
 * 版本必须三平台一致。不一致说明这些 artifact 来自不同的 run 或不同的 commit，
 * 拼在一起发出去会得到一个"版本号相同但内容不同源"的 release ——
 * 而那种东西**事后无法追溯**。
 */
const versions = [...new Set([...byTarget.values()].map((m) => m.version))];
if (versions.length !== 1) {
  console.error(`::error::三个平台的版本号不一致：${versions.join(' / ')} —— 它们不是同一次构建的产物`);
  process.exit(1);
}

const doc = {
  schemaVersion: 1,
  version: versions[0],
  runId: process.env['GITHUB_RUN_ID'] ?? null,
  commit: process.env['GITHUB_SHA'] ?? null,
  generatedAt: new Date().toISOString(),
  targets: Object.fromEntries(
    REQUIRED.map((t) => {
      const m = byTarget.get(t);
      return [
        t,
        {
          name: m.name,
          rawBytes: m.rawBytes,
          archive: m.archive?.file ?? null,
          sha256: m.archive?.sha256 ?? null,
          bytes: m.archive?.bytes ?? null,
        },
      ];
    }),
  ),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log('');
console.log(`✔ 三个平台齐全，已写 ${OUT}（版本 ${doc.version}）`);
