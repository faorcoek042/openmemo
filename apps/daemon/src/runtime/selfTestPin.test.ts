/**
 * T-166 ① —— **「自测这一个包」现在真的做得到**。
 *
 * ## 缺陷原状
 *
 * `POST /api/backends/selftest` 的请求体里一直带着 `{id}`（前端每张后端包卡片上的
 * 「自测」按钮都发自己的包 id），而 `runBackendSelfTest()` **从头到尾没看过它**：
 * 它只按统一的选择规则解析出"当前该用的那套 whisper-cli"然后跑。
 *
 * 于是装了 CPU 与 Vulkan 两个包的用户：
 *   · 在 Vulkan 卡片上点自测 → 跑的可能是 CPU 包的二进制；
 *   · 另一张卡片上的按钮**点了等于测了别人**，而界面上完全看不出来。
 *
 * ggml 只从**二进制自身所在目录**里 dlopen 后端库，所以"哪个包的 whisper-cli"
 * 就等于"哪套后端库"——「测哪个包」这件事只能靠钉住二进制来表达，没有第二条路。
 *
 * ## 判据：**钉住之后必须要么跑那个包、要么明说跑不了**
 *
 * 「回退到别的包再把结果记到用户点的那张卡片上」是这一族里最贵的一种错，
 * 比"少一个功能"坏得多 —— 它发明的是一条**不成立的证据**。
 * 所以这里既验正向（钉住 → 解析到那个包的二进制），也验反向（那个包里没有 →
 * blocked，且 `resolved.whisperCli` 为 null，绝不指向另一个包）。
 *
 * ⚠️ **本文件一次推理都不跑**（用户禁止本机跑 whisper 转写）：
 * 夹具里没有 ASR 模型，所以自检必然停在 `blocked`，而我们要验的
 * "whisper-cli 解析到了谁" 恰恰**在跑之前**就已经定下来，`resolved` 里如实带着。
 */
import { tmpdir } from 'node:os';

/*
 * ⚠️ PROTOCOL §9-bis：环境在**模块顶层**清干净，窗口为零，不写清理代码。
 * `resolveRuntimeLayout()` 会读 `OPENMEMO_MODELS`，不清掉它就会去翻这台机器上
 * 真实的模型目录 —— 那既污染判据，也是一次越界。
 */
delete process.env['OPENMEMO_MODELS'];
delete process.env['OPENMEMO_WHISPER_CLI'];
delete process.env['OPENMEMO_ASR_MODEL'];
delete process.env['OPENMEMO_PROBE'];
delete process.env['OPENMEMO_BACKEND_DIR'];

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runBackendSelfTest } from './setup.js';

/** 造一个已装后端包：解包目录 + 安装记录（形状与 `startPackInstall()` 写出来的一致）。 */
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
    // 只是一个壳，**永远不会被执行到**：夹具里没有 ASR 模型，自检停在 blocked。
    await writeFile(cli, '#!/bin/sh\nexit 0\n');
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
  priority: 80,
} as const;

async function freshStore(tag: string): Promise<{ dataDir: string; modelsDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), `om-selftestpin-${tag}-`));
  const modelsDir = join(dataDir, 'models');
  await mkdir(join(modelsDir, 'by-name', 'backend'), { recursive: true });
  await mkdir(join(modelsDir, 'manifests', 'backend'), { recursive: true });
  return { dataDir, modelsDir };
}

