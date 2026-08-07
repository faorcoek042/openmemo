/**
 * `resolveBackendTool()` / `findInBackendPacks()` —— **跑的是哪个后端包**（T-162）。
 *
 * ─── 这个文件在钉什么 ────────────────────────────────────────────────────────────────
 *
 * `[amd-vulkan 本机实测]`：CPU 包与 Vulkan 包同装时，`discoverTools()` 交出去的
 * whisper-cli 是 **CPU 包里那个**，而且**先装 cpu 再装 vulkan、先装 vulkan 再装 cpu
 * 两种顺序结果相同**。成因是候选按 `readdir` 顺序拼、取第一个能执行的 ——
 * 不排序、不看 `priority`、不看 `selectedBackend`；而函数注释写着 "newest first"。
 * 后果不是"装不上"，是**装上了、点得动、跑起来还是 CPU，没有任何地方会说** ——
 * ggml 只在二进制自身所在目录里 dlopen 后端模块，隔壁包里的 `libggml-vulkan.so`
 * 永远不会被加载。同一条已经在 Windows 的 CUDA 包上生效了。
 *
 * ★ **测试必须能区分「按选择」和「按顺序」，光测"能找到一个"是钉住了零。**
 * 所以主用例的形状是：**同一份磁盘布局、只改偏好，两次必须给出不同的答案**。
 * 任何按 `readdir` / 按创建顺序 / 按名字硬排的实现，在同一份布局上都只能给出
 * 同一个答案，于是必然红。反过来，一条只断言"vulkan 赢"的用例，
 * 在"按名字倒序"这种实现上照样绿 —— 那种用例证明不了任何事。
 *
 * 夹具用**真的归档名**（`vendor/manifests/backends.json` 里逐字抄的），因为目录名是
 * `unpackDirName()` 从归档名算出来的，而它对 `.tar.xz` **不剥扩展名** ——
 * 用一个"干净"的假名字会让整条反查链在测试里成立、在产品里失效。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { discoverTools, readSelectedBackend, resolveBackendTool } from '../tools.js';

const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function newStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'om-packsel-'));
  roots.push(root);
  await mkdir(join(root, 'by-name', 'backend'), { recursive: true });
  await mkdir(join(root, 'manifests', 'backend'), { recursive: true });
  return root;
}

interface PackSpec {
  readonly id: string;
  readonly backend: string;
  readonly engine: string;
  /** 归档名，逐字来自 `vendor/manifests/backends.json`。 */
  readonly archive: string;
  /** 解包目录名（= 安装器用 `unpackDirName(archive)` 建的那个）。 */
  readonly dir: string;
  readonly priority?: number | undefined;
  /** 目录里放哪些可执行文件（相对解包目录）。空 = 装了包但里面没有可执行文件。 */
  readonly binaries: readonly string[];
}

/** 真实包（名字与 priority 抄自目录），不是编出来的。 */
const CPU_LINUX: PackSpec = {
  id: 'whispercpp-cpu-linux-x64',
  backend: 'cpu',
  engine: 'whisper.cpp',
  archive: 'whisper-bin-ubuntu-x64.tar.gz',
  dir: 'whisper-bin-ubuntu-x64',
  priority: 10,
  binaries: ['whisper-cli'],
};
const VULKAN_LINUX: PackSpec = {
  id: 'whispercpp-vulkan-linux-x64',
  backend: 'vulkan',
  engine: 'whisper.cpp',
  archive: 'whispercpp-vulkan-linux-x64.tar.gz',
  dir: 'whispercpp-vulkan-linux-x64',
  // 目录里没有这条（该包还没进目录），用 CI 实测过的自包含包的形状：带全套二进制。
  priority: 90,
  binaries: ['whisper-cli'],
};
const MEDIA_TOOLS: PackSpec = {
  id: 'media-tools-linux-x64',
  backend: 'cpu',
  engine: 'ffmpeg',
  archive: 'ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz',
  // ★ `.tar.xz` 不在剥离之列 —— 目录名真的带着扩展名（pack-publish §2.3 实测）。
  dir: 'ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz',
  priority: 10,
  binaries: ['ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1/bin/ffmpeg'],
};

