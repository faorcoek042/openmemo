/**
 * T-166 —— **`meta.sameSource: model.vad 本地=warn 端点=ok`**（`runner-migrate` CI 实测）。
 *
 * ## 缺陷原状
 *
 * T-149（`9ab2ada`）把 `role=vad` 挪进了自己的桶：安装器从此写
 * `by-name/vad/ggml-silero-*.bin`，而不再是 `by-name/asr/`。
 *
 * 迁移**只改了一边**：
 *   · `apps/daemon` 的 `resolveWhisperVadModel()` 跟上了（两个桶都看）；
 *   · `packages/pipeline` 的 `discoverTools()` **没有** —— 它按三个写死的文件名
 *     只翻 `by-name/asr/`。
 *
 * 两个自检出口因此给出两个答案：daemon 端点读 `bundle.tools.vadModel`
 * （被 `resolveWhisperVadModel()` 覆盖过 → ok），CLI 直接用 `discoverTools()`
 * 的答案（→ warn）。三平台一模一样，而 macOS / Windows 的目录里根本没有 Vulkan 包
 * —— 所以这一条单独就定性了：**不是加速包那轮引入的**。
 *
 * ## 用户侧后果不在自检里，在转写上
 *
 * `ToolPaths.vadModel` 从有值变成 `null` → **离线转写的静音切分静默降级为固定窗口**，
 * 断句变差；而模型页显示已安装、安装记录在、sha256 校验通过 —— **全绿**。
 * 这正是本仓最贵的那一类：每一层都不报错，只有效果消失。
 *
 * ## 判据：钉**两个出口的结论必须相等**，不是各钉各的
 *
 * 分别断言"这边找得到"和"那边找得到"是不够的 —— 那正是分叉能活下来的原因：
 * 两边各自都对着自己的实现绿着。所以每个场景都拿**同一个 store**问两次，
 * 断言两个答案逐字相同。这条断言就是 `meta.sameSource` 的离线版本，
 * 它不需要一台跑着的 daemon 就能在 CI 上红。
 */
import { tmpdir } from 'node:os';

/* ⚠️ PROTOCOL §9-bis：模块顶层清干净，窗口为零，不写清理代码。 */
delete process.env['OPENMEMO_MODELS'];
delete process.env['OPENMEMO_VAD_MODEL'];
delete process.env['OPENMEMO_WHISPER_CLI'];
delete process.env['OPENMEMO_ASR_MODEL'];

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { GGML_FILE_MAGIC } from '@openmemo/downloader';
import { discoverTools } from '@openmemo/pipeline';

import { resolveWhisperVadModel } from './setup.js';

/**
 * ggml 文件的魔数 —— `isGgmlModelFile()` 读的就是这四个字节，whisper 也是。
 *
 * ⚠️ 必须按 **UInt32LE** 写，不能手写 `'ggml'` 的 ASCII：`GGML_FILE_MAGIC`
 * 是 `0x67676d6c`，小端落盘就是 `6c 6d 67 67`。我第一版写成了 `67 67 6d 6c`，
 * 于是**两个出口都返回 null，用例"红得很整齐"**——差点被读成"这两边确实一致"。
 * 常量从产出方 import，不在这里再写一遍。
 */
const MAGIC_LE = ((): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return b;
})();

async function freshStore(tag: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `om-vadsame-${tag}-`));
  await mkdir(join(root, 'by-name', 'backend'), { recursive: true });
  await mkdir(join(root, 'manifests', 'asr'), { recursive: true });
  return root;
}

async function putWeights(
  root: string,
  bucket: string,
  name: string,
  ggml: boolean,
): Promise<string> {
  const dir = bucket === '' ? root : join(root, 'by-name', bucket);
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, ggml ? Buffer.concat([MAGIC_LE, Buffer.alloc(64)]) : Buffer.alloc(68, 1));
  return p;
}

