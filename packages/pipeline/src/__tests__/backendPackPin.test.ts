/**
 * `resolveBackendTool(..., { packId })` —— **钉住某一个包**（T-166 ①），
 * 外加 `priority` 缺席时的排序方向（T-166 ②）。
 *
 * ─── ① 钉住 ────────────────────────────────────────────────────────────────────────
 *
 * T-162 让这个函数**按用户的选择**挑包，那回答的是"平时该跑哪个"。
 * 它回答不了另一个问题：「**这一个**包行不行？」——而那正是
 * `POST /api/backends/selftest` 一直做不到的事（前端每张卡片都在发自己的包 id，
 * 而路由把它当成一个可有可无的候选丢掉了）。
 *
 * 钉住与偏好的区别是**语义**，不是强度：
 *   · 偏好找不到 → 回退并出声（不回退会因为一个装了一半的包把整条转写链打死）；
 *   · 钉住找不到 → **返回 null**。回退等于换一个包去跑，再把结果记到用户点的
 *     那张卡片上 —— 那是发明一条不成立的证据，比"少一个功能"贵得多。
 *
 * ★ 判据形状与 T-162 一致：**同一份磁盘布局、只改输入，两次必须给出不同的答案**。
 * 一条只断言"钉住 vulkan 能找到 vulkan"的用例，在"把 packId 整个忽略、
 * 恰好 vulkan priority 更高"的实现上照样绿 —— 那种用例钉住的是零。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveBackendTool } from '../tools.js';

const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function newStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'om-packpin-'));
  roots.push(root);
  await mkdir(join(root, 'by-name', 'backend'), { recursive: true });
  await mkdir(join(root, 'manifests', 'backend'), { recursive: true });
  return root;
}

interface PackSpec {
  readonly id: string;
  readonly backend: string;
  readonly engine: string;
  readonly archive: string;
  readonly dir: string;
  readonly priority?: number | undefined;
  readonly binaries: readonly string[];
}

/** 名字与 priority 逐字抄自 `vendor/manifests/backends.json`。 */
const CPU: PackSpec = {
  id: 'whispercpp-cpu-linux-x64',
  backend: 'cpu',
  engine: 'whisper.cpp',
  archive: 'whisper-bin-ubuntu-x64.tar.gz',
  dir: 'whisper-bin-ubuntu-x64',
  priority: 10,
  binaries: ['whisper-cli'],
};
const VULKAN: PackSpec = {
  id: 'whispercpp-vulkan-linux-x64',
  backend: 'vulkan',
  engine: 'whisper.cpp',
  archive: 'whispercpp-vulkan-linux-x64.tar.gz',
  dir: 'whispercpp-vulkan-linux-x64',
  priority: 80,
  binaries: ['whisper-cli'],
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

const cliOf = (root: string, spec: PackSpec): string =>
  join(root, 'by-name', 'backend', spec.dir, 'whisper-cli');

describe('T-166 ① packId 钉住某一个已安装包', () => {
  it('★ 同一份布局：钉 cpu 得 cpu 包，钉 vulkan 得 vulkan 包', async () => {
    const root = await newStore();
    await installPack(root, CPU);
    await installPack(root, VULKAN);

    const a = await resolveBackendTool(root, 'whisper-cli', { packId: CPU.id });
    const b = await resolveBackendTool(root, 'whisper-cli', { packId: VULKAN.id });

    assert.equal(a?.path, cliOf(root, CPU));
    assert.equal(a?.packId, CPU.id);
    assert.equal(b?.path, cliOf(root, VULKAN));
    assert.equal(b?.packId, VULKAN.id);
    assert.notEqual(a?.path, b?.path, '钉住被忽略了 —— 两次给了同一个二进制');
  });

  it('★ 钉住的包比 priority 更高的那个"输"了也照样赢 —— 它不是偏好，是限制', async () => {
    /*
     * 分辨力：vulkan(80) > cpu(10)，所以**不钉住时 vulkan 赢**（下面的阳性对照）。
     * 钉住 cpu 之后必须是 cpu —— 一个把 packId 当成"再加一档偏好"的实现
     * （比如只把它塞进排序键最前面而不做过滤）在这条上仍然会绿，
     * 所以下一条才是真正的分界：钉住的包**没有**那个文件时不许回退。
     */
    const root = await newStore();
    await installPack(root, CPU);
    await installPack(root, VULKAN);

    assert.equal(
      (await resolveBackendTool(root, 'whisper-cli'))?.packId,
      VULKAN.id,
      '阳性对照不成立：不钉住时本该 vulkan 赢',
    );
    assert.equal(
      (await resolveBackendTool(root, 'whisper-cli', { packId: CPU.id }))?.packId,
      CPU.id,
    );
  });

  it('★★ 钉住的包里没有那个文件 → null，**绝不回退到别的包**', async () => {
    const root = await newStore();
    await installPack(root, CPU);
    // 装到一半：目录与安装记录都在，二进制不在（安装器刻意 blob 先落、manifest 最后写）
    await installPack(root, { ...VULKAN, binaries: [] });

    // 阳性对照：不钉住时确实找得到一个（否则下面那条 null 没有分辨力）
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, CPU.id);

    const pinned = await resolveBackendTool(root, 'whisper-cli', { packId: VULKAN.id });
    assert.equal(
      pinned,
      null,
      `钉住 ${VULKAN.id} 却回退到了别的包 —— 结果会被记到用户点的那张卡片上`,
    );
  });

  it('★ 钉住时 degraded 恒为 false（不回退就没有"退了一档"这回事）', async () => {
    const root = await newStore();
    await installPack(root, CPU);
    await installPack(root, VULKAN);
    await writeFile(join(root, 'prefs.json'), JSON.stringify({ selectedBackend: 'vulkan' }));

    const r = await resolveBackendTool(root, 'whisper-cli', { packId: CPU.id });
    assert.equal(r?.packId, CPU.id);
    assert.equal(
      r?.degraded,
      false,
      'degraded 报了真 —— 那会变成一个永远说不清指向谁的假红灯，而假红灯会训练人忽略告警',
    );
  });

  it('★ 单文件包的扁平命中也要先证明它属于那个包', async () => {
    /*
     * `by-name/backend/<name>` 是所有"包本身就是一个可执行文件"的包共用的一格
     * （yt-dlp 就落在这里）。不查来源直接命中的话，"钉住"会被一个同名文件绕过去 ——
     * 而绕过去之后返回的 `packId` 会是**另一个包**的 id。
     */
    const root = await newStore();
    await installPack(root, CPU);
    const bare = join(root, 'by-name', 'backend', 'yt-dlp');
    await writeFile(bare, '#!/bin/sh\n');
    await chmod(bare, 0o755);

    // 那个扁平文件没有任何安装记录认领它 → 钉住 CPU 包时必须看不见
    assert.equal(await resolveBackendTool(root, 'yt-dlp', { packId: CPU.id }), null);
    // 不钉住时照旧最先命中（T-132 的回归守卫）
    assert.equal((await resolveBackendTool(root, 'yt-dlp'))?.path, bare);
  });

  it('钉一个根本没装的包 id → null（不许"找不到就当没钉"）', async () => {
    const root = await newStore();
    await installPack(root, CPU);
    assert.equal(
      await resolveBackendTool(root, 'whisper-cli', { packId: 'whispercpp-cuda-12.4-win-x64' }),
      null,
    );
  });
});

