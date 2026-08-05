#!/usr/bin/env node
/**
 * scripts/license-report.mjs —— 许可证清单生成器（**报告模式，永不 fail build**）
 *
 * 依据 ADR-002 v2：
 *   「CI 仍跑 license-checker，但**降级为报告模式**（生成清单，不 fail build）。」
 *   「所有第三方组件的许可证记入 vendor/manifests/*.json，保持可追溯。」
 *
 * 覆盖 ADR-001 的三类依赖：
 *   A 类 submodule      → 读 .gitmodules + vendor/<name>/ 的 LICENSE 文件是否存在
 *   B 类 包管理器依赖    → `pnpm licenses list --json -r`
 *   C 类 运行时下载物    → vendor/manifests/*.json 的 license 字段
 *
 * 产物：license-report.json + license-report.md（均已 gitignore，可随时重跑）
 *
 * 退出码恒为 0。**这是刻意的** —— 若日后恢复商用意图需要红线拦截，
 * 把 ADR-002 回滚到 v1 并在此处改为对 WATCHLIST 命中项 process.exit(1)。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 需要人工留意的许可证族。命中**不会**让构建失败（ADR-002 v2），只在报告里标出来，
 * 以便日后想商用时一眼看到要处理哪些。
 */
const WATCHLIST = [
  { match: /(^|[^L])GPL-2/i, label: 'GPL-2.x 传染性' },
  { match: /(^|[^L])GPL-3/i, label: 'GPL-3.x 传染性' },
  { match: /AGPL/i, label: 'AGPL 网络传染性' },
  { match: /BUSL|Business Source/i, label: 'BUSL 商用受限' },
  { match: /^SEE LICENSE/i, label: '自定义/专有许可，需人工阅读' },
  { match: /^(UNKNOWN|UNLICENSED)$/i, label: '许可证未知' },
];

/**
 * A 类 submodule 的许可证。
 * 来源：R-03 §2 / §3 与 vendor/README.md —— 由 oss-scout 于 2026-08-02 逐个读取
 * 上游 LICENSE 原文核实。**不要凭记忆改这张表**，改之前先重新核实上游。
 */
const SUBMODULE_LICENSES = {
  'vendor/whisper.cpp': { license: 'MIT', pin: 'v1.9.1' },
  // vendor/llama.cpp 已于 T-144 摘除（ADR-016 决策 3：本地 LLM 线整体下线，
  // 只留 BYO API Key 与探测已装的 Ollama / LM Studio）。submodule、7 个
  // llamacpp-* 后端包与 components.json 条目一并删除，此处的 pin 也不再有对象。
  'vendor/sherpa-onnx': { license: 'Apache-2.0', pin: 'v1.13.4' },
  'vendor/sqlite-vec': { license: 'Apache-2.0', pin: 'v0.1.9' },
  'vendor/libsimple': {
    license: 'MIT',
    pin: 'v0.7.1',
    note: '上游为 MIT OR GPL-3.0 双授权；OpenMemo 明确选择 MIT（见 vendor/README.md）',
  },
};

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md'];

/**
 * ⚠️ npm 层面看不见的许可证。
 *
 * 有些 npm 包自身是宽松许可，但 postinstall 会下载一个**许可证完全不同的二进制**。
 * `pnpm licenses list` 只看得到包的 license 字段，看不到 payload —— 这是个真实的盲区。
 *
 * 典型：`youtube-dl-exec` 包是 MIT，但它拉下来的 yt-dlp 官方 PyInstaller 二进制是 **GPLv3+**
 * （yt-dlp README 原文：the PyInstaller-bundled executables include GPLv3+ licensed code）。
 * 只有 git 仓库 / PyPI 包才是 Unlicense。
 *
 * 每新增一个"会下载二进制"的依赖，都必须在这里补一行，否则清单会漏报。
 */
