#!/usr/bin/env node
/**
 * 把 CI 构建出来的 manifest fragment **并进** `vendor/manifests/backends.json`。
 *
 * ## 它替换掉了什么
 *
 * 原来这段逻辑是 `.github/workflows/build-backends.yml` 里的一段 **inline `node -e`**，
 * 而它做的事是（`platform` T-141 §4 C1/C3/C4）：
 *
 *   1. **整份覆盖** —— `packs` 只含本次构建产物，现有 **8 个上游直连包**
 *      （yt-dlp ×4、ffmpeg ×1、whisper ×3）**全部消失**。这个 job 写在
 *      ADR-015（上游预编译优先）之前，没有人回来改它。
 *   2. 顶层**漏了 `catalogVersion`**（`BackendManifestSchema` 必填且 `.strict()`）
 *      → `validateBackendManifest` 必失败 → **daemon 加载不了后端目录**。
 *   3. `if: always()` + 零 fragment → 写出一个 `packs: []` 的文件并**绿灯通过**。
 *
 * 三条的共同点：**它是 YAML 里的一段字符串，没有任何东西能测它。**
 * 所以第一步是把它搬成一个真文件 —— `scripts/ci/selftest-ci-manifest.mjs`
 * 现在能在本机对它做正反向验证（`pnpm test:ci-scripts`）。
 *
 * ## 规则
 *
 * - **upsert，不覆盖**：按 `id` 合并，没出现在本次构建里的包原样保留。
 * - **不许把 published 降级成 pending-ci**：上游直连包（有真 URL）遇到同 id 的
 *   CI 产物（无 URL）时，**保留上游那条**并在日志里说明。理由是 ADR-015：
 *   上游有的就用上游的。反过来做的后果是"跑一次全矩阵 CI，用户就再也装不上 whisper"。
 * - **零 fragment = 失败**，不是"合并了 0 个"。
 * - **schema 不过 = 失败，且一个字都不写**：先在内存里验，验过才落盘。
 *
 * 用法：
 *   node scripts/ci/merge-backend-manifest.mjs \
 *     --fragments artifacts \
 *     [--manifest vendor/manifests/backends.json] \
 *     [--out <path>]            # 默认原地写回 --manifest
 *     [--catalog-version <s>]   # 默认沿用现有文件的值
 *     [--dry-run]
 */
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function parseArgs(argv) {
  const out = { 'dry-run': false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') {
      out['dry-run'] = true;
      continue;
    }
    if (!a.startsWith('--')) fail(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val == null || val.startsWith('--')) fail(`--${key} needs a value`);
    out[key] = val;
    i += 1;
  }
  return out;
}

function fail(msg) {
  console.error(`\n✘ merge-backend-manifest: ${msg}\n`);
  process.exit(1);
}

/**
 * `validateBackendManifest` 住在 `@openmemo/shared` 的 **dist** 里。
 * 找不到就**报错退出**，绝不退化成"跳过校验继续合并" ——
 * 那正好会把 C2/C3 那类错误重新放行，而且是在一条看起来更正常的路径上。
 */