async function installPack(
  root: string,
  spec: PackSpec,
  opts: { readonly manifest?: boolean } = {},
): Promise<void> {
  const packDir = join(root, 'by-name', 'backend', spec.dir);
  await mkdir(packDir, { recursive: true });
  for (const rel of spec.binaries) {
    const full = join(packDir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, `#!/bin/sh\necho ${spec.id}\n`);
    // `findInBackendPacks` 用 access(X_OK)，安装器也确实会 chmod —— 少这一步就是
    // "测试里找不到、产品里找得到"，那种夹具比没有更坏（T-160 的原话）。
    await chmod(full, 0o755);
  }
  if (opts.manifest === false) return;
  await writeFile(
    join(root, 'manifests', 'backend', `${spec.id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id: spec.id,
      engine: spec.engine,
      engineVersion: 'test',
      backend: spec.backend,
      installedAt: '2026-08-07T00:00:00.000Z',
      verifiedAt: '2026-08-07T00:00:00.000Z',
      integrity: 'ok',
      ...(spec.priority === undefined ? {} : { priority: spec.priority }),
      files: [{ name: spec.archive, sha256: 'x'.repeat(64), sizeBytes: 1, path: 'unused' }],
      selfTest: null,
    }),
  );
}

async function writePrefs(root: string, selectedBackend: unknown): Promise<void> {
  await writeFile(
    join(root, 'prefs.json'),
    JSON.stringify({ sourceProvider: 'auto', sourceBaseUrl: null, selectedBackend }),
  );
}

const CPU_CLI = (root: string): string =>
  join(root, 'by-name', 'backend', CPU_LINUX.dir, 'whisper-cli');
const VK_CLI = (root: string): string =>
  join(root, 'by-name', 'backend', VULKAN_LINUX.dir, 'whisper-cli');

/* ═════════════════ ① 同一份布局，改偏好就要换答案 ═════════════════ */

describe('T-162 ① 选择决定跑哪个包（而不是 readdir 顺序）', () => {
  it('★ 同一份磁盘布局：选 vulkan 跑 vulkan 包，选 cpu 跑 cpu 包', async () => {
    const root = await newStore();
    await installPack(root, CPU_LINUX);
    await installPack(root, VULKAN_LINUX);

    /*
     * 这两句是本文件的核心。布局一个字节没变、readdir 的返回顺序也没变，
     * 唯一变的是偏好 —— 所以任何"按顺序取第一个"的实现都不可能让它们同时成立。
     */
    const vk = await resolveBackendTool(root, 'whisper-cli', { selectedBackend: 'vulkan' });
    const cpu = await resolveBackendTool(root, 'whisper-cli', { selectedBackend: 'cpu' });

    assert.equal(vk?.path, VK_CLI(root));
    assert.equal(vk?.packId, 'whispercpp-vulkan-linux-x64');
    assert.equal(vk?.backend, 'vulkan');
    assert.equal(vk?.degraded, false);

    assert.equal(cpu?.path, CPU_CLI(root));
    assert.equal(cpu?.packId, 'whispercpp-cpu-linux-x64');
    assert.equal(cpu?.degraded, false);

    // 而且两者确实不同 —— 否则上面两条可能只是同一个答案被断言了两次。
    assert.equal(vk?.path === cpu?.path, false);
  });

  it('★ 偏好走产品的真实通道（<storeRoot>/prefs.json），不用传参也要生效', async () => {
    const root = await newStore();
    await installPack(root, CPU_LINUX);
    await installPack(root, VULKAN_LINUX);

    await writePrefs(root, 'vulkan');
    assert.equal(await readSelectedBackend(root), 'vulkan');
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.path, VK_CLI(root));

    // 用户在界面上改成 cpu —— 同一个 store，答案必须跟着变。
    await writePrefs(root, 'cpu');
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.path, CPU_CLI(root));

    /*
     * `discoverTools()` 才是产品真正调用的入口。只钉底层函数会漏掉装配错误
     * ——「偏好读了但没传下去」在底层用例里看不见。
     */
    await writePrefs(root, 'vulkan');
    assert.equal((await discoverTools({ storeRoot: root })).whisperCli, VK_CLI(root));
  });

  it('安装（创建）顺序不影响结果 —— 两种顺序建同样的两个包，答案逐字相同', async () => {
    const forward = await newStore();
    await installPack(forward, CPU_LINUX);
    await installPack(forward, VULKAN_LINUX);

    const reverse = await newStore();
    await installPack(reverse, VULKAN_LINUX);
    await installPack(reverse, CPU_LINUX);

    for (const sel of ['cpu', 'vulkan'] as const) {
      const a = await resolveBackendTool(forward, 'whisper-cli', { selectedBackend: sel });
      const b = await resolveBackendTool(reverse, 'whisper-cli', { selectedBackend: sel });
      assert.equal(a?.packId, b?.packId, `选中 ${sel} 时两种安装顺序给出了不同的包`);
      assert.equal(a?.packId, sel === 'cpu' ? CPU_LINUX.id : VULKAN_LINUX.id);
    }
  });
});

/* ═════════════════ ② 没选过 → priority，不是顺序 ═════════════════ */

describe('T-162 ② 用户没选过时按 priority 挑', () => {
  it('★ 同一份布局：priority 90 的包赢；把两个 priority 对调，答案就反过来', async () => {
    const high = await newStore();
    await installPack(high, CPU_LINUX); // 10
    await installPack(high, VULKAN_LINUX); // 90
    assert.equal(await readSelectedBackend(high), null, '这一组必须是"从未选过"');
    assert.equal((await resolveBackendTool(high, 'whisper-cli'))?.packId, VULKAN_LINUX.id);

    const swapped = await newStore();
    await installPack(swapped, { ...CPU_LINUX, priority: 90 });
    await installPack(swapped, { ...VULKAN_LINUX, priority: 10 });
    assert.equal((await resolveBackendTool(swapped, 'whisper-cli'))?.packId, CPU_LINUX.id);
  });

  it('显式选择压过 priority（选了低优先级的那个，就跑它）', async () => {
    const root = await newStore();
    await installPack(root, CPU_LINUX); // priority 10
    await installPack(root, VULKAN_LINUX); // priority 90
    await writePrefs(root, 'cpu');
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, CPU_LINUX.id);
  });

  it('老安装记录没有 priority 字段时按 0 处理，且仍然确定 —— 不落回 readdir', async () => {
    const root = await newStore();
    await installPack(root, { ...CPU_LINUX, priority: undefined });
    await installPack(root, { ...VULKAN_LINUX, priority: undefined });
    // 同优先级 → 按 packId 字典序，'whispercpp-cpu-…' < 'whispercpp-vulkan-…'
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, CPU_LINUX.id);
  });

  it('★ 平手时排的是 packId，不是目录名 —— 两者刻意反序，钉住到底按哪个', async () => {
    /*
     * 目录名与 packId 的顺序**故意相反**：
     *   packId:  aaa-pack  <  zzz-pack
     *   目录名:  zzz-dir   >  aaa-dir
     * 于是"按目录名排"和"按 packId 排"会给出不同的答案，这条用例才有分辨力。
     */
    const root = await newStore();
    await installPack(root, {
      id: 'aaa-pack',
      backend: 'cpu',
      engine: 'whisper.cpp',
      archive: 'zzz-dir.tar.gz',
      dir: 'zzz-dir',
      priority: 10,
      binaries: ['whisper-cli'],
    });
    await installPack(root, {
      id: 'zzz-pack',
      backend: 'cpu',
      engine: 'whisper.cpp',
      archive: 'aaa-dir.tar.gz',
      dir: 'aaa-dir',
      priority: 10,
      binaries: ['whisper-cli'],
    });
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, 'aaa-pack');
  });
});

/* ═════════════════ ③ 选中的包缺文件：回退 + 出声 ═════════════════ */

describe('T-162 ③ 选中的包里没有这个文件时回退，并且说出来', () => {
  it('★ 选了 vulkan，但 vulkan 包里没有 whisper-cli → 用 cpu 包的，degraded=true', async () => {
    const root = await newStore();
    await installPack(root, CPU_LINUX);
    // 修复前 release 上那个包的真实形状：整个包只有一个 `libggml-vulkan.so`，
    // 没有 whisper-cli（amd-vulkan §1.1 实测，19,187,014 B）。
    await installPack(root, { ...VULKAN_LINUX, binaries: [] });
    await writeFile(
      join(root, 'by-name', 'backend', VULKAN_LINUX.dir, 'libggml-vulkan.so'),
      'not executable',
    );
    await writePrefs(root, 'vulkan');

    const r = await resolveBackendTool(root, 'whisper-cli');
    assert.equal(r?.path, CPU_CLI(root), '回退目标必须是 cpu 包');
    assert.equal(r?.packId, CPU_LINUX.id);
    assert.equal(r?.preferred, 'vulkan', '偏好要如实回传，否则没人知道退了什么');
    assert.equal(r?.degraded, true, '★ 静默回退 = 把同一个 bug 换个位置重来一遍');
  });

  it('★ 不相干的工具不算降级 —— 选了 vulkan，ffmpeg 来自 media-tools 是正常的', async () => {
    const root = await newStore();
    await installPack(root, VULKAN_LINUX);
    await installPack(root, MEDIA_TOOLS);
    await writePrefs(root, 'vulkan');

    const ff = await resolveBackendTool(root, 'ffmpeg');
    assert.equal(ff?.packId, MEDIA_TOOLS.id);
    assert.equal(ff?.backend, 'cpu');
    assert.equal(
      ff?.degraded,
      false,
      '假红灯与假绿灯一样要当 bug：一条会对不相干的东西发表意见的检查，说对的时候也不该被相信',
    );

    // 同一次解析里 whisper-cli 必须仍然走 vulkan —— 证明上面那个 false 不是"偏好没生效"。
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, VULKAN_LINUX.id);
  });
});

/* ═════════════════ ④ 没有安装记录的目录 ═════════════════ */

describe('T-162 ④ 没有安装记录的目录：排在后面，且不冒充任何包', () => {
  it('有记录的包优先于没记录的目录（后者是装到一半 / 手工解包的产物）', async () => {
    const root = await newStore();
    await installPack(root, { ...CPU_LINUX, priority: 0 });
    // 「blob 先落、manifest 最后写」中途崩溃就是这个状态：目录在，记录没有。
    await installPack(
      root,
      {
        id: 'aaa-no-manifest',
        backend: 'cpu',
        engine: 'whisper.cpp',
        archive: 'aaa-orphan.tar.gz',
        dir: 'aaa-orphan',
        priority: 999,
        binaries: ['whisper-cli'],
      },
      { manifest: false },
    );
    const r = await resolveBackendTool(root, 'whisper-cli');
    assert.equal(r?.packId, CPU_LINUX.id, '证据更强的那一边（有安装记录）必须排在前面');
  });

  it('只有无记录目录时仍然找得到，但如实说"来源不明"且不声称降级', async () => {
    const root = await newStore();
    await installPack(
      root,
      {
        id: 'orphan',
        backend: 'vulkan',
        engine: 'whisper.cpp',
        archive: 'orphan.tar.gz',
        dir: 'orphan',
        binaries: ['whisper-cli'],
      },
      { manifest: false },
    );
    await writePrefs(root, 'vulkan');
    const r = await resolveBackendTool(root, 'whisper-cli');
    assert.equal(r === null, false, '找得到仍然比找不到好 —— 回退策略是"继续找"，不是报错');
    assert.equal(r?.packId, null);
    assert.equal(r?.backend, null, '目录名里写着 vulkan 也不算证据：判据是安装记录，不是关键词');
    assert.equal(r?.degraded, false, '「我拿不到」≠「这里没有」——无从判断时不许声称降级');
  });
});

/* ═════════════════ ⑤ 既有行为不许被这次改动带坏 ═════════════════ */

describe('T-162 ⑤ 回归：扁平布局 / 找不到 / 坏 prefs', () => {
  it('单文件包（by-name/backend/<name>）仍然最先命中（T-132）', async () => {
    const root = await newStore();
    await installPack(root, VULKAN_LINUX);
    const bare = join(root, 'by-name', 'backend', 'yt-dlp');
    await writeFile(bare, '#!/bin/sh\n');
    await chmod(bare, 0o755);
    await writePrefs(root, 'vulkan');
    assert.equal((await resolveBackendTool(root, 'yt-dlp'))?.path, bare);
  });

  it('不存在的工具仍然返回 null（不误报找到）', async () => {
    const root = await newStore();
    await installPack(root, CPU_LINUX);
    assert.equal(await resolveBackendTool(root, 'nope-cli'), null);
  });

  it('prefs.json 坏了 / 后端名不认识 → 当作"没选过"，不当作偏好', async () => {
    const root = await newStore();
    await installPack(root, CPU_LINUX);
    await installPack(root, VULKAN_LINUX);

    await writeFile(join(root, 'prefs.json'), '{ this is not json');
    assert.equal(await readSelectedBackend(root), null);

    await writePrefs(root, 'gpu-of-the-future');
    assert.equal(await readSelectedBackend(root), null);
    // 落回 priority：vulkan(90) 赢 —— 而不是崩、也不是把非法值当成一个后端。
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, VULKAN_LINUX.id);
  });
});