const BINARY_PAYLOAD_LICENSES = [
  /*
   * ★ T-145：这里**空了**，因为唯一的那一条（`youtube-dl-exec`）连同 `ffmpeg-static`
   *   一起被删掉了 —— 它们是第二条依赖获取通道，而且是松的那条（无校验和，
   *   youtube-dl-exec 连版本都不钉）。理由全文见 packages/pipeline/package.json 的
   *   `_comment:removed-deps`。
   *
   * ⚠️ **义务没有消失，它换了记录的地方。** yt-dlp 与 ffmpeg 现在只从 manifest 那条
   *   通道装，GPLv3+ 记在 `vendor/manifests/backends.json` 每个包的 `license` 字段里
   *   （已核对：ytdlp-linux-x64 / -linux-arm64 / -macos-arm64 / -win-x64 与
   *   media-tools-linux-x64 全部是 `GPL-3.0-or-later`）——
   *   而那条通道本来就在本报告的 A/B 类之外单独成表。
   *
   * ★ **这个数组空着不等于这条防线没用了。** 它盯的是
   *   「npm 包自身宽松、但 postinstall 拉下来的 payload 许可证完全不同」这个盲区，
   *   `pnpm licenses list` 永远看不见它。下面那条守卫就是替它站岗的：
   *   只要 `onlyBuiltDependencies` 里出现了没被这里覆盖、也不在豁免名单里的包，
   *   报告会当场说出来 —— 而不是安静地漏掉。
   */
];

/**
 * 明确豁免：这些确实会拉平台二进制，但 payload 与包本身**同一个许可证**，
 * 不存在"包宽松 / payload 严格"的错配，所以不需要在 BINARY_PAYLOAD_LICENSES 里单列。
 */
const PAYLOAD_SAME_LICENSE = new Set(['esbuild', '@tailwindcss/oxide']);

/**
 * ★ T-145 新增守卫：`onlyBuiltDependencies` 里的每一个包，
 * 要么在 BINARY_PAYLOAD_LICENSES 里有一行，要么在 PAYLOAD_SAME_LICENSE 里被显式豁免。
 *
 * 起因是上面那句注释原文：「每新增一个"会下载二进制"的依赖，都必须在这里补一行，
 * 否则清单会漏报」—— **那是一条要求人记得的纪律，而一条需要人时刻记住的规则，
 * 等价于一条迟早会被违反的规则**（PROTOCOL §7 补充里的同一条判据）。
 * 现在忘了补会当场被说出来。
 */
function auditBinaryPayloadCoverage() {
  let onlyBuilt = [];
  try {
    const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n');
    const start = ws.findIndex((l) => /^onlyBuiltDependencies:/.test(l));
    if (start >= 0) {
      for (let i = start + 1; i < ws.length; i++) {
        if (/^\S/.test(ws[i])) break;
        const m = /^\s*-\s*['"]?([^'"\s#]+)['"]?/.exec(ws[i]);
        if (m) onlyBuilt.push(m[1]);
      }
    }
  } catch {
    return ['读不到 pnpm-workspace.yaml —— 无法核对二进制 payload 的许可证覆盖'];
  }
  const covered = new Set(BINARY_PAYLOAD_LICENSES.map((b) => b.pkg));
  return onlyBuilt
    .filter((p) => !covered.has(p) && !PAYLOAD_SAME_LICENSE.has(p))
    .map(
      (p) =>
        `onlyBuiltDependencies 里的 \`${p}\` 会在 postinstall 拉二进制，` +
        `但它既不在 BINARY_PAYLOAD_LICENSES 里、也不在 PAYLOAD_SAME_LICENSE 豁免名单里 —— ` +
        `payload 的许可证没人记录（pnpm licenses list 看不见它）`,
    );
}

function flagsFor(license) {
  const text = String(license ?? 'UNKNOWN');
  return WATCHLIST.filter((w) => w.match.test(text)).map((w) => w.label);
}

