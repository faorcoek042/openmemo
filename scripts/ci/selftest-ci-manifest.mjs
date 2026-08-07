#!/usr/bin/env node
/**
 * **本机可跑的 CI 自检** —— 把 `build-backends.yml` 里两个关键步骤
 * （fragment 生成 → 合并 + schema 校验）抽出来在本地真跑一遍，正反向都跑。
 *
 * ## 为什么必须有这个文件
 *
 * `build-backends.yml` **从来没有被执行过一次**，而它里面装着 11 条从来没被执行过的错误
 * （`coordination/inbox/platform.md` §4）。这些错误不是"写得不好"，是
 * **"没有任何东西能在它跑起来之前发现它"**：
 *
 *   - fragment 由 bash 的 `printf` 拼，schema 在 TypeScript 里 —— 两者从不见面；
 *   - 合并逻辑是 YAML 里的一段 inline `node -e` 字符串 —— 没有任何测试能加载它；
 *   - 校验只发生在 GitHub 的 runner 上，而 runner 从来没跑过。
 *
 * 「读一遍 YAML 说修好了」正是它一直看起来没问题的原因。所以判据改成：
 * **每一步都是本地能跑的真脚本，且每条防线都用一个坏输入证明它真的会红。**
 *
 * 跑：`pnpm test:ci-scripts`（需要先 `pnpm build:safe`，因为要用真的 schema）
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EMIT = join(REPO_ROOT, 'scripts', 'ci', 'emit-pack-manifest.mjs');
const MERGE = join(REPO_ROOT, 'scripts', 'ci', 'merge-backend-manifest.mjs');
const REAL_MANIFEST = join(REPO_ROOT, 'vendor', 'manifests', 'backends.json');

const { validateBackendManifest } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js')).href
).catch(() => {
  console.error('✘ 加载 @openmemo/shared/dist 失败 —— 先跑 `pnpm build:safe`');
  process.exit(1);
});

const TMP = mkdtempSync(join(tmpdir(), 'om-ci-selftest-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('check() 只收同步函数，用 acheck');
    console.log(`  ✔ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✘ ${name}\n      ${String(err.message ?? err).split('\n').join('\n      ')}`);
    failures.push(name);
  }
}

async function acheck(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✘ ${name}\n      ${String(err.message ?? err).split('\n').join('\n      ')}`);
    failures.push(name);
  }
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/** 造一个假的 stage + 假的 tar.gz（内容无所谓，只有大小与 sha256 会被读）。 */
async function fakePack(id, files) {
  const stage = join(TMP, id, 'stage');
  await mkdir(stage, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(stage, name), body);
  const archive = join(TMP, id, `${id}.tar.gz`);
  // 不需要是真 tar —— emit 只 stat + sha256 它。但要是个真 gzip，免得日后有人
  // 顺手在这里加解包步骤时拿到一个"看起来能用"的假文件。
  await new Promise((res, rej) => {
    const gz = createGzip();
    const chunks = [];
    gz.on('data', (c) => chunks.push(c));
    gz.on('end', () => writeFile(archive, Buffer.concat(chunks)).then(res, rej));
    gz.on('error', rej);
    gz.end(Buffer.from(`fake pack ${id}`));
  });
  return { stage, archive };
}

async function emit(id, opts = {}) {
  const { stage, archive } = await fakePack(id, opts.files ?? { 'whisper-cli': 'x', 'libggml.so': 'y' });
  const out = join(TMP, `${id}.json`);
  const r = run(EMIT, [
    '--pack-id', id,
    '--engine', 'whisper.cpp',
    '--engine-version', 'v1.9.1',
    '--ggml-abi', opts.abi ?? '0.15.1',
    '--backend', opts.backend ?? 'vulkan',
    '--os', opts.os ?? 'linux',
    '--arch', 'x64',
    '--tier', 'downloadable',
    '--archive', archive,
    '--stage', opts.stage ?? stage,
    '--catalog-version', '2026.08.05',
    '--out', out,
  ]);
  return { r, out };
}

