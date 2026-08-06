/**
 * T-160 ②-③：**安装器写的目录，和 runtime 读的目录，不是同一个。**
 *
 * `[本机实测]` live `GET /api/runtime/hardware` → `backendDirExists: false`，
 * 而 `whispercpp-cpu-linux-x64` **已装、`integrity: "ok"`**。两边各写各的：
 *
 * ```
 * 安装器落点   <modelsRoot>/by-name/backend/<archive>/…    （backends.json 的包没有 linkInto）
 * runtime 只搜 <dataDir>/bin/runtime                        （空目录）
 * ```
 *
 * 后果不是"装不上"，是**装上了、每一层都报绿、加速功能静默缺席**：
 *   · probe 永远 `missing_probe` → 硬件检测永远"未探测" → L2 加速包永远不可装；
 *   · 自检永远 `blocked: missing whisper-cli` → `selfTest` 恒为 null →
 *     「自检结果」「anyFailed 横幅」三条 UI 分支永远不会亮。
 *
 * 与 T-093（网页装好中文分词器、搜索仍是 trigram 降级、零报错）同一个形状。
 *
 * 这些用例钉的是**"从安装器真正写下的位置能不能找到它"**，不是某个路径字符串。
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveRuntimeLayout, runBackendSelfTest } from './setup.js';

/* 模块顶层清环境：任何一个残留都会让下面的用例"碰巧绿"（PROTOCOL §9-bis）。 */
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

const probeName = process.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe';
const whisperCliName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const ggmlLibName =
  process.platform === 'win32'
    ? 'ggml-cpu.dll'
    : process.platform === 'darwin'
      ? 'libggml-base.0.15.1.dylib'
      : 'libggml-cpu.so';

/**
 * 造一个和安装器解包结果同形状的后端包目录。
 *
 * 可执行位**必须真的置上**：`findInBackendPacks()`（流水线那份唯一的发现函数）
 * 用的是 `access(X_OK)`，而安装器也确实会 chmod 0755。夹具少这一步就会
 * "测试里找不到、产品里找得到"，那种夹具比没有更坏。
 */
async function fakeBackendPack(dataDir: string, files: string[]): Promise<string> {
  // upstream tarball 自带一层顶层目录 —— 解包后就是这个形状
  const packDir = join(dataDir, 'models', 'by-name', 'backend', 'whisper-bin-ubuntu-x64');
  await mkdir(packDir, { recursive: true });
  for (const f of files) {
    const p = join(packDir, f);
    await writeFile(p, 'fake');
    if (!/\.(so|dylib|dll)(\.\d+)*$/i.test(f)) await chmod(p, 0o755);
  }
  return packDir;
}

async function freshDataDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `om-layout-${tag}-`));
  await mkdir(join(dir, 'models'), { recursive: true });
  return dir;
}

describe('runtime 布局解析：读安装器真正写下的位置', () => {
  it('什么都没装时，老实说没有（不许编一个存在的路径）', async () => {
    const dataDir = await freshDataDir('empty');
    const layout = await resolveRuntimeLayout({ dataDir, modelsDir: join(dataDir, 'models') });

    assert.equal(layout.probeExists, false);
    assert.equal(layout.backendDirExists, false);
    // 路径本身仍然要给出来 —— UI 要把"它本该在哪"显示给用户
    assert.match(layout.probePath, /bin[/\\]runtime/);
  });

  it('★ CPU 后端包已装（只有 ggml 库、还没有 probe）→ backendDir 必须指到它', async () => {
    const dataDir = await freshDataDir('ggml');
    const packDir = await fakeBackendPack(dataDir, [whisperCliName, ggmlLibName]);

    const layout = await resolveRuntimeLayout({ dataDir, modelsDir: join(dataDir, 'models') });

    assert.equal(
      layout.backendDir,
      packDir,
      'ggml 库就在这个目录里，backendDir 却指着空的 bin/runtime —— 这正是 live 上 backendDirExists:false 的成因',
    );
    assert.equal(layout.backendDirExists, true);
    // probe 确实还没有分发通道，这一条必须**保持诚实**：没有就是没有
    assert.equal(layout.probeExists, false);
  });

  it('★ probe 随后端包分发时，从 by-name/backend 里也能找到，且 backendDir 跟着它走', async () => {
    const dataDir = await freshDataDir('probe');
    const packDir = await fakeBackendPack(dataDir, [probeName, whisperCliName, ggmlLibName]);

    const layout = await resolveRuntimeLayout({ dataDir, modelsDir: join(dataDir, 'models') });

    assert.equal(layout.probePath, join(packDir, probeName));
    assert.equal(layout.probeExists, true);
    // ggml 从**二进制自身所在目录** dlopen，所以 backendDir 必须是 probe 的同级目录
    assert.equal(layout.backendDir, packDir);
    assert.equal(layout.backendDirExists, true);
  });

  it('环境变量仍然是覆盖手段（开发/自检用），且优先级最高', async () => {
    const dataDir = await freshDataDir('env');
    await fakeBackendPack(dataDir, [probeName, ggmlLibName]);
    process.env['OPENMEMO_BACKEND_DIR'] = dataDir;
    try {
      const layout = await resolveRuntimeLayout({ dataDir, modelsDir: join(dataDir, 'models') });
      assert.equal(layout.backendDir, dataDir);
    } finally {
      delete process.env['OPENMEMO_BACKEND_DIR'];
    }
  });

  it('★ 自检不再因为"找不到 whisper-cli"而恒 blocked（selfTest 恒 null 的一半成因）', async () => {
    const dataDir = await freshDataDir('selftest');
    await fakeBackendPack(dataDir, [whisperCliName, ggmlLibName]);

    const r = await runBackendSelfTest({ dataDir, modelsDir: join(dataDir, 'models') });

    /*
     * 这里**必然**仍是 blocked：没装 ASR 模型。要钉的是**缺的是哪一件**——
     * 修复前 `missing` 里有 `whisper-cli`（引擎明明已经装好了），
     * 修复后只剩 `asr-model`（那是用户真的还没做的事，而且给得出补救动作）。
     * 顺带：模型缺席也保证了这条用例**不会真的跑一次推理**。
     */
    assert.equal(r.status, 'blocked');
    if (r.status !== 'blocked') return;
    assert.equal(
      r.missing.includes('whisper-cli'),
      false,
      `引擎二进制已装在 by-name/backend 里，自检却说它没装：${r.missing.join(', ')}`,
    );
    assert.equal(r.missing.includes('asr-model'), true);
    assert.equal(r.remediation.action, 'install_model');
  });
});
