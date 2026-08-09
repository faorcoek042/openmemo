/**
 * ★ 「点错了卡片」时，自检要说人话、并且指向真的能解决问题的地方。
 *
 * ## 起因（`[用户实测 :10000]` 2026-08-09）
 *
 * 用户点了 **`libsimple-linux-x64`**（一个 SQLite 中文分词扩展）卡片上的「自检」，
 * 得到：
 *
 * > 自检无法运行，缺少：whisper-cli。**已安装的 libsimple-linux-x64 包里没有 whisper-cli** ——
 * > 不会拿别的包的二进制去跑再把结果记到它头上（那是发明证据）。
 *
 * 他的反应是「为什么连开发环境都没有 whisper？是不是我配置改错了？」——
 * **他读得对**：那句话的主语位置上站着 `libsimple-linux-x64`，读起来就是
 * "这个包该带 whisper-cli 却没带"。
 *
 * `[协调者实跑核实]` 环境什么都不缺：
 * `POST /api/backends/selftest {"packId":"whispercpp-cpu-linux-x64"}`
 * → `passed:true`、`transcriptSimilarity:1`、11 秒音频 0.59 秒转完（约 19 倍实时）。
 * **什么都没坏。** 坏的是这条消息的主语，和它给的那个"去安装后端包"——
 * whisper 已经装了，照着做会发现**无事可做**。
 *
 * ## 这里**没有**放宽什么
 *
 * ADR-003 决策 3（缺前提只报 blocked、绝不返回伪造的"通过"）一个字没动：
 * 下面第一条就钉着"仍然是 blocked、仍然不拿别的包的二进制冒充"。
 * 被改的只有**措辞的主语**和**引导的去处**。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────────────
 * 任何人把 `requestedPackId` 挪回主语位置；或者在 whisper 已装于他包时
 * 仍旧给出 `install_backend`（= 让用户去装一个已经装了的东西）；
 * 或者反过来，为了"消息好看"在真的什么都没装时也把 remediation 抹成 null。
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runBackendSelfTest } from './setup.js';

/* 残留环境变量会让下面每一条"碰巧绿"（PROTOCOL §9-bis）。 */
for (const k of [
  'OPENMEMO_PROBE',
  'OPENMEMO_BACKEND_DIR',
  'OPENMEMO_MODELS',
  'OPENMEMO_WHISPER_CLI',
  'OPENMEMO_ASR_MODEL',
  'OPENMEMO_SELFTEST_AUDIO',
]) {
  delete process.env[k];
}

const whisperCliName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

/**
 * 装一个后端包：解包目录 + 安装记录。
 *
 * **两样都要**：`resolveBackendTool()` 靠 `manifests/backend/*.json` 才知道
 * 某个目录属于哪个 packId。只造目录不造记录，`packId` 会是 undefined，
 * 于是"whisper 装在哪个包里"这个问题**测不出来** —— 夹具比现实友善的老毛病。
 */
async function installPack(
  modelsDir: string,
  opts: { packId: string; dirName: string; engine: string; files: string[] },
): Promise<void> {
  const packDir = join(modelsDir, 'by-name', 'backend', opts.dirName);
  await mkdir(packDir, { recursive: true });
  for (const f of opts.files) {
    const p = join(packDir, f);
    await writeFile(p, 'fake');
    // 可执行位必须真的置上：发现函数用的是 access(X_OK)
    if (!/\.(so|dylib|dll)(\.\d+)*$/i.test(f)) await chmod(p, 0o755);
  }
  const manifestDir = join(modelsDir, 'manifests', 'backend');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, `${opts.packId}.json`),
    JSON.stringify({
      id: opts.packId,
      backend: 'cpu',
      engine: opts.engine,
      priority: 10,
      files: [{ name: `${opts.dirName}.zip` }],
    }),
  );
}

async function freshDataDir(tag: string): Promise<{ dataDir: string; modelsDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), `om-wrongcard-${tag}-`));
  const modelsDir = join(dataDir, 'models');
  await mkdir(modelsDir, { recursive: true });
  /*
   * ★ ASR 模型必须真的摆上。
   *
   * 第一版夹具没有它，于是 `missing` 里多了 `asr-model`，
   * remediation 走的是"去安装 ASR 模型"那条分支 —— **根本没测到本轮改的那一段**。
   * 而用户实际撞到的那次消息里只有「缺少：whisper-cli」，说明他的模型是装好的。
   * 夹具不复现现场，测的就是另一件事。
   */
  await writeFile(join(modelsDir, 'ggml-tiny.en.bin'), 'fake-model');
  return { dataDir, modelsDir };
}