/** 把一个 pack 塞进最小合法 manifest 再走真 schema —— 单独校验一个 pack 没有公开入口。 */
function validatePack(pack) {
  return validateBackendManifest({
    schemaVersion: 1,
    catalogVersion: '2026.08.05',
    generatedAt: new Date().toISOString(),
    packs: [pack],
  });
}

/*
 * ★ T-163：这几组用例要的是一个「目录里**还没有**的包」。
 *
 * 原来写死的是 `whispercpp-vulkan-linux-x64` —— 那时候它确实不在目录里。
 * T-163 把它**真的补进 backends.json** 之后，两条用例当场变味而不是变红：
 *   · ③「新包被加进来」变成了 upsert 已有条目，`packs.length + 1` 对不上（这条红了，好）；
 *   · ⑤「坏 fragment 必须失败」**静默变绿**：merge 先按 ADR-015 认出"同 id 且上游有真 URL"
 *     就跳过了它，**根本没走到 schema 校验**，于是 exit 0 —— 一条反向用例失去了它要验的东西，
 *     而它看起来完全正常。
 *
 * 所以夹具改用一个明确不在目录里的 id，并**断言它确实不在** ——
 * 哪天它也被发布了，这条前提会当场红，而不是又一次悄悄变味。
 */
const UNRELEASED_PACK_ID = 'whispercpp-vulkan-linux-arm64';

/* ══════════════════ ① fragment 生成（C2） ══════════════════ */

console.log('\n① fragment 生成 —— 必须直接通过 BackendPackSchema（.strict()）');

let goodFragment;
await acheck('emit 出来的 fragment 通过真 schema', async () => {
  const { r, out } = await emit(UNRELEASED_PACK_ID);
  assert.equal(r.status, 0, `emit 退出码 ${r.status}\n${r.stderr}`);
  goodFragment = JSON.parse(await readFile(out, 'utf8'));
  const v = validatePack(goodFragment);
  assert.equal(v.ok, true, v.ok ? '' : v.errors.join('\n'));
});

check('fragment 如实标 pending-ci 且没有编造 URL', () => {
  assert.equal(goodFragment.availability, 'pending-ci');
  assert.deepEqual(goodFragment.files[0].mirrors, []);
  assert.equal(goodFragment.benchmark, null);
  assert.equal(goodFragment.requiresDriver, null);
});

check('providesFiles 是 stage 里真实存在的文件，不是猜的', () => {
  assert.deepEqual([...goodFragment.providesFiles].sort(), ['libggml.so', 'whisper-cli']);
});

await acheck('★反向：ggmlAbi 探不到时不许写字符串 "unknown"（那会被当成一个真 ABI 值）', async () => {
  const { out } = await emit('whispercpp-cpu-linux-x64-abitest', { abi: 'unknown', backend: 'cpu' });
  const f = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(f.ggmlAbi, null);
});

await acheck('★反向：stage 为空必须失败（tar 对空目录照样成功 —— 空包会一路绿灯）', async () => {
  const emptyStage = join(TMP, 'empty-stage');
  await mkdir(emptyStage, { recursive: true });
  const { r } = await emit('whispercpp-cpu-linux-x64-empty', { stage: emptyStage });
  assert.notEqual(r.status, 0, 'emit 居然成功了');
  assert.match(r.stderr, /stage dir is empty/);
});

/* ══════════════════ ② 旧 fragment 必须被拒（C2 的反向证据） ══════════════════ */

console.log('\n② 旧的 printf fragment —— 必须被 schema 挡下来（这是它从没被执行过的那条错）');

const LEGACY_FRAGMENT = {
  // 这是 build-whisper.sh 修复前 `emit_manifest()` 真正吐出来的形状（逐字段照抄）
  schemaVersion: 1,
  id: UNRELEASED_PACK_ID,
  engine: 'whisper.cpp',
  engineVersion: 'v1.9.1',
  engineCommit: 'deadbeef',
  ggmlAbi: '0.15.1',
  backend: 'vulkan',
  tier: 'downloadable',
  os: 'linux',
  arch: 'x64',
  buildHost: 'Linux 6.1 x86_64',
  builtAt: '2026-08-05T00:00:00Z',
  benchmark: null,
  archive: { name: 'x.tar.gz', sizeBytes: 100, sha256: 'a'.repeat(64) },
  files: [{ name: 'libggml-vulkan.so', sizeBytes: 100, sha256: 'a'.repeat(64) }],
};