/** 两个出口对同一个 store 各问一次。**返回的是一对，不是一个** —— 判据是它们相等。 */
async function bothExits(root: string): Promise<{ cli: string | null; daemon: string | null }> {
  // CLI 出口：`scripts/selfcheck.mjs` 就是这么问的（`pl.discoverTools({storeRoot})`）
  const cli = (await discoverTools({ storeRoot: root })).vadModel;
  // daemon 出口：`buildPipeline()` 用它覆盖 `discoverTools()` 的答案
  const daemon = (await resolveWhisperVadModel(root, {})).path;
  return { cli, daemon };
}

describe('VAD 权重解析：两个自检出口必须给同一个答案（meta.sameSource）', () => {
  it('★ T-149 之后的正式位置 `by-name/vad/` —— 缺陷原状下 CLI 那边是 null', async () => {
    const root = await freshStore('vadbucket');
    const weights = await putWeights(root, 'vad', 'ggml-silero-v6.2.0.bin', true);

    const { cli, daemon } = await bothExits(root);
    assert.equal(daemon, weights, 'daemon 侧就没找到 —— 夹具本身有问题，下面的比较没有意义');
    assert.equal(
      cli,
      daemon,
      `两个出口给了不同答案：CLI=${String(cli)} / daemon=${String(daemon)} —— ` +
        '这就是 `model.vad 本地=warn 端点=ok`，用户侧是静音切分静默退回固定窗口',
    );
  });

  it('老布局 `by-name/asr/` 里的 VAD 照样两边都找得到（迁移前装的机器）', async () => {
    const root = await freshStore('asrbucket');
    const weights = await putWeights(root, 'asr', 'ggml-silero-v5.1.2.bin', true);

    const { cli, daemon } = await bothExits(root);
    assert.equal(daemon, weights);
    assert.equal(cli, daemon, `CLI=${String(cli)} / daemon=${String(daemon)}`);
  });

  it('★ 上游发一个新版本号也不许把任何一边打哑（判据是后缀+关键词+魔数，不是文件名清单）', async () => {
    /*
     * 这条钉的是**分叉的成因**，不是症状。
     * 原来 CLI 那侧的名单是 `v6.2.0 / v5.1.2 / silero-vad.bin` 三个字面量，
     * daemon 那侧是"`*.bin` 且含 silero"。只把桶名改对、名单留着的话，
     * 上游发 `v7` 时会**再分叉一次**，而且仍然只有 CLI 那一侧哑掉。
     */
    const root = await freshStore('newver');
    const weights = await putWeights(root, 'vad', 'ggml-silero-v7.0.0.bin', true);

    const { cli, daemon } = await bothExits(root);
    assert.equal(daemon, weights);
    assert.equal(cli, weights, '文件名清单又回来了 —— 下一个上游版本会再次只打哑一边');
  });

  it('★ sherpa 专用的 onnx 两边都必须拒绝（T-148：喂给 whisper.cpp 会整单转写死掉）', async () => {
    const root = await freshStore('onnx');
    // 名字里带 silero，但内容不是 ggml —— 关键词能命中，魔数不能
    await putWeights(root, 'vad', 'silero_vad.onnx', false);
    await putWeights(root, 'vad', 'silero-vad-broken.bin', false);

    const { cli, daemon } = await bothExits(root);
    assert.equal(daemon, null, 'daemon 把一个 whisper.cpp 加载不了的文件交了出去');
    assert.equal(cli, null, 'CLI 把一个 whisper.cpp 加载不了的文件交了出去');
  });

  it('两个桶里都有时，两边挑的是**同一个**（不是各挑各的）', async () => {
    const root = await freshStore('bothbuckets');
    const newer = await putWeights(root, 'vad', 'ggml-silero-v6.2.0.bin', true);
    await putWeights(root, 'asr', 'ggml-silero-v5.1.2.bin', true);

    const { cli, daemon } = await bothExits(root);
    assert.equal(daemon, newer, '正式桶应当赢过老布局那一份');
    assert.equal(cli, daemon, `CLI=${String(cli)} / daemon=${String(daemon)}`);
  });

  it('什么都没装：两边都是 null（阴性对照 —— 否则上面几条可能只是恒真）', async () => {
    const root = await freshStore('empty');
    const { cli, daemon } = await bothExits(root);
    assert.equal(cli, null);
    assert.equal(daemon, null);
  });
});