/** A 类：解析 .gitmodules，并检查 submodule 是否已初始化、LICENSE 文件是否在位。 */
function collectSubmodules() {
  const file = join(ROOT, '.gitmodules');
  if (!existsSync(file)) return [];

  const paths = [...readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) =>
    m[1].trim(),
  );

  return paths.map((p) => {
    const abs = join(ROOT, p);
    const known = SUBMODULE_LICENSES[p] ?? {};
    const initialized = existsSync(abs) && readdirSync(abs).length > 0;
    const licenseFile = initialized
      ? (LICENSE_FILENAMES.find((f) => existsSync(join(abs, f))) ?? null)
      : null;

    return {
      klass: 'A',
      name: p,
      version: known.pin ?? 'UNKNOWN',
      license: known.license ?? 'UNKNOWN',
      note: known.note ?? '',
      initialized,
      licenseFile: licenseFile ?? (initialized ? 'NOT-FOUND' : 'submodule 未初始化'),
      flags: flagsFor(known.license),
    };
  });
}

/** B 类：pnpm 自己就知道每个依赖的许可证，直接问它。 */
function collectPackages() {
  let raw;
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--recursive'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // 依赖没装 / pnpm 不可用 —— 诚实报告，不伪造数据，也不 fail
    return {
      error: `pnpm licenses list 执行失败：${err.shortMessage ?? err.message}`,
      entries: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'pnpm licenses list 输出不是合法 JSON', entries: [] };
  }

  const entries = [];
  // pnpm 的输出形如 { "MIT": [ { name, version, ... } ], ... }
  for (const [license, pkgs] of Object.entries(parsed)) {
    for (const pkg of Array.isArray(pkgs) ? pkgs : []) {
      const lic = pkg.license ?? license;
      entries.push({
        klass: 'B',
        name: pkg.name ?? 'UNKNOWN',
        version: Array.isArray(pkg.versions) ? pkg.versions.join(', ') : (pkg.version ?? 'UNKNOWN'),
        license: lic,
        homepage: pkg.homepage ?? '',
        flags: flagsFor(lic),
      });
    }
  }
  // 补上 npm 看不见的二进制 payload —— 只有该包确实被装上了才补
  for (const p of BINARY_PAYLOAD_LICENSES) {
    const host = entries.find((e) => e.name === p.pkg);
    if (!host) continue;
    entries.push({
      klass: 'B',
      name: `${p.pkg} → ${p.payload}`,
      version: host.version,
      license: p.license,
      note: p.note,
      flags: flagsFor(p.license),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { error: null, entries };
}

/** C 类：vendor/manifests/*.json 的 license 字段。 */
function collectManifests() {
  const dir = join(ROOT, 'vendor', 'manifests');
  if (!existsSync(dir)) return [];

  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'schema.json')) {
    let json;
    try {
      json = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      out.push({
        klass: 'C',
        name: f,
        version: 'UNKNOWN',
        license: 'UNKNOWN',
        flags: ['清单解析失败'],
        note: String(err.message),
      });
      continue;
    }
    for (const item of Array.isArray(json) ? json : [json]) {
      out.push({
        klass: 'C',
        name: item.component ?? f,
        version: item.version ?? 'UNKNOWN',
        license: item.license ?? 'UNKNOWN',
        note: item.license_note ?? '',
        flags: flagsFor(item.license),
      });
    }
  }
  return out;
}