check('★反向：旧 fragment 被真 schema 拒绝，且理由点名了缺失/多余字段', () => {
  const v = validatePack(LEGACY_FRAGMENT);
  assert.equal(v.ok, false, '旧 fragment 居然通过了 schema —— 那这条防线是假的');
  const msg = v.errors.join('\n');
  // 钉的是"它对哪些字段有意见"，不是错误文案的措辞。
  for (const field of ['displayName', 'totalSizeBytes', 'requiresDriver', 'license', 'providesFiles', 'priority', 'catalogVersion']) {
    assert.ok(msg.includes(field), `错误里没有提到缺失的必填字段 ${field}：\n${msg}`);
  }
});

/* ══════════════════ ③ 合并（C1 / C3） ══════════════════ */

console.log('\n③ 合并 —— 必须 upsert 进现有 manifest，而不是整份覆盖');

const workManifest = join(TMP, 'backends.json');
const realManifest = JSON.parse(await readFile(REAL_MANIFEST, 'utf8'));
await writeFile(workManifest, `${JSON.stringify(realManifest, null, 2)}\n`);

const fragDir = join(TMP, 'frags');
await mkdir(fragDir, { recursive: true });
await writeFile(join(fragDir, 'a.json'), JSON.stringify(goodFragment));

let merged;
await acheck('合并后现有上游包一个不少，新包被加进来', async () => {
  // 前提：这个 id 必须真的还不在目录里，否则下面验的是 upsert 不是 add（见 UNRELEASED_PACK_ID）
  assert.ok(
    !realManifest.packs.some((p) => p.id === UNRELEASED_PACK_ID),
    `前提不成立：${UNRELEASED_PACK_ID} 已经在 backends.json 里了 —— ` +
      `换一个还没发布的 id，别把这条 add 用例悄悄变成 upsert 用例`,
  );
  const r = run(MERGE, ['--fragments', fragDir, '--manifest', workManifest]);
  assert.equal(r.status, 0, `merge 退出码 ${r.status}\n${r.stdout}${r.stderr}`);
  merged = JSON.parse(await readFile(workManifest, 'utf8'));
  const ids = new Set(merged.packs.map((p) => p.id));
  for (const p of realManifest.packs) {
    assert.ok(ids.has(p.id), `上游包 ${p.id} 在合并后消失了 —— 这正是 C1`);
  }
  assert.ok(ids.has(UNRELEASED_PACK_ID), '新包没进去');
  assert.equal(merged.packs.length, realManifest.packs.length + 1);
});

check('合并结果有 catalogVersion 且通过 schema（C3）', () => {
  assert.equal(typeof merged.catalogVersion, 'string');
  assert.ok(merged.catalogVersion.length > 0);
  const v = validateBackendManifest(merged);
  assert.equal(v.ok, true, v.ok ? '' : v.errors.join('\n'));
});

check('★反向：旧的 inline 合并输出（无 catalogVersion）会被 schema 拒', () => {
  const v = validateBackendManifest({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packs: merged.packs,
  });
  assert.equal(v.ok, false, '缺 catalogVersion 居然过了');
  assert.ok(v.errors.join('\n').includes('catalogVersion'));
});

/* ══════════════════ ④ 不许把 published 降级成 pending-ci ══════════════════ */

console.log('\n④ 上游优先（ADR-015）—— CI 产物不许顶掉一个有真下载地址的包');