async function loadValidator() {
  const dist = join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js');
  try {
    const mod = await import(pathToFileURL(dist).href);
    if (typeof mod.validateBackendManifest !== 'function') {
      fail(`@openmemo/shared 没有导出 validateBackendManifest（${dist}）`);
    }
    return mod.validateBackendManifest;
  } catch (err) {
    fail(
      `无法加载 ${dist}：${String(err)}\n` +
        `  合并前必须先 \`pnpm install\` + \`pnpm build:safe\`（或至少 --filter @openmemo/shared build）。\n` +
        `  没有 schema 校验就合并 = 把「daemon 加载不了目录」推迟到用户那里发现。`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fragDir = args['fragments'] ?? fail('missing --fragments <dir>');
  const manifestPath = args['manifest'] ?? join(REPO_ROOT, 'vendor', 'manifests', 'backends.json');
  const outPath = args['out'] ?? manifestPath;

  const validate = await loadValidator();

  /* ---------------- 1. 现有 manifest ---------------- */
  const existingRaw = await readFile(manifestPath, 'utf8').catch(() =>
    fail(`读不到现有 manifest：${manifestPath}（本脚本是"并进去"，不是"从零生成"）`),
  );
  const existing = JSON.parse(existingRaw);

  /*
   * 现有文件**先自证清白**。不然一次失败的合并会被归因到 fragment 上，
   * 而真正的坏行早就在仓库里了。
   */
  const pre = validate(existing);
  if (!pre.ok) {
    fail(
      `现有 ${manifestPath} 本身就通不过 schema，先修它再合并：\n  ` +
        pre.errors.slice(0, 8).join('\n  '),
    );
  }

  /* ---------------- 2. fragments ---------------- */
  /*
   * ★★ T-145：**递归**扫，不能只扫一层。
   *
   * `merge-manifest` 这个 job 第一次真的跑起来是在 build-backends 第 4 轮
   * （8 个构建 leg 全绿之后）。它下载了全部 8 个 artifact（日志逐个
   * "Artifact download completed successfully"），然后报「一个 .json fragment 都没有」。
   *
   * 成因是 upload/download 两端的**目录结构**：upload-artifact 那边给的是
   *     path: |
   *       ${{ env.PACK_OUTPUT_DIR }}/*     → dist/packs/*
   *       dist/probe/*
   * 两条路径的**共同祖先是 `dist/`**，所以 artifact 内部保留的是 `packs/…` 与 `probe/…`。
   * `download-artifact --merge-multiple` 合并到 `artifacts/` 之后，
   * fragment 的真实位置是 **`artifacts/packs/*.json`**，而这里只扫了 `artifacts/*.json`。
   *
   * ★ 值得记的是**它红得对**：guard 没有写出一个空 manifest 然后绿灯 ——
   *   它说"构建没有产出任何东西"。那句话在当时不准确（东西是有的，在下一层），
   *   但**方向是安全的那一边**。这正是 C4 防线该有的失败方式。
   */
  async function collectJson(dir) {
    const out = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() =>
      fail(`读不到 fragment 目录：${dir}`),
    );
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await collectJson(full)));
      else if (e.isFile() && e.name.endsWith('.json')) out.push(full);
    }
    return out;
  }
  const paths = (await collectJson(fragDir)).sort();
  // 下游按 `join(fragDir, name)` 读，所以这里回吐相对 fragDir 的路径。
  const names = paths.map((p) => relative(fragDir, p));

  /*
   * ★ 这一条就是 C4（`if: always()` → `packs: []` → 绿灯）的正面防线。
   *   workflow 那边已经去掉 `if: always()`（构建全挂 → merge job 直接不跑），
   *   但 `download-artifact` 在**一个 artifact 都没有**时是**成功**的，
   *   所以这里必须再挡一道：**没有 fragment 就是失败，不是"合并了 0 个"。**
   */
  if (names.length === 0) {
    fail(
      `${fragDir} 里一个 .json fragment 都没有。\n` +
        `  这不是"没什么可合并"，是**构建没有产出任何东西**。\n` +
        `  绝不在这种情况下写 manifest —— 写出来的会是一个合法但空的目录，且全程绿灯。`,
    );
  }

  const incoming = [];
  for (const n of names) {
    const p = join(fragDir, n);
    let obj;
    try {
      obj = JSON.parse(await readFile(p, 'utf8'));
    } catch (err) {
      fail(`fragment 不是合法 JSON：${p} —— ${String(err)}`);
    }
    if (typeof obj?.id !== 'string' || obj.id === '') fail(`fragment 没有 id 字段：${p}`);
    incoming.push({ file: basename(p), pack: obj });
  }

  /* ---------------- 3. upsert ---------------- */
  const byId = new Map(existing.packs.map((p) => [p.id, p]));
  const added = [];
  const replaced = [];
  const keptUpstream = [];

  for (const { file, pack } of incoming) {
    const prev = byId.get(pack.id);
    if (!prev) {
      byId.set(pack.id, pack);
      added.push(pack.id);
      continue;
    }
    /*
     * ★ 不许降级。`availability` 默认值是 'published'（schema 的 .default），
     *   所以判据用「现有条目有没有真 URL」而不是只看字段 —— 手写 manifest 里
     *   有的条目根本没写 availability。
     */
    const prevHasUrl = (prev.files ?? []).some((f) => (f.mirrors ?? []).length > 0);
    const nextHasUrl = (pack.files ?? []).some((f) => (f.mirrors ?? []).length > 0);
    if (prevHasUrl && !nextHasUrl) {
      keptUpstream.push(`${pack.id} (from ${file})`);
      continue;
    }
    byId.set(pack.id, pack);
    replaced.push(pack.id);
  }

  const merged = {
    schemaVersion: existing.schemaVersion ?? 1,
    // ★ C3：顶层必填且 .strict()。默认沿用现有值 —— 合并不改变"目录版本"的语义，
    //   要 bump 就显式传 --catalog-version。
    catalogVersion: args['catalog-version'] ?? existing.catalogVersion,
    generatedAt: new Date().toISOString(),
    packs: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };

  /* ---------------- 4. 校验（落盘之前） ---------------- */
  const post = validate(merged);
  if (!post.ok) {
    fail(
      `合并结果通不过 BackendManifestSchema，**没有写任何文件**：\n  ` +
        post.errors.slice(0, 12).join('\n  ') +
        `\n\n  最常见的原因：fragment 的字段与 schema 对不上（缺必填 / 多出未声明字段，` +
        `BackendPackSchema 是 .strict()），或 published 的包没有 mirror URL。`,
    );
  }

  /* ---------------- 5. 报告 + 落盘 ---------------- */
  const report = [
    `fragments: ${incoming.length}`,
    `packs: ${existing.packs.length} -> ${merged.packs.length}`,
    `added: ${added.length ? added.join(', ') : '(none)'}`,
    `replaced: ${replaced.length ? replaced.join(', ') : '(none)'}`,
    `kept upstream (published beats pending-ci): ${keptUpstream.length ? keptUpstream.join(', ') : '(none)'}`,
  ];
  console.log(report.map((l) => `  ${l}`).join('\n'));

  if (keptUpstream.length > 0) {
    // GitHub Actions 的 annotation。本地跑就只是一行普通输出。
    console.log(
      `::warning::${keptUpstream.length} 个 CI 产物被忽略，因为同 id 的上游直连包已有下载地址（ADR-015 上游优先）`,
    );
  }

  /*
   * job summary 也在这里写，**不在 workflow 里另起一段 inline `node -e`**。
   * 那种东西没有任何测试碰得到 —— C1/C3/C4 三条就是这么长出来的。
   * 本地跑时 GITHUB_STEP_SUMMARY 不存在，这段自然跳过。
   */
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryPath) {
    const rows = merged.packs.map(
      (p) => `| \`${p.id}\` | ${p.engine} | ${p.os}/${p.arch} | ${p.availability ?? 'published'} |`,
    );
    await appendFile(
      summaryPath,
      [
        '### merged `vendor/manifests/backends.json`',
        '',
        ...report.map((l) => `- ${l}`),
        '',
        `catalogVersion: \`${merged.catalogVersion}\``,
        '',
        '| id | engine | platform | availability |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
      ].join('\n'),
    );
  }

  if (args['dry-run']) {
    console.log('  --dry-run: 未写文件');
    return;
  }

  await writeFile(outPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`  wrote ${outPath}`);
}

await main();