function renderMarkdown(report) {
  const L = [];
  L.push('# OpenMemo 许可证清单');
  L.push('');
  L.push(`> 由 \`scripts/license-report.mjs\` 于 ${report.generatedAt} 自动生成。`);
  L.push('> **报告模式**（ADR-002 v2）：只列清单，不阻断构建。');
  L.push('');
  L.push(
    `合计 ${report.summary.total} 项 —— ` +
      `A 类 submodule ${report.summary.a} · B 类 npm ${report.summary.b} · C 类 manifest ${report.summary.c}；` +
      `命中关注清单 ${report.summary.flagged} 项。`,
  );
  L.push('');

  if (report.packagesError) {
    L.push(`> ⚠️ B 类采集失败：${report.packagesError}`);
    L.push('');
  }

  if (report.flagged.length) {
    L.push('## ⚠️ 需人工留意');
    L.push('');
    L.push('（ADR-002 v2 = 个人自用档，以下项目**当前允许使用**。若日后恢复商用意图需逐项处理。）');
    L.push('');
    L.push('| 类别 | 组件 | 版本 | 许可证 | 关注原因 |');
    L.push('| ---- | ---- | ---- | ------ | -------- |');
    for (const e of report.flagged) {
      L.push(`| ${e.klass} | ${e.name} | ${e.version} | ${e.license} | ${e.flags.join('；')} |`);
    }
    L.push('');
  }

  const sections = [
    ['A 类 —— git submodule（`vendor/`）', report.submodules],
    ['B 类 —— 包管理器依赖（npm）', report.packages],
    ['C 类 —— 运行时下载物（`vendor/manifests/`）', report.manifests],
  ];

  for (const [title, rows] of sections) {
    L.push(`## ${title}`);
    L.push('');
    if (!rows.length) {
      L.push('_（无条目）_');
      L.push('');
      continue;
    }
    L.push('| 组件 | 版本 | 许可证 | 备注 |');
    L.push('| ---- | ---- | ------ | ---- |');
    for (const e of rows) {
      const note = [e.note, e.licenseFile ? `LICENSE: ${e.licenseFile}` : '']
        .filter(Boolean)
        .join('；');
      L.push(`| ${e.name} | ${e.version} | ${e.license} | ${note} |`);
    }
    L.push('');
  }

  return L.join('\n');
}

// ---- main ----
const submodules = collectSubmodules();
const { error: packagesError, entries: packages } = collectPackages();
const manifests = collectManifests();
const all = [...submodules, ...packages, ...manifests];
const flagged = all.filter((e) => e.flags.length);

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'report-only (ADR-002 v2)',
  summary: {
    total: all.length,
    a: submodules.length,
    b: packages.length,
    c: manifests.length,
    flagged: flagged.length,
  },
  packagesError,
  flagged,
  submodules,
  packages,
  manifests,
};

writeFileSync(join(ROOT, 'license-report.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(ROOT, 'license-report.md'), renderMarkdown(report));

console.log(`许可证清单已生成（报告模式，不阻断构建）：`);
console.log(`  license-report.json`);
console.log(`  license-report.md`);
console.log(
  `  合计 ${report.summary.total} 项 — A:${report.summary.a} B:${report.summary.b} C:${report.summary.c}，关注 ${report.summary.flagged} 项`,
);
if (packagesError) console.log(`  ⚠️  B 类采集失败：${packagesError}`);
for (const e of flagged) {
  console.log(`  ⚠️  [${e.klass}] ${e.name}@${e.version} — ${e.license} (${e.flags.join('；')})`);
}

/*
 * ★ T-145：二进制 payload 许可证的覆盖核对。
 *
 * ⚠️ 这里**刻意用 exit 1，而不是像上面那样只打印**。
 *   本文件的其余部分是「报告模式，恒定成功退出」（ADR-002 v2 的决定，不动它）——
 *   但那条决定针对的是「某个依赖的许可证进了关注名单」这类**需要人判断**的事。
 *   这条不一样：它说的是「有一个会下载二进制的依赖，**没有任何地方记录它 payload 的许可证**」
 *   —— 那是个**事实缺口**，不是判断题，而且 `pnpm licenses list` 永远看不见它。
 *   打印一行 ⚠️ 混在别的 ⚠️ 里，等于没有。
 */
const coverageGaps = auditBinaryPayloadCoverage();
if (coverageGaps.length > 0) {
  console.error('');
  console.error('✘ 二进制 payload 许可证覆盖不全：');
  for (const g of coverageGaps) console.error(`    - ${g}`);
  console.error('  修法：在 BINARY_PAYLOAD_LICENSES 补一行；');
  console.error('        或确认 payload 与包同许可证后，加进 PAYLOAD_SAME_LICENSE 豁免。');
  process.exit(1);
}
console.log(`  ✔ 二进制 payload 许可证覆盖完整（onlyBuiltDependencies 逐个核对过）`);

// ADR-002 v2：报告模式，恒定成功退出。
process.exit(0);