await acheck('同 id 的 CI 产物被忽略，上游的 mirrors 原样保留', async () => {
  const upstreamId = 'whispercpp-cpu-linux-x64';
  const before = realManifest.packs.find((p) => p.id === upstreamId);
  assert.ok(before, `前提不成立：manifest 里没有 ${upstreamId}`);
  assert.ok(before.files[0].mirrors.length > 0, '前提不成立：那条包本来就没有 URL');

  const { out } = await emit(upstreamId, { backend: 'cpu' });
  const clashDir = join(TMP, 'frags-clash');
  await mkdir(clashDir, { recursive: true });
  await writeFile(join(clashDir, 'a.json'), await readFile(out, 'utf8'));

  const work2 = join(TMP, 'backends2.json');
  await writeFile(work2, `${JSON.stringify(realManifest, null, 2)}\n`);
  const r = run(MERGE, ['--fragments', clashDir, '--manifest', work2]);
  assert.equal(r.status, 0, `merge 失败：\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /kept upstream/);

  const after = JSON.parse(await readFile(work2, 'utf8')).packs.find((p) => p.id === upstreamId);
  assert.deepEqual(after.files[0].mirrors, before.files[0].mirrors, '上游下载地址被 CI 产物顶掉了');
  assert.notEqual(after.availability, 'pending-ci');
});

/* ══════════════════ ⑤ 失败即红（C4） ══════════════════ */

console.log('\n⑤ 失败即红 —— 空目录 / 坏 fragment 必须非零退出，且不写任何文件');

await acheck('★反向：零 fragment 必须失败（download-artifact 拿不到东西时是"成功"的）', async () => {
  const emptyDir = join(TMP, 'frags-empty');
  await mkdir(emptyDir, { recursive: true });
  const work = join(TMP, 'backends-empty.json');
  const original = `${JSON.stringify(realManifest, null, 2)}\n`;
  await writeFile(work, original);

  const r = run(MERGE, ['--fragments', emptyDir, '--manifest', work]);
  assert.notEqual(r.status, 0, 'merge 在零 fragment 时居然成功了 —— 这就是 C4');
  assert.match(r.stderr, /fragment/);
  assert.equal(await readFile(work, 'utf8'), original, 'manifest 被改动了 —— 失败路径必须一个字不写');
});

await acheck('★反向：坏 fragment 必须失败，且 manifest 一个字不改', async () => {
  const badDir = join(TMP, 'frags-bad');
  await mkdir(badDir, { recursive: true });
  await writeFile(join(badDir, 'legacy.json'), JSON.stringify(LEGACY_FRAGMENT));
  const work = join(TMP, 'backends-bad.json');
  const original = `${JSON.stringify(realManifest, null, 2)}\n`;
  await writeFile(work, original);

  const r = run(MERGE, ['--fragments', badDir, '--manifest', work]);
  assert.notEqual(r.status, 0, 'merge 吃下了一个 schema 不过的 fragment');
  assert.match(r.stderr, /BackendPackSchema|schema/i);
  assert.equal(await readFile(work, 'utf8'), original, 'manifest 被改动了 —— 失败路径必须一个字不写');
});

await acheck('★反向：published 却没有 mirror 的包会被 superRefine 拒（不是"少个 URL"而已）', async () => {
  const noUrl = { ...goodFragment, id: 'whispercpp-cpu-fake-x64', availability: 'published' };
  const v = validatePack(noUrl);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join('\n').includes('mirror'));
});

/* ══════════════════ ⑥ 现仓库的 manifest 本身 ══════════════════ */

console.log('\n⑥ 仓库现状');

check('vendor/manifests/backends.json 通过 schema', () => {
  const v = validateBackendManifest(realManifest);
  assert.equal(v.ok, true, v.ok ? '' : v.errors.join('\n'));
});

check('目录里没有 engine=llama.cpp 的包（ADR-016 决策 3）', () => {
  assert.ok(realManifest.packs.length >= 5, '包太少，这条断言失去意义');
  assert.deepEqual(realManifest.packs.filter((p) => p.engine === 'llama.cpp').map((p) => p.id), []);
});

/* ══════════════════ 结果 ══════════════════ */

console.log(`\n${failures.length === 0 ? '✔' : '✘'} ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
