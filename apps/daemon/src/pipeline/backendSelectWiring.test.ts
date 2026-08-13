/**
 * T-162 的**接线**：用户在界面上的选择，一路走到"跑哪个 whisper-cli"，再走回自检。
 *
 * `packages/pipeline/src/__tests__/backendSelect.test.ts` 钉的是解析规则本身。
 * 这个文件钉的是它两头的接口 —— 而本仓最贵的那几次事故全在接口上，不在规则里：
 *
 *   · 写的人和读的人各写一个字面量（`%APPDATA%` vs `%LOCALAPPDATA%`，
 *     `bin/runtime` vs `by-name/backend`）—— 两边都"对"，产品静默失效；
 *   · 算出来了没人读（`priority` 十一条声明零个读取方、`selectedBackend`
 *     只驱动两个展示徽章）；
 *   · 降级发生了但没有出口能看见（VAD 退回固定窗口那次）。
 *
 * ⚠️ PROTOCOL §9-bis：环境在**模块顶层**清干净，窗口为零，不写任何清理代码。
 * `RestState.create()` 会 mkdir 模型根、写 `active.json` / `prefs.json` ——
 * 不清掉这两个变量，它就会去动这台机器上真实的数据目录。
 */
import { tmpdir } from 'node:os';

delete process.env['OPENMEMO_MODELS'];
delete process.env['OPENMEMO_EXT_DIR'];
delete process.env['OPENMEMO_WHISPER_CLI'];
delete process.env['OPENMEMO_ASR_MODEL'];
delete process.env['OPENMEMO_VAD_MODEL'];

import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { backendPrefsPath, readSelectedBackend } from '@openmemo/pipeline';
import { runSelfCheck, type SelfCheckProbes } from '@openmemo/runtime';

import type { AppPaths } from '../config/paths.js';
import { toInstalledRecord } from '../http/rest/backends.js';
import { loadBackendCatalog } from '../http/rest/manifests.js';
import { RestState } from '../http/rest/state.js';
import { SseHub } from '../http/sse.js';
import { buildPipeline } from './setup.js';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

async function freshPaths(tag: string): Promise<AppPaths> {
  const dataDir = await mkdtemp(join(tmpdir(), `om-packsel-${tag}-`));
  const modelsDir = join(dataDir, 'models');
  await mkdir(join(modelsDir, 'by-name', 'backend'), { recursive: true });
  await mkdir(join(modelsDir, 'manifests', 'backend'), { recursive: true });
  await mkdir(join(dataDir, 'tmp'), { recursive: true });
  return {
    dataDir,
    dbFile: join(dataDir, 'openmemo.db'),
    runtimeDir: join(dataDir, 'runtime'),
    runtimeJson: join(dataDir, 'runtime', 'runtime.json'),
    backupsDir: join(dataDir, 'backups'),
    logsDir: join(dataDir, 'logs'),
    tmpDir: join(dataDir, 'tmp'),
    mediaDir: join(dataDir, 'media'),
    modelsDir,
    extensionsDir: join(dataDir, 'bin', 'ext'),
  };
}