describe('自检可以钉住某一个后端包（T-166 ①）', () => {
  it('★ 同一份磁盘布局：点 CPU 卡片测 CPU 包，点 Vulkan 卡片测 Vulkan 包', async () => {
    const { dataDir, modelsDir } = await freshStore('both');
    const cpuCli = await seedPack(modelsDir, { ...CPU, withCli: true });
    const vulkanCli = await seedPack(modelsDir, { ...VULKAN, withCli: true });

    /*
     * 判据形状与 T-162 同：**同一份布局、只改输入，两次必须给出不同的答案**。
     * 一条只断言"能找到一个"的用例，在"永远返回同一个"的实现上照样绿。
     */
    const askCpu = await runBackendSelfTest({ dataDir, modelsDir, packId: CPU.id });
    const askVulkan = await runBackendSelfTest({ dataDir, modelsDir, packId: VULKAN.id });

    assert.equal(askCpu.resolved.whisperCli, cpuCli);
    assert.equal(askVulkan.resolved.whisperCli, vulkanCli);
    assert.notEqual(
      askCpu.resolved.whisperCli,
      askVulkan.resolved.whisperCli,
      '两张卡片点出来跑的是同一个二进制 —— 「自测这一个包」并没有做到',
    );

    // 两次都停在 blocked（没有 ASR 模型），这正是"没跑推理"的证据
    assert.equal(askCpu.status, 'blocked');
    assert.equal(askVulkan.status, 'blocked');
    assert.equal(askCpu.status === 'blocked' && askCpu.missing.includes('whisper-cli'), false);
    assert.equal(askCpu.status === 'blocked' && askCpu.missing.includes('asr-model'), true);
  });

  it('★ 钉住的包里没有 whisper-cli → blocked，**绝不回退到另一个包**', async () => {
    const { dataDir, modelsDir } = await freshStore('missing');
    const cpuCli = await seedPack(modelsDir, { ...CPU, withCli: true });
    await seedPack(modelsDir, { ...VULKAN, withCli: false }); // 装到一半：目录在、二进制不在

    // 阳性对照：不钉的话确实找得到一个（否则下面那条"找不到"没有分辨力）
    const unpinned = await runBackendSelfTest({ dataDir, modelsDir });
    assert.equal(unpinned.resolved.whisperCli, cpuCli, '不钉住时本该退回 CPU 包');

    const pinned = await runBackendSelfTest({ dataDir, modelsDir, packId: VULKAN.id });
    assert.equal(
      pinned.resolved.whisperCli,
      null,
      `钉住 ${VULKAN.id} 却解析到了 ${String(pinned.resolved.whisperCli)} —— ` +
        '拿别的包的二进制去跑，再把结果记到这张卡片上，就是发明一条不成立的证据',
    );
    assert.equal(pinned.status, 'blocked');
    assert.equal(pinned.status === 'blocked' && pinned.missing.includes('whisper-cli'), true);
    // 拒绝的理由必须点名那个包，否则用户只看到一句"缺 whisper-cli"，会以为整机都坏了
    assert.equal(
      pinned.status === 'blocked' && pinned.messageZh.includes(VULKAN.id),
      true,
      `blocked 的中文说明没点名是哪个包：${pinned.status === 'blocked' ? pinned.messageZh : ''}`,
    );
  });

  it('★ 跑完之后说得出"这次是哪个包"—— 认领依据是结构，不是日志文字', async () => {
    /*
     * `packId` 是 `recordSelfTest()` 唯一合法的认领依据。它必须来自
     * `resolveBackendTool()` 的目录反查，而不是从 whisper 的 stderr 里解析出来的
     * `backendUsed`（那是日志文字，与 Backend 枚举永不相等 —— 见
     * `http/rest/selfTestRecord.test.ts` 里那条护栏）。
     *
     * 这里验的是"钉住的那次，包 id 被如实带了回来"。
     */
    const { dataDir, modelsDir } = await freshStore('claim');
    await seedPack(modelsDir, { ...CPU, withCli: true });
    await seedPack(modelsDir, { ...VULKAN, withCli: true });

    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: VULKAN.id });
    assert.equal(r.requestedPackId, VULKAN.id);
    // blocked 分支上还没有 packId（还没跑），但请求点名的那个必须原样带回来
    assert.equal(r.status, 'blocked');
  });

  it('★ 钉住时 `bin/runtime` 里的手工布局也不许赢 —— 它不属于任何包', async () => {
    /*
     * 不钉住时 `bin/runtime` 排在包前面（T-160 留下的正式布局位置，开发/自检覆盖用）。
     * 钉住时不行：那个二进制**不属于任何已安装包**，拿它去跑，
     * 认领就只能落空（`packId` 为 null），用户点了自测却什么都记不下来 ——
     * 而他看到的是"跑了"。同一条判据也管 `OPENMEMO_WHISPER_CLI`。
     *
     * ⚠️ 这条是反向验证逼出来的：M6（"钉住时也走 firstExistingFile"）第一轮**存活**。
     * 追下去发现在原来的夹具里它是**等价变异** —— `bin/runtime` 空、环境变量已清，
     * 于是 else 分支算出来的东西和 then 分支逐字相同。
     * 「一条存活的变异不一定说明测试不够，也可能说明那条变异什么都没改。」
     * 补上这个夹具之后它才有分辨力。
     */
    const { dataDir, modelsDir } = await freshStore('binruntime');
    const packCli = await seedPack(modelsDir, { ...CPU, withCli: true });
    const manual = join(dataDir, 'bin', 'runtime', 'whisper-cli');
    await mkdir(join(dataDir, 'bin', 'runtime'), { recursive: true });
    await writeFile(manual, '#!/bin/sh\nexit 0\n');
    await chmod(manual, 0o755);

    // 阳性对照：不钉住时 `bin/runtime` 确实排在前面（否则下面那条没有分辨力）
    const unpinned = await runBackendSelfTest({ dataDir, modelsDir });
    assert.equal(unpinned.resolved.whisperCli, manual, '阳性对照不成立：bin/runtime 本该优先');

    const pinned = await runBackendSelfTest({ dataDir, modelsDir, packId: CPU.id });
    assert.equal(
      pinned.resolved.whisperCli,
      packCli,
      `钉住 ${CPU.id} 却跑了 ${String(pinned.resolved.whisperCli)} —— ` +
        '那个二进制不属于任何包，结果认领不了，用户点完自测什么都记不下来',
    );
  });

  it('★ 自检的 ASR 模型不许挑中 VAD 权重 —— 它是 by-name/asr 里最小的那个', async () => {
    /*
     * 老布局（T-149 之前）的机器上，`ggml-silero-*.bin` 就躺在 `by-name/asr/`，
     * 而它约 1 MB、whisper base 约 140 MB —— "按体积升序取第一个"会**稳定**挑中它。
     * whisper 拿 VAD 网络去转写 → `bad magic` → `passed:false`。
     *
     * 这条以前撞不上，因为自检结果从来没落过库；T-166 把回写接通之后，
     * 它会变成一张好包卡片上**持续**的"自检失败"。
     * → 「把一个东西从『没有』变成『有』，会让所有拿它的缺席当前提的地方失去意义。」
     */
    const { dataDir, modelsDir } = await freshStore('vadasasr');
    await seedPack(modelsDir, { ...CPU, withCli: true });
    const asrDir = join(modelsDir, 'by-name', 'asr');
    await mkdir(asrDir, { recursive: true });
    // 小的那个是 VAD，大的那个才是真 ASR —— 顺序刻意与"按体积升序"相反
    await writeFile(join(asrDir, 'ggml-silero-v6.2.0.bin'), Buffer.alloc(1024));
    await writeFile(join(asrDir, 'ggml-base.en.bin'), Buffer.alloc(64 * 1024));

    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: CPU.id });
    assert.equal(
      r.resolved.model,
      join(asrDir, 'ggml-base.en.bin'),
      `自检挑了 ${String(r.resolved.model)} 当 ASR 模型 —— ` +
        'VAD 权重是这个桶里最小的，挑中它会让一个好包永久显示"自检失败"',
    );
  });

  it('不钉住时行为**一个字不变**：仍按统一规则（priority 高的赢）', async () => {
    /*
     * 阴性对照。新增一个可选参数最容易犯的错是"顺手改了默认路径"——
     * `GET /api/selfcheck` 与 CLI 自检都走不钉住这条，它们必须与 T-162 完全一致。
     */
    const { dataDir, modelsDir } = await freshStore('default');
    await seedPack(modelsDir, { ...CPU, withCli: true });
    const vulkanCli = await seedPack(modelsDir, { ...VULKAN, withCli: true });

    const r = await runBackendSelfTest({ dataDir, modelsDir });
    assert.equal(
      r.resolved.whisperCli,
      vulkanCli,
      '没选过后端时该按 priority 降序取 vulkan(80) —— 默认路径被这次改动带偏了',
    );
    assert.equal(r.requestedPackId, null);
  });
});