/** whisper 装在 A 包，用户点的是 B 包（分词扩展）的自检。 */
async function twoPacks(tag: string) {
  const { dataDir, modelsDir } = await freshDataDir(tag);
  await installPack(modelsDir, {
    packId: 'whispercpp-cpu-linux-x64',
    dirName: 'whisper-bin-ubuntu-x64',
    engine: 'whisper.cpp',
    files: [whisperCliName],
  });
  await installPack(modelsDir, {
    packId: 'libsimple-linux-x64',
    dirName: 'libsimple-linux-ubuntu-22.04',
    engine: 'sqlite-ext',
    files: ['libsimple.so'],
  });
  return { dataDir, modelsDir };
}

describe('★ 自检「点错了卡片」：措辞的主语，与引导的去处', () => {
  it('仍然 blocked，仍然不拿别的包的二进制冒充（ADR-003 决策 3 没被削）', async () => {
    const { dataDir, modelsDir } = await twoPacks('adr');
    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: 'libsimple-linux-x64' });

    assert.equal(r.status, 'blocked', 'whisper 装在别的包里，就不许拿它给 libsimple 记一次通过');
    if (r.status !== 'blocked') return;
    assert.equal(r.missing.includes('whisper-cli'), true);
    assert.equal(r.resolved.whisperCli, null, '钉住 packId 的硬过滤被绕过了');
  });

  it('★ 主语必须是行为方，不能是用户点的那个包', async () => {
    const { dataDir, modelsDir } = await twoPacks('subject');
    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: 'libsimple-linux-x64' });
    if (r.status !== 'blocked') return assert.fail('应为 blocked');

    assert.equal(
      /已安装的\s*libsimple-linux-x64\s*包里没有/.test(r.messageZh),
      false,
      `包名又回到了主语位置，用户会读成"libsimple 该带 whisper 却没带" → ${r.messageZh}`,
    );
    assert.ok(
      r.messageZh.includes('不会用别的包里的'),
      `没有以行为方作主语说明"我拒绝做什么" → ${r.messageZh}`,
    );
  });

  it('★ whisper 已装在别处时，消息要说出它在哪张卡片上', async () => {
    const { dataDir, modelsDir } = await twoPacks('where');
    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: 'libsimple-linux-x64' });
    if (r.status !== 'blocked') return assert.fail('应为 blocked');

    assert.ok(
      r.messageZh.includes('whispercpp-cpu-linux-x64'),
      `whisper 明明装着，消息却没告诉用户去哪张卡片上点 → ${r.messageZh}`,
    );
  });

  it('★ 不许给「去安装后端包」—— 它已经装了，照做无事可做', async () => {
    const { dataDir, modelsDir } = await twoPacks('remediation');
    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: 'libsimple-linux-x64' });
    if (r.status !== 'blocked') return assert.fail('应为 blocked');

    assert.equal(
      r.remediation,
      null,
      `whisper 已装，却仍旧引导"去安装后端包"：${JSON.stringify(r.remediation)}`,
    );
  });

  /**
   * 反向：**真的**一个后端包都没有时，`install_backend` 必须还在。
   * 否则"把 remediation 一律抹成 null"也能让上面那条变绿 —— 那是把引导削没了，
   * 不是把引导修对了。
   */
  it('★ 反向：真的什么都没装时，「去安装后端包」必须还在', async () => {
    const { dataDir, modelsDir } = await freshDataDir('nothing');
    await installPack(modelsDir, {
      packId: 'libsimple-linux-x64',
      dirName: 'libsimple-linux-ubuntu-22.04',
      engine: 'sqlite-ext',
      files: ['libsimple.so'],
    });
    const r = await runBackendSelfTest({ dataDir, modelsDir, packId: 'libsimple-linux-x64' });
    if (r.status !== 'blocked') return assert.fail('应为 blocked');

    assert.equal(
      r.remediation?.action,
      'install_backend',
      '一个引擎包都没装，这时"去安装后端包"是真能解决问题的，不许一起削掉',
    );
    assert.equal(
      r.messageZh.includes('要跑自检，请到那张卡片上点'),
      false,
      `whisper 根本没装，却告诉用户"去那张卡片上点" → ${r.messageZh}`,
    );
  });
});