/** 造一个已装后端包：解包目录 + 安装记录（形状与 `startPackInstall` 写出来的一致）。 */
async function seedPack(
  modelsDir: string,
  o: {
    readonly id: string;
    readonly backend: string;
    readonly archive: string;
    readonly dir: string;
    readonly priority: number;
    readonly withCli: boolean;
  },
): Promise<string> {
  const packDir = join(modelsDir, 'by-name', 'backend', o.dir);
  await mkdir(packDir, { recursive: true });
  const cli = join(packDir, 'whisper-cli');
  if (o.withCli) {
    await writeFile(cli, `#!/bin/sh\necho ${o.id}\n`);
    await chmod(cli, 0o755);
  }
  await writeFile(
    join(modelsDir, 'manifests', 'backend', `${o.id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id: o.id,
      engine: 'whisper.cpp',
      engineVersion: 'test',
      backend: o.backend,
      installedAt: '2026-08-07T00:00:00.000Z',
      verifiedAt: '2026-08-07T00:00:00.000Z',
      integrity: 'ok',
      priority: o.priority,
      files: [{ name: o.archive, sha256: 'x'.repeat(64), sizeBytes: 1, path: 'unused' }],
      selfTest: null,
    }),
  );
  return cli;
}

const CPU = {
  id: 'whispercpp-cpu-linux-x64',
  backend: 'cpu',
  archive: 'whisper-bin-ubuntu-x64.tar.gz',
  dir: 'whisper-bin-ubuntu-x64',
  priority: 10,
} as const;
const VULKAN = {
  id: 'whispercpp-vulkan-linux-x64',
  backend: 'vulkan',
  archive: 'whispercpp-vulkan-linux-x64.tar.gz',
  dir: 'whispercpp-vulkan-linux-x64',
  priority: 90,
} as const;

/* ═════════ ① RestState 写的偏好，解析器读得回来（文件名 + 键名同源） ═════════ */

describe('T-162 ① 用户的选择落盘在哪、键叫什么 —— 只允许有一个答案', () => {
  it('★ 走 RestState 自己的 persistPrefs()，readSelectedBackend() 必须读得到', async () => {
    const paths = await freshPaths('prefs');
    const state = await RestState.create({
      sse: new SseHub(),
      dataDir: paths.dataDir,
      manifestDir: MANIFEST_DIR,
    });

    // 先证明"没选过"是真的没选过 —— 否则下面那条翻转可能只是本来就是 vulkan。
    assert.equal(await readSelectedBackend(state.modelsRoot), null);

    state.prefs.selectedBackend = 'vulkan';
    await state.persistPrefs();

    /*
     * 这里**刻意不去读 `prefs.json` 的字面量**，而是让产品的写入方与读取方对接：
     * 文件改名、键改名、目录改位置，三种改法里任何一种都会让这一条红。
     * 只断言"文件里有 selectedBackend"就只钉住了写入方自己。
     */
    assert.equal(await readSelectedBackend(state.modelsRoot), 'vulkan');

    // 顺带钉住路径就是 pipeline 导出的那一个（写入方现在也用它）。
    await access(backendPrefsPath(state.modelsRoot));
  });

  it('★ 越界守卫：模型根必须在 tmpdir 里且不在 $HOME 下（PROTOCOL §9-bis）', async () => {
    const paths = await freshPaths('guard');
    const state = await RestState.create({
      sse: new SseHub(),
      dataDir: paths.dataDir,
      manifestDir: MANIFEST_DIR,
    });
    assert.equal(state.modelsRoot.startsWith(tmpdir()), true, state.modelsRoot);
    const home = process.env['HOME'] ?? '';
    assert.equal(home !== '' && state.modelsRoot.startsWith(home), false, state.modelsRoot);
  });
});

/* ═════════ ①-bis 目录里的 priority 必须真的落进安装记录 ═════════ */

describe('T-162 ①-bis 安装记录要带上 priority（否则解析器永远看不到它）', () => {
  it('★ 拿真实目录里的每一条包过一遍 `toInstalledRecord()`，priority 必须逐条相等', async () => {
    const catalog = await loadBackendCatalog(MANIFEST_DIR);
    assert.equal(catalog.packs.length > 0, true, '目录是空的，下面的断言会恒真');

    const differing: string[] = [];
    for (const pack of catalog.packs) {
      const rec = toInstalledRecord(pack, [], { modelsRoot: MANIFEST_DIR });
      if (rec.priority !== pack.priority) differing.push(pack.id);
    }
    assert.deepEqual(differing, [], '这些包的 priority 没被抄进安装记录');

    /*
     * 阳性对照：目录里**确实存在**两个不同的 priority。
     * 全是同一个数的话，"抄对了"和"写死一个常数"在上面那条里长得一模一样。
     * `[实测]` 目录里 cpu/ffmpeg/yt-dlp 是 10，`whispercpp-cuda-12.4-win-x64` 是 90。
     */
    const distinct = new Set(catalog.packs.map((p) => p.priority));
    assert.equal(distinct.size >= 2, true, `目录里 priority 只有一种取值：${[...distinct].join()}`);
  });
});

/* ═════════ ② buildPipeline 真的用上了它 ═════════ */

describe('T-162 ② 选择一路走到 buildPipeline 交出去的那个 whisper-cli', () => {
  it('★ 同一个数据目录、同样两个包：选 vulkan 与选 cpu 必须给出不同的二进制', async () => {
    const paths = await freshPaths('build');
    const cpuCli = await seedPack(paths.modelsDir, { ...CPU, withCli: true });
    const vkCli = await seedPack(paths.modelsDir, { ...VULKAN, withCli: true });

    await writeFile(
      backendPrefsPath(paths.modelsDir),
      JSON.stringify({ sourceProvider: 'auto', selectedBackend: 'vulkan' }),
    );
    const a = await buildPipeline(paths);
    assert.equal(a.tools.whisperCli, vkCli);
    assert.equal(a.whisperCliOrigin?.packId, VULKAN.id);
    assert.equal(a.whisperCliOrigin?.degraded, false);

    await writeFile(
      backendPrefsPath(paths.modelsDir),
      JSON.stringify({ sourceProvider: 'auto', selectedBackend: 'cpu' }),
    );
    const b = await buildPipeline(paths);
    assert.equal(b.tools.whisperCli, cpuCli);
    assert.equal(b.whisperCliOrigin?.packId, CPU.id);

    assert.equal(a.tools.whisperCli === b.tools.whisperCli, false);
  });

  it('★ 选中的包里没有 whisper-cli → 退回 cpu 包，且 bundle 上留下 degraded=true', async () => {
    const paths = await freshPaths('degrade');
    const cpuCli = await seedPack(paths.modelsDir, { ...CPU, withCli: true });
    // 修复前 release 上那个 Vulkan 包的真实形状：只有一个 .so，没有 whisper-cli。
    await seedPack(paths.modelsDir, { ...VULKAN, withCli: false });
    await writeFile(
      join(paths.modelsDir, 'by-name', 'backend', VULKAN.dir, 'libggml-vulkan.so'),
      'so',
    );
    await writeFile(
      backendPrefsPath(paths.modelsDir),
      JSON.stringify({ selectedBackend: 'vulkan' }),
    );

    const bundle = await buildPipeline(paths);
    assert.equal(bundle.tools.whisperCli, cpuCli);
    assert.equal(bundle.whisperCliOrigin?.preferred, 'vulkan');
    assert.equal(bundle.whisperCliOrigin?.degraded, true);
  });

  it('whisper-cli 来自环境变量覆盖时，不许说它来自某个包', async () => {
    const paths = await freshPaths('envoverride');
    await seedPack(paths.modelsDir, { ...CPU, withCli: true });
    const fake = join(paths.tmpDir, 'my-own-whisper-cli');
    await writeFile(fake, '#!/bin/sh\n');
    await chmod(fake, 0o755);
    process.env['OPENMEMO_WHISPER_CLI'] = fake;
    try {
      const bundle = await buildPipeline(paths);
      assert.equal(bundle.tools.whisperCli, fake);
      assert.equal(
        bundle.whisperCliOrigin,
        null,
        '为另一个二进制作证 = 又一次「两件事被当成了一件」',
      );
    } finally {
      delete process.env['OPENMEMO_WHISPER_CLI'];
    }
  });
});

/* ═════════ ③ 自检里看得见（判据的"能知道"那一半） ═════════ */

function baseProbes(extra: Partial<SelfCheckProbes> = {}): SelfCheckProbes {
  return {
    tools: () =>
      Promise.resolve({
        ffmpeg: null,
        ffprobe: null,
        whisperCli: null,
        whisperVad: null,
        vadModel: null,
        ytDlp: null,
      }),
    installed: () => Promise.resolve([]),
    installedByRole: () => Promise.resolve({ names: [], skippedWithoutRole: 0 }),
    chineseSearch: () => Promise.resolve(null),
    vecVersion: () => Promise.resolve(null),
    engines: () => Promise.resolve([]),
    selectFor: () => Promise.resolve(null),
    ...extra,
  };
}

describe('T-162 ③ `backend.selection`：从自检里看得出跑的是哪个包', () => {
  const BASE = {
    dataDir: join(tmpdir(), 'om-packsel-nonexistent'),
    storeRoot: join(tmpdir(), 'om-packsel-nonexistent', 'models'),
    extensionsDir: join(tmpdir(), 'om-packsel-nonexistent', 'ext'),
  };

  it('★ 正常：选中的后端与实际使用的包一致 → ok，且 detail 里两者都说得出来', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: baseProbes({
        backendSelection: () =>
          Promise.resolve({
            selectedBackend: 'vulkan',
            packId: VULKAN.id,
            packBackend: 'vulkan',
            degraded: false,
          }),
      }),
    });
    const item = r.results.find((x) => x.id === 'backend.selection');
    assert.equal(item?.status, 'ok');
    assert.equal(item?.detail.includes(VULKAN.id), true, item?.detail ?? '(缺项)');
    assert.equal(item?.detail.includes('vulkan'), true, item?.detail ?? '(缺项)');
  });

  it('★ 退档：degraded 必须变 warn 并给出下一步 —— 只回退不出声等于没修', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: baseProbes({
        backendSelection: () =>
          Promise.resolve({
            selectedBackend: 'vulkan',
            packId: CPU.id,
            packBackend: 'cpu',
            degraded: true,
          }),
      }),
    });
    const item = r.results.find((x) => x.id === 'backend.selection');
    assert.equal(item?.status, 'warn');
    assert.equal((item?.remediation ?? '').length > 0, true, '退档了却没有下一步可做');
  });

  it('探针没接 → 这一项仍然出现，如实说"未探测"（少一项和"通过了"长得一样）', async () => {
    const r = await runSelfCheck({ ...BASE, probes: baseProbes() });
    const item = r.results.find((x) => x.id === 'backend.selection');
    assert.equal(item?.detail.includes('未探测'), true, item?.detail ?? '(缺项)');
  });
});