describe('T-166 ② 老安装记录没有 priority —— 排序方向必须钉住', () => {
  /*
   * `pack-select` 把 `priority` 抄进了**新**的安装记录，用户机器上**老**的没有。
   * 读取侧现在按 `priority ?? 0` 处理，也就是"未知 = 比任何已知都低"。
   *
   * ## 为什么结论是"不写用户的库"，也不去回查目录
   *
   * `[实测]` 目录里 12 个包，priority ≠ 10 的只有两个：`whispercpp-vulkan-linux-x64`(80，
   * **今天** `8cb3b35` 才进目录) 与 `whispercpp-cuda-12.4-win-x64`(90，被 L2 probe 闸门
   * 挡着装不上)。所以 T-162 之前能装上的记录，catalog priority **全是 10**——
   * 回填对它们之间的相对顺序**一个字都不会改**。
   *
   * 而"回查目录"这条路本身还有个结构性缺口：`[实测 git log]` `181e55b→07584d9`
   * 之间目录里删掉了 5 个 `llamacpp-*` 加速包（priority 70–90）。**最需要回填的记录，
   * 恰恰是目录里已经查不到的那些。** 一条只能救"本来就不缺"的兜底，不值得为它
   * 把目录读进 `packages/pipeline`（那还要再造一个"vendor/manifests 在哪"的解析器）。
   *
   * 留下的真实风险只有一个：**有人"顺手简化" `?? 0` 的方向。**
   * 所以这里正面钉住它 —— 老记录（无 priority）在与新记录（有 priority）相遇时
   * 排在后面，也就是**加速包赢**，这正好是本机唯一可能出现的混合态的正确方向。
   */
  it('★ 老 CPU 记录（无 priority）遇上新 Vulkan 记录（80）→ 加速包赢', async () => {
    const root = await newStore();
    await installPack(root, { ...CPU, priority: undefined }); // T-162 之前装的
    await installPack(root, VULKAN); // 今天装的，带 priority

    // 前提自检：老记录**真的**没有 priority（否则这条用例在验一个不存在的状态）
    const raw = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(root, 'manifests', 'backend', `${CPU.id}.json`), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal('priority' in raw, false, '夹具没造出"老记录"这个状态');

    assert.equal(
      (await resolveBackendTool(root, 'whisper-cli'))?.packId,
      VULKAN.id,
      '缺 priority 的默认值被改成了"高于已知值" —— 老 CPU 包会把新装的加速包顶掉',
    );
  });

  it('两条都没有 priority 时退到 packId 字典序（确定性，不看 readdir）', async () => {
    const root = await newStore();
    await installPack(root, { ...CPU, priority: undefined });
    await installPack(root, { ...VULKAN, priority: undefined });
    // 'whispercpp-cpu-…' < 'whispercpp-vulkan-…'
    assert.equal((await resolveBackendTool(root, 'whisper-cli'))?.packId, CPU.id);
  });
});
